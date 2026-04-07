import type {
  ArtifactRef,
  BranchRecord,
  BuildTaskPayload,
  EvaluationDecisionRecord,
  EvaluateTaskPayload,
  ExperimentRunRecord,
  ExperimentSpecInput,
  ExperimentSpecRecord,
  ExperimentTaskPayload,
  FindingRecord,
  MetricRecord,
  ObjectiveCreateInput,
  ObjectiveRecord,
  PlanStepProposal,
  PromotionRecord,
  PromoteTaskPayload,
  RunBudget,
  RunBudgetUsage,
  RunRecord,
  SourceAddInput,
  SourceRecord,
  StatusSnapshot,
  TaskDependency,
  TaskOutcome,
  TaskPayload,
  TaskRecord,
  WorkerRunRecord,
  WorktreeLeaseRecord
} from "../../shared/types";
import { ArtifactStore } from "./artifact-store";
import { bucketForTask, executorForTask, PolicyEngine, isBranchSchedulable } from "./policy-engine";
import { SourceIngest } from "./source-ingest";
import { type ProjectionMutation, ResearchStore } from "./store";
import { createId, nowIso, roundScore } from "./utils";
import { WorkerLeaseManager } from "./worker-lease-manager";

type InterruptMode = "pause" | "stop";

type InterruptibleTaskHandle = {
  task: TaskRecord;
  run: RunRecord;
  workerRun: WorkerRunRecord;
  branch?: BranchRecord | null;
  lease?: WorktreeLeaseRecord;
};

export class RunManager {
  constructor(
    private readonly deps: {
      store: ResearchStore;
      policy: PolicyEngine;
      sourceIngest: SourceIngest;
      leaseManager: WorkerLeaseManager;
      artifactStore: ArtifactStore;
    }
  ) {}

  createObjective(workspacePath: string, input: ObjectiveCreateInput) {
    const now = nowIso();
    const objective: ObjectiveRecord = {
      id: createId("obj"),
      title: input.title?.trim() || summarizeObjective(input.objective),
      objective: input.objective.trim(),
      summary: input.objective.trim(),
      status: "draft",
      successCriteria: input.successCriteria?.filter(Boolean) ?? [],
      branchIds: [],
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind: "objective",
        value: objective
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "objective.created",
          objectiveId: objective.id,
          payload: {
            title: objective.title
          }
        })
      }
    ]);
    return objective;
  }

  listObjectives(workspacePath: string) {
    return this.deps.store.listProjections(workspacePath, "objective").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  showObjective(workspacePath: string, objectiveId?: string) {
    const projection = this.deps.store.getProjection(workspacePath);
    return resolveObjective(projection.objectives, objectiveId) ?? null;
  }

  async addSources(workspacePath: string, input: SourceAddInput) {
    const projection = this.deps.store.getProjection(workspacePath);
    const objective = resolveObjective(projection.objectives, input.objectiveId);
    if (!objective) {
      throw new Error("No objective exists. Create one first.");
    }
    const branch =
      (input.branchId ? projection.branches.find((entry) => entry.id === input.branchId) : null) ??
      projection.branches.find((entry) => entry.id === objective.activeBranchId) ??
      projection.branches.find((entry) => entry.objectiveId === objective.id && isBranchSchedulable(entry.status)) ??
      null;
    return await this.deps.sourceIngest.addInputs({
      workspacePath,
      objective,
      branch,
      inputs: input.inputs
    });
  }

  getStatusSnapshot(workspacePath: string, daemon: { running: boolean; pid?: number; socketPath: string }): StatusSnapshot {
    return this.deps.store.getStatusSnapshot(workspacePath, daemon);
  }

  resolveRunControl(workspacePath: string, input: { objectiveId?: string; runId?: string }) {
    const projection = this.deps.store.getProjection(workspacePath);
    const objective = resolveObjective(projection.objectives, input.objectiveId);
    const run =
      (input.runId ? projection.runs.find((entry) => entry.id === input.runId) : null) ??
      (objective ? projection.runs.find((entry) => entry.id === objective.activeRunId) : null) ??
      null;
    if (!run) {
      throw new Error("No run exists.");
    }
    return {
      objective: objective ?? projection.objectives.find((entry) => entry.id === run.objectiveId) ?? null,
      run
    };
  }

  startRun(workspacePath: string, objectiveId?: string) {
    const projection = this.deps.store.getProjection(workspacePath);
    const objective = resolveObjective(projection.objectives, objectiveId);
    if (!objective) {
      throw new Error("No objective exists. Create one first.");
    }

    const existing = projection.runs.find(
      (entry) =>
        entry.objectiveId === objective.id &&
        (entry.status === "active" || entry.status === "paused" || entry.status === "needs-human")
    );
    if (existing?.status === "active") {
      return existing;
    }
    if (existing?.status === "paused") {
      return this.resumeRun(workspacePath, objective.id, existing.id);
    }
    if (existing?.status === "needs-human") {
      throw new Error("The active run needs human attention. Stop it or resolve the blocking task before restarting.");
    }

    const seededBranch = this.ensurePrimaryBranch(workspacePath, objective);
    const now = nowIso();
    const run: RunRecord = {
      id: createId("run"),
      objectiveId: objective.id,
      status: "active",
      budget: defaultRunBudget(),
      budgetUsage: defaultBudgetUsage(now),
      activeTaskIds: [],
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      totalPausedMs: 0
    };
    this.deps.store.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind: "run",
        value: run
      },
      {
        type: "upsert",
        kind: "objective",
        value: {
          ...objective,
          status: "active",
          activeBranchId: seededBranch.id,
          activeRunId: run.id,
          branchIds: Array.from(new Set([...objective.branchIds, seededBranch.id])),
          updatedAt: now
        }
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "run.started",
          objectiveId: objective.id,
          runId: run.id,
          branchId: seededBranch.id,
          payload: {
            branchId: seededBranch.id
          }
        })
      }
    ]);
    this.enqueuePlanIfNeeded(workspacePath, run.id, objective.id);
    return run;
  }

  async pauseRun(
    workspacePath: string,
    objectiveId?: string,
    runId?: string,
    activeHandles: InterruptibleTaskHandle[] = []
  ) {
    const { run } = this.resolveRunControl(workspacePath, {
      objectiveId,
      runId
    });
    if (run.status !== "active" && run.status !== "pausing") {
      throw new Error("No active run exists.");
    }
    const pausedAt = nowIso();
    const pausingRun: RunRecord = {
      ...run,
      status: "pausing",
      stopReason: "Pausing run and draining active tasks.",
      updatedAt: pausedAt
    };
    this.deps.store.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind: "run",
        value: pausingRun
      }
    ]);

    for (const handle of activeHandles) {
      await this.interruptActiveTask(workspacePath, handle, "pause", "Paused by the user.");
    }

    const refreshed = this.deps.store.readProjection(workspacePath, "run", run.id) ?? pausingRun;
    const paused: RunRecord = {
      ...refreshed,
      status: "paused",
      stopReason: "Paused by the user.",
      pausedAt,
      activeTaskIds: [],
      updatedAt: pausedAt
    };
    this.deps.store.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind: "run",
        value: paused
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "run.paused",
          objectiveId: paused.objectiveId,
          runId: paused.id,
          payload: {
            activeTaskIds: []
          }
        })
      }
    ]);
    return paused;
  }

  resumeRun(workspacePath: string, objectiveId?: string, runId?: string) {
    const { objective, run } = this.resolveRunControl(workspacePath, {
      objectiveId,
      runId
    });
    if (run.status !== "paused") {
      return run;
    }
    const now = nowIso();
    const pausedDelta =
      run.pausedAt && Number.isFinite(new Date(run.pausedAt).getTime())
        ? Math.max(0, Date.now() - new Date(run.pausedAt).getTime())
        : 0;
    const resumed: RunRecord = {
      ...run,
      status: "active",
      stopReason: undefined,
      pausedAt: undefined,
      totalPausedMs: (run.totalPausedMs ?? 0) + pausedDelta,
      updatedAt: now
    };
    const mutations: ProjectionMutation[] = [
      {
        type: "upsert",
        kind: "run",
        value: resumed
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "run.resumed",
          objectiveId: resumed.objectiveId,
          runId: resumed.id,
          payload: {
            totalPausedMs: resumed.totalPausedMs ?? 0
          }
        })
      }
    ];
    if (objective) {
      mutations.push({
        type: "upsert",
        kind: "objective",
        value: {
          ...objective,
          status: "active",
          activeRunId: resumed.id,
          updatedAt: now
        }
      });
    }
    this.deps.store.applyMutations(workspacePath, mutations);
    this.enqueuePlanIfNeeded(workspacePath, resumed.id, objective?.id ?? resumed.objectiveId);
    return resumed;
  }

  async stopRun(
    workspacePath: string,
    objectiveId?: string,
    runId?: string,
    activeHandles: InterruptibleTaskHandle[] = []
  ) {
    const { run } = this.resolveRunControl(workspacePath, {
      objectiveId,
      runId
    });
    if (run.status === "stopped" || run.status === "completed") {
      return run;
    }
    const stoppingAt = nowIso();
    const stopping: RunRecord = {
      ...run,
      status: "stopping",
      stopReason: "Stopping run and interrupting active tasks.",
      updatedAt: stoppingAt
    };
    this.deps.store.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind: "run",
        value: stopping
      }
    ]);

    for (const handle of activeHandles) {
      await this.interruptActiveTask(workspacePath, handle, "stop", "Stopped by the user.");
    }

    const stoppedAt = nowIso();
    const stopped: RunRecord = {
      ...(this.deps.store.readProjection(workspacePath, "run", run.id) ?? stopping),
      status: "stopped",
      stopReason: "Stopped by the user.",
      activeTaskIds: [],
      updatedAt: stoppedAt,
      endedAt: stoppedAt
    };
    this.deps.store.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind: "run",
        value: stopped
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "run.stopped",
          objectiveId: stopped.objectiveId,
          runId: stopped.id,
          payload: {
            stoppedAt
          }
        })
      }
    ]);
    return stopped;
  }

  markTaskRunning(input: {
    workspacePath: string;
    run: RunRecord;
    task: TaskRecord;
    workerRun: WorkerRunRecord;
    lease?: WorktreeLeaseRecord;
  }) {
    const now = nowIso();
    const updatedTask: TaskRecord = {
      ...input.task,
      status: "running",
      attemptCount: input.task.attemptCount + 1,
      workerRunId: input.workerRun.id,
      recoveryAction: undefined,
      startedAt: now,
      updatedAt: now
    };
    const updatedRun = this.deps.policy.incrementBudget(
      {
        ...input.run,
        activeTaskIds: Array.from(new Set([...input.run.activeTaskIds, input.task.id])),
        updatedAt: now
      },
      input.task.kind
    );
    const operations: ProjectionMutation[] = [
      {
        type: "upsert",
        kind: "task",
        value: updatedTask
      },
      {
        type: "upsert",
        kind: "run",
        value: updatedRun
      },
      {
        type: "upsert",
        kind: "worker_run",
        value: input.workerRun
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "task.dispatched",
          objectiveId: updatedTask.objectiveId,
          branchId: updatedTask.branchId,
          runId: updatedTask.runId,
          taskId: updatedTask.id,
          payload: {
            workerRunId: input.workerRun.id,
            leaseId: input.lease?.id
          }
        })
      }
    ];
    if (input.lease) {
      operations.push({
        type: "upsert",
        kind: "lease",
        value: input.lease
      });
    }
    this.deps.store.applyMutations(input.workspacePath, operations);
    return {
      task: updatedTask,
      run: updatedRun
    };
  }

  async recoverTask(workspacePath: string, task: TaskRecord, run: RunRecord, reason: string) {
    const action = this.deps.policy.classifyRecovery(task);
    const now = nowIso();
    if (action === "retryable") {
      const updatedTask: TaskRecord = {
        ...task,
        status: "pending",
        recoveryAction: "retryable",
        summary: reason,
        workerRunId: undefined,
        updatedAt: now
      };
      const updatedRun: RunRecord = {
        ...run,
        activeTaskIds: run.activeTaskIds.filter((id) => id !== task.id),
        updatedAt: now
      };
      this.deps.store.applyMutations(workspacePath, [
        {
          type: "upsert",
          kind: "task",
          value: updatedTask
        },
        {
          type: "upsert",
          kind: "run",
          value: updatedRun
        },
        {
          type: "event",
          value: this.deps.store.createEvent({
            type: "task.interrupted",
            objectiveId: updatedTask.objectiveId,
            branchId: updatedTask.branchId,
            runId: updatedTask.runId,
            taskId: updatedTask.id,
            payload: {
              reason,
              mode: "retry"
            }
          })
        }
      ]);
      return updatedTask;
    }

    const updatedTask: TaskRecord = {
      ...task,
      status: "needs-human",
      recoveryAction: "needs-human",
      summary: reason,
      updatedAt: now,
      completedAt: now
    };
    const updatedRun: RunRecord = {
      ...run,
      status: "needs-human",
      blockedReason: reason,
      activeTaskIds: run.activeTaskIds.filter((id) => id !== task.id),
      updatedAt: now
    };
    this.deps.store.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind: "task",
        value: updatedTask
      },
      {
        type: "upsert",
        kind: "run",
        value: updatedRun
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "task.interrupted",
          objectiveId: updatedTask.objectiveId,
          branchId: updatedTask.branchId,
          runId: updatedTask.runId,
          taskId: updatedTask.id,
          payload: {
            reason,
            mode: "needs-human"
          }
        })
      }
    ]);
    return updatedTask;
  }

  async interruptActiveTask(
    workspacePath: string,
    handle: InterruptibleTaskHandle,
    mode: InterruptMode,
    reason: string
  ) {
    const branch =
      handle.branch ?? this.deps.store.readProjection(workspacePath, "branch", handle.task.branchId) ?? null;
    const operations: ProjectionMutation[] = [];
    let refreshedBranch = branch;
    let patchRef: ArtifactRef | undefined;
    let changedFiles: string[] = [];
    if (handle.lease?.worktreePath && branch) {
      changedFiles = await this.deps.leaseManager.listChangedFiles(handle.lease.worktreePath, {
        trackedOnly: true
      }).catch(() => []);
      if (changedFiles.length > 0) {
        const workingTreePatch = await this.deps.leaseManager.buildWorkingTreePatch(branch);
        if (workingTreePatch.changed && workingTreePatch.patch) {
          patchRef = await this.deps.artifactStore.writePatchArtifact(workspacePath, `${handle.task.id}-interrupt`, workingTreePatch.patch);
        }
        refreshedBranch = await this.deps.leaseManager.restoreBranchWorkspace(workspacePath, branch);
        operations.push({
          type: "upsert",
          kind: "branch",
          value: refreshedBranch
        });
      }
    }

    if (handle.lease) {
      const released = await this.deps.leaseManager.releaseLease(handle.lease);
      operations.push({
        type: "upsert",
        kind: "lease",
        value: released
      });
    }

    const now = nowIso();
    const nextTask: TaskRecord =
      mode === "pause"
        ? {
            ...handle.task,
            status: "pending",
            summary: reason,
            lastInterruptionReason: reason,
            artifactRefs: patchRef ? Array.from(new Set([...(handle.task.artifactRefs ?? []), patchRef])) : handle.task.artifactRefs,
            changedFiles: changedFiles.length > 0 ? changedFiles : handle.task.changedFiles,
            workerRunId: undefined,
            startedAt: undefined,
            updatedAt: now
          }
        : {
            ...handle.task,
            status: "cancelled",
            summary: reason,
            lastInterruptionReason: reason,
            artifactRefs: patchRef ? Array.from(new Set([...(handle.task.artifactRefs ?? []), patchRef])) : handle.task.artifactRefs,
            changedFiles: changedFiles.length > 0 ? changedFiles : handle.task.changedFiles,
            workerRunId: undefined,
            completedAt: now,
            updatedAt: now
          };
    const nextRun: RunRecord = {
      ...handle.run,
      activeTaskIds: handle.run.activeTaskIds.filter((id) => id !== handle.task.id),
      updatedAt: now
    };
    const nextWorkerRun: WorkerRunRecord = {
      ...handle.workerRun,
      status: "cancelled",
      updatedAt: now,
      endedAt: now
    };
    operations.push(
      {
        type: "upsert",
        kind: "task",
        value: nextTask
      },
      {
        type: "upsert",
        kind: "run",
        value: nextRun
      },
      {
        type: "upsert",
        kind: "worker_run",
        value: nextWorkerRun
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "task.interrupted",
          objectiveId: nextTask.objectiveId,
          branchId: nextTask.branchId,
          runId: nextTask.runId,
          taskId: nextTask.id,
          payload: {
            reason,
            mode
          }
        })
      }
    );
    this.deps.store.applyMutations(workspacePath, operations);
    return nextTask;
  }

  async handleTaskOutcome(input: {
    workspacePath: string;
    task: TaskRecord;
    run: RunRecord;
    workerRun: WorkerRunRecord;
    lease?: WorktreeLeaseRecord;
    outcome: TaskOutcome;
  }) {
    const projection = this.deps.store.getProjection(input.workspacePath);
    const objective = projection.objectives.find((entry) => entry.id === input.task.objectiveId);
    let branch = projection.branches.find((entry) => entry.id === input.task.branchId) ?? null;
    if (!objective) {
      throw new Error(`Objective ${input.task.objectiveId} is missing.`);
    }

    const metadataBranch = readBranchFromProviderMetadata(input.outcome.providerMetadata, branch?.id);
    if (metadataBranch) {
      branch = metadataBranch;
    }

    if (input.outcome.status === "failed" && input.outcome.retryability === "retryable" && input.task.attemptCount < input.task.maxAttempts) {
      const now = nowIso();
      const operations: ProjectionMutation[] = [
        {
          type: "upsert",
          kind: "task",
          value: {
            ...input.task,
            status: "pending",
            summary: input.outcome.failureReason ?? input.outcome.summary,
            artifactRefs: input.outcome.artifactRefs,
            changedFiles: input.outcome.changedFiles,
            workerRunId: undefined,
            updatedAt: now
          }
        },
        {
          type: "upsert",
          kind: "run",
          value: {
            ...input.run,
            activeTaskIds: input.run.activeTaskIds.filter((id) => id !== input.task.id),
            updatedAt: now
          }
        },
        {
          type: "upsert",
          kind: "worker_run",
          value: {
            ...input.workerRun,
            status: "failed",
            updatedAt: now,
            endedAt: now
          }
        },
        {
          type: "event",
          value: this.deps.store.createEvent({
            type: "task.interrupted",
            objectiveId: input.task.objectiveId,
            branchId: input.task.branchId,
            runId: input.task.runId,
            taskId: input.task.id,
            payload: {
              reason: input.outcome.failureReason ?? input.outcome.summary,
              mode: "retry"
            }
          })
        }
      ];
      if (input.lease) {
        const released = await this.deps.leaseManager.releaseLease(input.lease);
        operations.push({
          type: "upsert",
          kind: "lease",
          value: released
        });
      }
      if (metadataBranch) {
        operations.push({
          type: "upsert",
          kind: "branch",
          value: metadataBranch
        });
      }
      this.deps.store.applyMutations(input.workspacePath, operations);
      return;
    }

    const now = nowIso();
    const updatedTask: TaskRecord = {
      ...input.task,
      status: input.outcome.status,
      summary: input.outcome.summary,
      changedFiles: input.outcome.changedFiles,
      artifactRefs: input.outcome.artifactRefs,
      updatedAt: now,
      completedAt: now
    };
    const updatedRun: RunRecord = {
      ...input.run,
      activeTaskIds: input.run.activeTaskIds.filter((id) => id !== input.task.id),
      updatedAt: now
    };
    const updatedWorkerRun: WorkerRunRecord = {
      ...input.workerRun,
      status: input.outcome.status,
      updatedAt: now,
      endedAt: now
    };
    const operations: ProjectionMutation[] = [
      {
        type: "upsert",
        kind: "task",
        value: updatedTask
      },
      {
        type: "upsert",
        kind: "run",
        value: updatedRun
      },
      {
        type: "upsert",
        kind: "worker_run",
        value: updatedWorkerRun
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "task.completed",
          objectiveId: updatedTask.objectiveId,
          branchId: updatedTask.branchId,
          runId: updatedTask.runId,
          taskId: updatedTask.id,
          payload: {
            status: updatedTask.status,
            summary: updatedTask.summary
          }
        })
      }
    ];
    if (input.lease) {
      const released = await this.deps.leaseManager.releaseLease(input.lease);
      operations.push({
        type: "upsert",
        kind: "lease",
        value: released
      });
    }
    if (metadataBranch) {
      operations.push({
        type: "upsert",
        kind: "branch",
        value: metadataBranch
      });
      branch = metadataBranch;
    }
    this.deps.store.applyMutations(input.workspacePath, operations);

    switch (updatedTask.kind) {
      case "plan":
        this.applyPlanOutcome(input.workspacePath, objective, updatedRun, updatedTask, input.outcome);
        break;
      case "discover":
        await this.applyDiscoverOutcome(input.workspacePath, objective, updatedTask, input.outcome);
        break;
      case "read_synthesize":
        this.applyReadOutcome(input.workspacePath, objective, updatedTask, input.outcome);
        break;
      case "build_change":
        this.applyBuildOutcome(input.workspacePath, objective, updatedTask, input.outcome);
        break;
      case "verify_change":
      case "run_experiment":
        this.applyExperimentOutcome(input.workspacePath, objective, updatedTask, input.outcome);
        break;
      case "evaluate_branch":
        await this.applyEvaluationOutcome(input.workspacePath, objective, updatedRun, updatedTask, input.outcome);
        break;
      case "promote_patch":
        this.applyPromotionOutcome(input.workspacePath, objective, updatedTask, input.outcome);
        break;
    }
  }

  enqueuePlanIfNeeded(workspacePath: string, runId: string, objectiveId: string) {
    const projection = this.deps.store.getProjection(workspacePath);
    const objective = projection.objectives.find((entry) => entry.id === objectiveId);
    const run = projection.runs.find((entry) => entry.id === runId);
    if (!objective || !run) {
      return null;
    }
    const branches = projection.branches.filter((entry) => entry.objectiveId === objective.id);
    const tasks = projection.tasks.filter((entry) => entry.runId === run.id);
    if (!this.deps.policy.shouldCreatePlanTask({ run, branches, tasks })) {
      return null;
    }
    const activeBranch =
      branches.find((entry) => entry.id === objective.activeBranchId && isBranchSchedulable(entry.status)) ??
      branches.filter((entry) => isBranchSchedulable(entry.status)).sort((left, right) => right.score - left.score)[0] ??
      null;
    if (!activeBranch) {
      return null;
    }
    return this.enqueueTask({
      workspacePath,
      objective,
      run,
      branch: activeBranch,
      title: `Plan next steps for ${activeBranch.title}`,
      prompt: `Plan the next bounded research steps for branch "${activeBranch.title}" under objective "${objective.title}".`,
      kind: "plan",
      payload: {
        objectiveId: objective.id,
        activeBranchId: activeBranch.id,
        goal: objective.objective
      },
      dependencies: [],
      maxAttempts: 2
    });
  }

  private ensurePrimaryBranch(workspacePath: string, objective: ObjectiveRecord) {
    const projection = this.deps.store.getProjection(workspacePath);
    const existing =
      projection.branches.find((entry) => entry.id === objective.activeBranchId) ??
      projection.branches.find((entry) => entry.objectiveId === objective.id) ??
      null;
    if (existing) {
      return existing;
    }

    const now = nowIso();
    const branch: BranchRecord = {
      id: createId("br"),
      objectiveId: objective.id,
      title: "Primary branch",
      hypothesis: objective.objective,
      status: "active",
      score: 0.5,
      findingIds: [],
      taskIds: [],
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind: "branch",
        value: branch
      },
      {
        type: "upsert",
        kind: "objective",
        value: {
          ...objective,
          activeBranchId: branch.id,
          branchIds: Array.from(new Set([...objective.branchIds, branch.id])),
          updatedAt: now
        }
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "branch.created",
          objectiveId: objective.id,
          branchId: branch.id,
          payload: {
            title: branch.title,
            hypothesis: branch.hypothesis
          }
        })
      }
    ]);
    return branch;
  }

  private applyPlanOutcome(workspacePath: string, objective: ObjectiveRecord, run: RunRecord, task: TaskRecord, outcome: TaskOutcome) {
    if (!outcome.plan) {
      return;
    }

    const projection = this.deps.store.getProjection(workspacePath);
    const validated = this.deps.policy.validateProposal({
      proposal: outcome.plan,
      run,
      branches: projection.branches.filter((entry) => entry.objectiveId === objective.id),
      tasks: projection.tasks.filter((entry) => entry.runId === run.id)
    });

    const branchByTitle = new Map(
      projection.branches
        .filter((entry) => entry.objectiveId === objective.id)
        .map((entry) => [entry.title.trim().toLowerCase(), entry] as const)
    );
    let refreshedObjective = objective;
    for (const proposal of validated.proposedBranches) {
      const branch = this.createBranch(workspacePath, refreshedObjective, proposal.title, proposal.hypothesis);
      branchByTitle.set(branch.title.trim().toLowerCase(), branch);
      refreshedObjective = this.deps.store.readProjection(workspacePath, "objective", objective.id) ?? refreshedObjective;
    }

    const projectionAfterBranches = this.deps.store.getProjection(workspacePath);
    const defaultBranch =
      projectionAfterBranches.branches.find((entry) => entry.id === refreshedObjective.activeBranchId) ??
      projectionAfterBranches.branches.find((entry) => entry.objectiveId === objective.id && isBranchSchedulable(entry.status)) ??
      null;
    const taskIdByStepId = new Map<string, string>();
    for (const proposal of validated.proposedTasks) {
      taskIdByStepId.set(proposal.stepId, createId("task"));
    }

    for (const proposal of validated.proposedTasks) {
      const branch =
        (proposal.branchTitle ? branchByTitle.get(proposal.branchTitle.trim().toLowerCase()) : null) ??
        defaultBranch;
      if (!branch) {
        continue;
      }
      const dependencies: TaskDependency[] = proposal.dependsOn
        .map((stepId) => taskIdByStepId.get(stepId))
        .filter((entry): entry is string => Boolean(entry))
        .map((taskId) => ({
          taskId,
          on: "success"
        }));
      const payload = this.buildPayloadForProposal(workspacePath, refreshedObjective, branch, proposal);
      this.enqueueTask({
        workspacePath,
        id: taskIdByStepId.get(proposal.stepId),
        objective: refreshedObjective,
        run,
        branch,
        title: proposal.title,
        prompt: proposal.prompt,
        kind: proposal.kind,
        payload,
        dependencies,
        maxAttempts: proposal.kind === "build_change" || proposal.kind === "verify_change" || proposal.kind === "run_experiment" ? 2 : 1,
        priority: this.deps.policy.buildPriority(proposal, branch),
        planStepId: proposal.stepId
      });
    }
  }

  private async applyDiscoverOutcome(workspacePath: string, objective: ObjectiveRecord, task: TaskRecord, outcome: TaskOutcome) {
    const branch = this.deps.store.readProjection(workspacePath, "branch", task.branchId);
    if (!branch || !outcome.discoveredSources || outcome.discoveredSources.length === 0) {
      return;
    }
    const sources = await this.deps.sourceIngest.addDiscoveredSources({
      workspacePath,
      objective,
      branch,
      sources: outcome.discoveredSources
    });
    if (sources.length === 0) {
      return;
    }
    const run = this.deps.store.readProjection(workspacePath, "run", task.runId);
    if (!run) {
      return;
    }
    this.enqueueTask({
      workspacePath,
      objective,
      run,
      branch,
      title: `Synthesize evidence for ${branch.title}`,
      prompt: `Read the newly discovered sources and synthesize the strongest evidence for branch "${branch.title}".`,
      kind: "read_synthesize",
      payload: {
        branchId: branch.id,
        sourceIds: sources.map((entry) => entry.id),
        questions: [`What evidence strengthens or weakens the hypothesis "${branch.hypothesis}"?`]
      },
      dependencies: [
        {
          taskId: task.id,
          on: "success"
        }
      ],
      maxAttempts: 1
    });
  }

  private applyReadOutcome(workspacePath: string, objective: ObjectiveRecord, task: TaskRecord, outcome: TaskOutcome) {
    const branch = this.deps.store.readProjection(workspacePath, "branch", task.branchId);
    const run = this.deps.store.readProjection(workspacePath, "run", task.runId);
    if (!branch || !run || !outcome.findings || outcome.findings.length === 0) {
      return;
    }
    const projection = this.deps.store.getProjection(workspacePath);
    const now = nowIso();
    const newFindings = outcome.findings.map((finding) => {
      const source = projection.sources.find(
        (entry) => entry.locator === finding.sourceLocator || entry.canonicalLocator === finding.sourceLocator
      );
      return {
        id: createId("find"),
        objectiveId: objective.id,
        branchId: branch.id,
        sourceId: source?.id,
        sourceChunkIds: projection.sourceChunks
          .filter((entry) => entry.sourceId === source?.id)
          .slice(0, 3)
          .map((entry) => entry.id),
        summary: finding.summary,
        detail: finding.detail,
        evidence: [finding.citationText ?? finding.sourceLocator].filter(Boolean),
        createdAt: now,
        updatedAt: now
      } satisfies FindingRecord;
    });
    this.deps.store.applyMutations(workspacePath, [
      ...newFindings.map(
        (entry) =>
          ({
            type: "upsert",
            kind: "finding",
            value: entry
          }) satisfies ProjectionMutation
      ),
      {
        type: "upsert",
        kind: "branch",
        value: {
          ...branch,
          findingIds: Array.from(new Set([...branch.findingIds, ...newFindings.map((entry) => entry.id)])),
          updatedAt: now
        }
      }
    ]);
    this.enqueueEvaluationTask({
      workspacePath,
      objective,
      run,
      branch: {
        ...branch,
        findingIds: Array.from(new Set([...branch.findingIds, ...newFindings.map((entry) => entry.id)]))
      },
      subjectTask: {
        ...task,
        artifactRefs: outcome.artifactRefs,
        changedFiles: outcome.changedFiles
      },
      sourceRefs: newFindings.flatMap((entry) => (entry.sourceId ? [entry.sourceId] : [])),
      focus: `Evaluate whether the new evidence changes confidence in branch "${branch.title}".`
    });
  }

  private applyBuildOutcome(workspacePath: string, objective: ObjectiveRecord, task: TaskRecord, outcome: TaskOutcome) {
    const run = this.deps.store.readProjection(workspacePath, "run", task.runId);
    const branch = this.deps.store.readProjection(workspacePath, "branch", task.branchId);
    if (!run || !branch) {
      return;
    }
    const payload = task.payload as BuildTaskPayload;
    if (outcome.status === "completed" && payload.verificationSpecId) {
      this.enqueueTask({
        workspacePath,
        objective,
        run,
        branch,
        title: `Verify ${branch.title}`,
        prompt: `Run verification for branch "${branch.title}".`,
        kind: "verify_change",
        payload: {
          branchId: branch.id,
          experimentSpecId: payload.verificationSpecId
        },
        dependencies: [
          {
            taskId: task.id,
            on: "success"
          }
        ],
        maxAttempts: 2
      });
      return;
    }

    this.enqueueEvaluationTask({
      workspacePath,
      objective,
      run,
      branch,
      subjectTask: {
        ...task,
        artifactRefs: outcome.artifactRefs,
        changedFiles: outcome.changedFiles
      },
      sourceRefs: this.deps.sourceIngest.listLinkedSourceIds(workspacePath, objective.id, branch.id).slice(-5),
      focus: `Evaluate the latest code change for branch "${branch.title}".`
    });
  }

  private applyExperimentOutcome(workspacePath: string, objective: ObjectiveRecord, task: TaskRecord, outcome: TaskOutcome) {
    const run = this.deps.store.readProjection(workspacePath, "run", task.runId);
    const branch = this.deps.store.readProjection(workspacePath, "branch", task.branchId);
    const payload = task.payload as ExperimentTaskPayload;
    const experimentSpec = this.deps.store.readProjection(workspacePath, "experiment_spec", payload.experimentSpecId);
    if (!run || !branch || !outcome.experimentManifest || !experimentSpec) {
      return;
    }

    const now = nowIso();
    const experiment: ExperimentRunRecord = {
      id: createId("exp"),
      objectiveId: objective.id,
      branchId: branch.id,
      taskId: task.id,
      experimentSpecId: experimentSpec.id,
      status: outcome.status,
      summary: outcome.summary,
      manifestRef: outcome.artifactRefs.find((entry) => entry.kind === "manifest"),
      stdoutRef: outcome.artifactRefs.find((entry) => entry.kind === "stdout"),
      stderrRef: outcome.artifactRefs.find((entry) => entry.kind === "stderr"),
      patchArtifactRef: outcome.artifactRefs.find((entry) => entry.kind === "patch"),
      changedFiles: outcome.changedFiles,
      metrics: outcome.metrics,
      contractViolation: outcome.experimentManifest.contractViolation,
      createdAt: now,
      updatedAt: now
    };
    const metricRecords = outcome.metrics.map((metric) => ({
      id: createId("metric"),
      objectiveId: objective.id,
      branchId: branch.id,
      taskId: task.id,
      experimentId: experiment.id,
      name: metric.name,
      value: metric.value,
      unit: metric.unit,
      createdAt: now,
      updatedAt: now
    } satisfies MetricRecord));
    this.deps.store.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind: "experiment",
        value: experiment
      },
      ...metricRecords.map(
        (record) =>
          ({
            type: "upsert",
            kind: "metric",
            value: record
          }) satisfies ProjectionMutation
      ),
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "experiment.run_completed",
          objectiveId: objective.id,
          branchId: branch.id,
          runId: run.id,
          taskId: task.id,
          payload: {
            experimentId: experiment.id,
            status: experiment.status,
            experimentSpecId: experiment.experimentSpecId
          }
        })
      }
    ]);

    this.enqueueEvaluationTask({
      workspacePath,
      objective,
      run,
      branch,
      subjectTask: {
        ...task,
        artifactRefs: outcome.artifactRefs,
        changedFiles: outcome.changedFiles
      },
      experimentIds: [experiment.id],
      metricRefs: metricRecords.map((entry) => entry.id),
      sourceRefs: this.deps.sourceIngest.listLinkedSourceIds(workspacePath, objective.id, branch.id).slice(-5),
      focus: `Evaluate the latest experiment results for branch "${branch.title}".`
    });
  }

  private async applyEvaluationOutcome(workspacePath: string, objective: ObjectiveRecord, run: RunRecord, task: TaskRecord, outcome: TaskOutcome) {
    const branch = this.deps.store.readProjection(workspacePath, "branch", task.branchId);
    if (!branch || !outcome.evaluation) {
      return;
    }

    const now = nowIso();
    const evaluation: EvaluationDecisionRecord = {
      id: createId("eval"),
      objectiveId: objective.id,
      branchId: branch.id,
      taskId: task.id,
      verdict: outcome.evaluation.verdict,
      gateStatus: outcome.evaluation.gateStatus,
      scoreDelta: outcome.evaluation.scoreDelta,
      summary: outcome.evaluation.summary,
      rationale: outcome.evaluation.rationale,
      followupPrompt: outcome.evaluation.followupPrompt,
      comparator: outcome.evaluation.comparator,
      createdAt: now,
      updatedAt: now
    };
    const subjectTaskId = (task.payload as EvaluateTaskPayload).subjectTaskId;
    const subjectTask = this.deps.store.readProjection(workspacePath, "task", subjectTaskId);
    let nextBranch: BranchRecord = {
      ...branch,
      latestEvaluationId: evaluation.id,
      score: roundScore(branch.score + evaluation.scoreDelta),
      status:
        evaluation.verdict === "kill"
          ? "killed"
          : evaluation.verdict === "pivot"
            ? "pivoted"
            : evaluation.verdict === "complete"
              ? "completed"
              : "active",
      lastFailureReason: subjectTask?.status === "failed" ? subjectTask.summary : branch.lastFailureReason,
      updatedAt: now
    };
    const operations: ProjectionMutation[] = [
      {
        type: "upsert",
        kind: "evaluation",
        value: evaluation
      },
      {
        type: "upsert",
        kind: "branch",
        value: nextBranch
      },
      {
        type: "upsert",
        kind: "task",
        value: {
          ...task,
          evaluationId: evaluation.id,
          updatedAt: now
        }
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "evaluation.decided",
          objectiveId: objective.id,
          branchId: branch.id,
          runId: run.id,
          taskId: task.id,
          payload: {
            evaluationId: evaluation.id,
            verdict: evaluation.verdict,
            gateStatus: evaluation.gateStatus
          }
        })
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "branch.status_changed",
          objectiveId: objective.id,
          branchId: branch.id,
          payload: {
            status: nextBranch.status
          }
        })
      }
    ];

    let successorBranch: BranchRecord | null = null;
    if (evaluation.verdict === "pivot") {
      successorBranch = this.createBranch(
        workspacePath,
        objective,
        `${branch.title} Pivot`,
        evaluation.followupPrompt || `Pivot of ${branch.hypothesis}`,
        branch.id
      );
      nextBranch = {
        ...nextBranch,
        successorBranchId: successorBranch.id,
        updatedAt: nowIso()
      };
      operations.push({
        type: "upsert",
        kind: "branch",
        value: nextBranch
      });
    }

    if (evaluation.verdict === "complete") {
      operations.push(
        {
          type: "upsert",
          kind: "objective",
          value: {
            ...objective,
            status: "completed",
            summary: evaluation.summary,
            updatedAt: now
          }
        },
        {
          type: "upsert",
          kind: "run",
          value: {
            ...run,
            status: "completed",
            stopReason: undefined,
            updatedAt: now,
            endedAt: now
          }
        }
      );
    }

    this.deps.store.applyMutations(workspacePath, operations);

    if ((evaluation.verdict === "continue" || evaluation.verdict === "complete") && subjectTask?.kind === "build_change") {
      const patchRef = subjectTask.artifactRefs?.find((entry) => entry.kind === "patch");
      if (patchRef) {
        const targetBranch = this.deps.store.readProjection(workspacePath, "branch", branch.id) ?? nextBranch;
        this.enqueueTask({
          workspacePath,
          objective,
          run: this.deps.store.readProjection(workspacePath, "run", run.id) ?? run,
          branch: targetBranch,
          title: `Promote ${targetBranch.title}`,
          prompt: `Promote the latest approved patch for branch "${targetBranch.title}".`,
          kind: "promote_patch",
          payload: {
            branchId: targetBranch.id,
            sourceTaskId: subjectTask.id,
            patchArtifactRef: patchRef
          },
          dependencies: [
            {
              taskId: task.id,
              on: "success"
            }
          ],
          maxAttempts: 1
        });
      }
    }

    const followupBranch = successorBranch ?? nextBranch;
    if (evaluation.followupPrompt && run.status === "active" && (evaluation.verdict === "continue" || evaluation.verdict === "pivot")) {
      const freshRun = this.deps.store.readProjection(workspacePath, "run", run.id);
      if (freshRun?.status === "active") {
        this.enqueueTask({
          workspacePath,
          objective,
          run: freshRun,
          branch: followupBranch,
          title: `Follow up ${followupBranch.title}`,
          prompt: evaluation.followupPrompt,
          kind: "discover",
          payload: {
            branchId: followupBranch.id,
            goal: evaluation.followupPrompt,
            maxResults: 5
          },
          dependencies: [
            {
              taskId: task.id,
              on: "success"
            }
          ],
          maxAttempts: 1
        });
      }
    }
  }

  private applyPromotionOutcome(workspacePath: string, objective: ObjectiveRecord, task: TaskRecord, outcome: TaskOutcome) {
    const branch = this.deps.store.readProjection(workspacePath, "branch", task.branchId);
    if (!branch) {
      return;
    }
    const payload = task.payload as PromoteTaskPayload;
    const now = nowIso();
    const record: PromotionRecord = {
      id: createId("promo"),
      objectiveId: objective.id,
      branchId: branch.id,
      taskId: task.id,
      sourceTaskId: payload.sourceTaskId,
      patchArtifactRef: payload.patchArtifactRef,
      status: outcome.promotion?.status ?? (outcome.status === "completed" ? "promoted" : "failed"),
      summary: outcome.promotion?.summary ?? outcome.summary,
      createdAt: now,
      updatedAt: now
    };
    const operations: ProjectionMutation[] = [
      {
        type: "upsert",
        kind: "promotion",
        value: record
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "promotion.applied",
          objectiveId: objective.id,
          branchId: branch.id,
          runId: task.runId,
          taskId: task.id,
          payload: {
            promotionId: record.id,
            status: record.status
          }
        })
      }
    ];
    if (record.status === "promoted") {
      operations.push({
        type: "upsert",
        kind: "branch",
        value: {
          ...branch,
          promotionHeadCommit: branch.headCommit,
          updatedAt: now
        }
      });
    }
    this.deps.store.applyMutations(workspacePath, operations);
  }

  private enqueueEvaluationTask(input: {
    workspacePath: string;
    objective: ObjectiveRecord;
    run: RunRecord;
    branch: BranchRecord;
    subjectTask: TaskRecord;
    experimentIds?: string[];
    metricRefs?: string[];
    sourceRefs: string[];
    focus: string;
  }) {
    const evaluationPayload: EvaluateTaskPayload = {
      branchId: input.branch.id,
      subjectTaskId: input.subjectTask.id,
      subjectTaskStatus:
        input.subjectTask.status === "completed" ||
        input.subjectTask.status === "failed" ||
        input.subjectTask.status === "cancelled" ||
        input.subjectTask.status === "needs-human"
          ? input.subjectTask.status
          : "failed",
      workerRunId: input.subjectTask.workerRunId,
      patchArtifactRef: input.subjectTask.artifactRefs?.find((entry) => entry.kind === "patch"),
      changedFiles: input.subjectTask.changedFiles ?? [],
      experimentResultIds: input.experimentIds ?? [],
      metricRefs: input.metricRefs ?? [],
      sourceRefs: input.sourceRefs,
      successCriteria: input.objective.successCriteria,
      baselineExperimentId: input.objective.baselineExperimentId,
      focus: input.focus
    };
    return this.enqueueTask({
      workspacePath: input.workspacePath,
      objective: input.objective,
      run: input.run,
      branch: input.branch,
      title: `Evaluate ${input.branch.title}`,
      prompt: input.focus,
      kind: "evaluate_branch",
      payload: evaluationPayload,
      dependencies: [
        {
          taskId: input.subjectTask.id,
          on: "terminal"
        }
      ],
      maxAttempts: 2
    });
  }

  private buildPayloadForProposal(workspacePath: string, objective: ObjectiveRecord, branch: BranchRecord, proposal: PlanStepProposal): TaskPayload {
    switch (proposal.kind) {
      case "discover":
        return {
          branchId: branch.id,
          goal: proposal.prompt,
          maxResults: 6
        };
      case "read_synthesize":
        return {
          branchId: branch.id,
          sourceIds: proposal.sourceIds?.length
            ? proposal.sourceIds
            : this.deps.sourceIngest.listLinkedSourceIds(workspacePath, objective.id, branch.id).slice(-6),
          questions: proposal.questions?.length ? proposal.questions : [proposal.prompt]
        };
      case "build_change": {
        const verificationSpecId = proposal.verificationSpec
          ? this.createExperimentSpec(workspacePath, objective, branch, proposal.verificationSpec)
          : undefined;
        return {
          branchId: branch.id,
          goal: proposal.prompt,
          constraints: [],
          successCriteria: proposal.successRubric.length > 0 ? proposal.successRubric : objective.successCriteria,
          verificationSpecId
        };
      }
      case "verify_change":
      case "run_experiment": {
        if (!proposal.experimentSpec) {
          throw new Error(`Proposal ${proposal.stepId} is missing an experimentSpec.`);
        }
        const experimentSpecId = this.createExperimentSpec(workspacePath, objective, branch, proposal.experimentSpec);
        return {
          branchId: branch.id,
          experimentSpecId
        } satisfies ExperimentTaskPayload;
      }
      case "evaluate_branch": {
        const projection = this.deps.store.getProjection(workspacePath);
        const subjectTask =
          projection.tasks
            .filter((entry) => entry.branchId === branch.id && entry.kind !== "evaluate_branch" && entry.status !== "pending")
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
        return {
          branchId: branch.id,
          subjectTaskId: subjectTask?.id ?? createId("task_missing"),
          subjectTaskStatus:
            subjectTask?.status === "completed" ||
            subjectTask?.status === "failed" ||
            subjectTask?.status === "cancelled" ||
            subjectTask?.status === "needs-human"
              ? subjectTask.status
              : "failed",
          workerRunId: subjectTask?.workerRunId,
          patchArtifactRef: subjectTask?.artifactRefs?.find((entry) => entry.kind === "patch"),
          changedFiles: subjectTask?.changedFiles ?? [],
          experimentResultIds: [],
          metricRefs: [],
          sourceRefs: this.deps.sourceIngest.listLinkedSourceIds(workspacePath, objective.id, branch.id).slice(-5),
          successCriteria: objective.successCriteria,
          baselineExperimentId: objective.baselineExperimentId,
          focus: proposal.prompt
        };
      }
      case "promote_patch": {
        const projection = this.deps.store.getProjection(workspacePath);
        const sourceTask =
          projection.tasks
            .filter((entry) => entry.branchId === branch.id && entry.kind === "build_change" && entry.status === "completed")
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
        const patchArtifactRef = sourceTask?.artifactRefs?.find((entry) => entry.kind === "patch");
        if (!sourceTask || !patchArtifactRef) {
          throw new Error(`Cannot create promote_patch payload for branch ${branch.id} without a completed build patch.`);
        }
        return {
          branchId: branch.id,
          sourceTaskId: sourceTask.id,
          patchArtifactRef
        };
      }
    }
  }

  private enqueueTask(input: {
    workspacePath: string;
    id?: string;
    objective: ObjectiveRecord;
    run: RunRecord;
    branch: BranchRecord;
    title: string;
    prompt: string;
    kind: TaskRecord["kind"];
    payload: TaskPayload;
    dependencies: TaskDependency[];
    maxAttempts: number;
    priority?: TaskRecord["priority"];
    planStepId?: string;
  }) {
    const now = nowIso();
    const task: TaskRecord = {
      id: input.id ?? createId("task"),
      objectiveId: input.objective.id,
      branchId: input.branch.id,
      runId: input.run.id,
      kind: input.kind,
      executor: executorForTask(input.kind),
      status: "pending",
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      payload: input.payload,
      dependencies: input.dependencies,
      priority: input.priority ?? this.deps.policy.buildPriority({ kind: input.kind, title: input.title }, input.branch),
      attemptCount: 0,
      maxAttempts: input.maxAttempts,
      planStepId: input.planStepId,
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.applyMutations(input.workspacePath, [
      {
        type: "upsert",
        kind: "task",
        value: task
      },
      {
        type: "upsert",
        kind: "branch",
        value: {
          ...input.branch,
          taskIds: Array.from(new Set([...input.branch.taskIds, task.id])),
          updatedAt: now
        }
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "task.enqueued",
          objectiveId: input.objective.id,
          branchId: input.branch.id,
          runId: input.run.id,
          taskId: task.id,
          payload: {
            kind: task.kind,
            title: task.title
          }
        })
      }
    ]);
    return task;
  }

  private createBranch(workspacePath: string, objective: ObjectiveRecord, title: string, hypothesis: string, parentBranchId?: string) {
    const now = nowIso();
    const branch: BranchRecord = {
      id: createId("br"),
      objectiveId: objective.id,
      title: title.trim(),
      hypothesis: hypothesis.trim(),
      status: "candidate",
      score: 0.55,
      parentBranchId,
      findingIds: [],
      taskIds: [],
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind: "branch",
        value: branch
      },
      {
        type: "upsert",
        kind: "objective",
        value: {
          ...objective,
          branchIds: Array.from(new Set([...objective.branchIds, branch.id])),
          updatedAt: now
        }
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "branch.created",
          objectiveId: objective.id,
          branchId: branch.id,
          payload: {
            title: branch.title,
            hypothesis: branch.hypothesis,
            parentBranchId
          }
        })
      }
    ]);
    return branch;
  }

  private createExperimentSpec(workspacePath: string, objective: ObjectiveRecord, branch: BranchRecord, specInput: ExperimentSpecInput) {
    const normalized = validateExperimentSpec(specInput);
    const existing = this.deps.store
      .listProjections(workspacePath, "experiment_spec")
      .find(
        (entry) =>
          entry.objectiveId === objective.id &&
          entry.branchId === branch.id &&
          entry.cwd === normalized.cwd &&
          JSON.stringify(entry.commands) === JSON.stringify(normalized.commands) &&
          entry.timeoutMs === normalized.timeoutMs &&
          entry.mode === normalized.mode
      );
    if (existing) {
      return existing.id;
    }
    const now = nowIso();
    const spec: ExperimentSpecRecord = {
      id: createId("espec"),
      objectiveId: objective.id,
      branchId: branch.id,
      title: normalized.title || `Spec for ${branch.title}`,
      cwd: normalized.cwd,
      commands: normalized.commands,
      timeoutMs: normalized.timeoutMs,
      mode: normalized.mode,
      expectedMetrics: normalized.expectedMetrics,
      artifactGlobs: normalized.artifactGlobs,
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind: "experiment_spec",
        value: spec
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "experiment.spec_created",
          objectiveId: objective.id,
          branchId: branch.id,
          payload: {
            experimentSpecId: spec.id,
            cwd: spec.cwd,
            mode: spec.mode
          }
        })
      }
    ]);
    return spec.id;
  }
}

function defaultRunBudget(): RunBudget {
  return {
    planning: 6,
    discovery: 12,
    build: 6,
    experiment: 8,
    evaluation: 12,
    wallClockMs: 2 * 60 * 60 * 1000,
    maxBranches: 6
  };
}

function defaultBudgetUsage(startedAt: string): RunBudgetUsage {
  return {
    planning: 0,
    discovery: 0,
    build: 0,
    experiment: 0,
    evaluation: 0,
    startedAt
  };
}

export function effectiveElapsedMs(run: RunRecord) {
  if (!run.startedAt) {
    return 0;
  }
  const startedAtMs = new Date(run.startedAt).getTime();
  const pausedMs = run.totalPausedMs ?? 0;
  return Math.max(0, Date.now() - startedAtMs - pausedMs);
}

function resolveObjective(objectives: ObjectiveRecord[], objectiveId?: string) {
  if (objectiveId) {
    return objectives.find((entry) => entry.id === objectiveId) ?? null;
  }
  return [...objectives].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

function summarizeObjective(objective: string) {
  return objective.trim().split(/\s+/).slice(0, 8).join(" ") || "Untitled objective";
}

function readBranchFromProviderMetadata(providerMetadata: Record<string, unknown> | undefined, branchId?: string | null) {
  const candidate = providerMetadata?.branch;
  if (!candidate || typeof candidate !== "object" || !branchId) {
    return null;
  }
  const record = candidate as BranchRecord;
  return record.id === branchId ? record : null;
}

function validateExperimentSpec(input: ExperimentSpecInput) {
  const cwd = input.cwd.trim();
  const commands = input.commands.map((entry) => entry.trim()).filter(Boolean);
  if (!cwd || cwd.includes("..")) {
    throw new Error(`ExperimentSpec.cwd must be a repo-relative path without '..': ${input.cwd}`);
  }
  if (commands.length === 0) {
    throw new Error("ExperimentSpec.commands must contain at least one command.");
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("ExperimentSpec.timeoutMs must be a positive number.");
  }
  return {
    ...input,
    title: input.title?.trim() || undefined,
    cwd,
    commands
  };
}
