import type {
  ArtifactRef,
  BranchRecord,
  EvaluationRecord,
  EvaluateTaskPayload,
  ExperimentRecord,
  ExperimentTaskPayload,
  MetricRecord,
  ObjectiveCreateInput,
  ObjectiveRecord,
  RunBudget,
  RunBudgetUsage,
  RunRecord,
  SourceAddInput,
  SourceRecord,
  StatusSnapshot,
  TaskDependency,
  TaskOutcome,
  TaskPayload,
  TaskProposal,
  TaskRecord,
  WorkerRunRecord,
  WorktreeLeaseRecord
} from "../../shared/types";
import { bucketForTask, executorForTask, PolicyEngine } from "./policy-engine";
import { SourceIngest } from "./source-ingest";
import { ResearchStore } from "./store";
import { createId, nowIso, roundScore } from "./utils";
import { WorkerLeaseManager } from "./worker-lease-manager";

export class RunManager {
  constructor(
    private readonly deps: {
      store: ResearchStore;
      policy: PolicyEngine;
      sourceIngest: SourceIngest;
      leaseManager: WorkerLeaseManager;
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
    this.deps.store.upsertProjection(workspacePath, "objective", objective);
    this.deps.store.appendEvent(
      workspacePath,
      this.deps.store.createEvent({
        type: "objective.created",
        objectiveId: objective.id,
        payload: objective
      })
    );
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
      projection.branches.find((entry) => entry.objectiveId === objective.id) ??
      null;
    const sources = await this.deps.sourceIngest.addInputs({
      workspacePath,
      objective,
      branch,
      inputs: input.inputs
    });
    if (branch && sources.length > 0) {
      this.attachSourcesToBranch(workspacePath, branch, sources);
    }
    return sources;
  }

  getStatusSnapshot(workspacePath: string, daemon: { running: boolean; pid?: number; socketPath: string }): StatusSnapshot {
    return this.deps.store.getStatusSnapshot(workspacePath, daemon);
  }

  startRun(workspacePath: string, objectiveId?: string) {
    const projection = this.deps.store.getProjection(workspacePath);
    const objective = resolveObjective(projection.objectives, objectiveId);
    if (!objective) {
      throw new Error("No objective exists. Create one first.");
    }

    const existing = projection.runs.find(
      (entry) => entry.objectiveId === objective.id && (entry.status === "active" || entry.status === "paused" || entry.status === "needs-human")
    );
    if (existing?.status === "active") {
      return existing;
    }
    if (existing?.status === "paused") {
      const resumed = {
        ...existing,
        status: "active" as const,
        stopReason: undefined,
        updatedAt: nowIso()
      };
      this.deps.store.upsertProjection(workspacePath, "run", resumed);
      this.deps.store.upsertProjection(workspacePath, "objective", {
        ...objective,
        status: "active",
        activeRunId: resumed.id,
        updatedAt: resumed.updatedAt
      });
      return resumed;
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
      startedAt: now
    };
    this.deps.store.upsertProjection(workspacePath, "run", run);
    this.deps.store.upsertProjection(workspacePath, "objective", {
      ...objective,
      status: "active",
      activeBranchId: seededBranch.id,
      activeRunId: run.id,
      branchIds: Array.from(new Set([...objective.branchIds, seededBranch.id])),
      updatedAt: now
    });
    this.enqueuePlanIfNeeded(workspacePath, run.id, objective.id);
    return run;
  }

  pauseRun(workspacePath: string, objectiveId?: string) {
    const projection = this.deps.store.getProjection(workspacePath);
    const objective = resolveObjective(projection.objectives, objectiveId);
    const run = objective ? projection.runs.find((entry) => entry.id === objective.activeRunId) : null;
    if (!run) {
      throw new Error("No active run exists.");
    }
    const paused = {
      ...run,
      status: "paused" as const,
      stopReason: "Paused by the user.",
      updatedAt: nowIso()
    };
    this.deps.store.upsertProjection(workspacePath, "run", paused);
    return paused;
  }

  resumeRun(workspacePath: string, objectiveId?: string) {
    const projection = this.deps.store.getProjection(workspacePath);
    const objective = resolveObjective(projection.objectives, objectiveId);
    const run = objective ? projection.runs.find((entry) => entry.id === objective.activeRunId) : null;
    if (!run) {
      throw new Error("No paused run exists.");
    }
    if (run.status !== "paused") {
      return run;
    }
    const resumed = {
      ...run,
      status: "active" as const,
      stopReason: undefined,
      updatedAt: nowIso()
    };
    this.deps.store.upsertProjection(workspacePath, "run", resumed);
    this.enqueuePlanIfNeeded(workspacePath, resumed.id, objective!.id);
    return resumed;
  }

  stopRun(workspacePath: string, objectiveId?: string) {
    const projection = this.deps.store.getProjection(workspacePath);
    const objective = resolveObjective(projection.objectives, objectiveId);
    const run = objective ? projection.runs.find((entry) => entry.id === objective.activeRunId) : null;
    if (!run) {
      throw new Error("No run exists.");
    }
    const stopped = {
      ...run,
      status: "stopped" as const,
      stopReason: "Stopped by the user.",
      activeTaskIds: [],
      updatedAt: nowIso(),
      endedAt: nowIso()
    };
    this.deps.store.upsertProjection(workspacePath, "run", stopped);
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
    const updatedRun = this.deps.policy.incrementBudget({
      ...input.run,
      activeTaskIds: Array.from(new Set([...input.run.activeTaskIds, input.task.id])),
      updatedAt: now
    }, input.task.kind);
    this.deps.store.upsertProjection(input.workspacePath, "task", updatedTask);
    this.deps.store.upsertProjection(input.workspacePath, "run", updatedRun);
    this.deps.store.upsertProjection(input.workspacePath, "worker_run", input.workerRun);
    if (input.lease) {
      this.deps.store.upsertProjection(input.workspacePath, "lease", input.lease);
    }
    this.deps.store.appendEvent(
      input.workspacePath,
      this.deps.store.createEvent({
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
    );
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
        updatedAt: now
      };
      const updatedRun: RunRecord = {
        ...run,
        activeTaskIds: run.activeTaskIds.filter((id) => id !== task.id),
        updatedAt: now
      };
      this.deps.store.upsertProjection(workspacePath, "task", updatedTask);
      this.deps.store.upsertProjection(workspacePath, "run", updatedRun);
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
    this.deps.store.upsertProjection(workspacePath, "task", updatedTask);
    this.deps.store.upsertProjection(workspacePath, "run", updatedRun);
    return updatedTask;
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
    const branch = projection.branches.find((entry) => entry.id === input.task.branchId) ?? null;
    if (!objective) {
      throw new Error(`Objective ${input.task.objectiveId} is missing.`);
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
    this.deps.store.upsertProjection(input.workspacePath, "task", updatedTask);
    this.deps.store.upsertProjection(input.workspacePath, "run", updatedRun);
    this.deps.store.upsertProjection(input.workspacePath, "worker_run", updatedWorkerRun);
    if (input.lease) {
      const released = await this.deps.leaseManager.releaseLease(input.lease);
      this.deps.store.upsertProjection(input.workspacePath, "lease", released);
    }
    this.deps.store.appendEvent(
      input.workspacePath,
      this.deps.store.createEvent({
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
    );

    const updatedBranch = readBranchFromOutcome(input.outcome, branch);
    if (updatedBranch) {
      this.deps.store.upsertProjection(input.workspacePath, "branch", updatedBranch);
    }

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
      case "run_experiment":
        this.applyExperimentOutcome(input.workspacePath, objective, updatedTask, input.outcome);
        break;
      case "evaluate_branch":
        await this.applyEvaluationOutcome(input.workspacePath, objective, updatedRun, updatedTask, input.outcome);
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
      branches.find((entry) => entry.id === objective.activeBranchId) ??
      branches.sort((left, right) => right.score - left.score)[0] ??
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
      sourceIds: [],
      findingIds: [],
      taskIds: [],
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.upsertProjection(workspacePath, "branch", branch);
    this.deps.store.upsertProjection(workspacePath, "objective", {
      ...objective,
      activeBranchId: branch.id,
      branchIds: Array.from(new Set([...objective.branchIds, branch.id])),
      updatedAt: now
    });
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
      const branch = this.createBranch(workspacePath, objective, proposal.title, proposal.hypothesis);
      branchByTitle.set(branch.title.trim().toLowerCase(), branch);
      refreshedObjective = this.deps.store.readProjection(workspacePath, "objective", objective.id) ?? refreshedObjective;
    }

    const projectionAfterBranches = this.deps.store.getProjection(workspacePath);
    const defaultBranch =
      projectionAfterBranches.branches.find((entry) => entry.id === refreshedObjective.activeBranchId) ??
      projectionAfterBranches.branches.find((entry) => entry.objectiveId === objective.id) ??
      null;
    for (const proposal of validated.proposedTasks) {
      const branch =
        (proposal.branchTitle ? branchByTitle.get(proposal.branchTitle.trim().toLowerCase()) : null) ??
        defaultBranch;
      if (!branch) {
        continue;
      }
      const dependencies: TaskDependency[] = proposal.kind === "evaluate_branch" ? [] : [];
      this.enqueueTask({
        workspacePath,
        objective: refreshedObjective,
        run,
        branch,
        title: proposal.title,
        prompt: proposal.prompt,
        kind: proposal.kind,
        payload: this.buildPayloadForProposal(workspacePath, refreshedObjective, branch, proposal),
        dependencies,
        maxAttempts: proposal.kind === "build_change" || proposal.kind === "run_experiment" ? 2 : 1,
        priority: this.deps.policy.buildPriority(proposal, branch)
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
    const nextBranch = this.attachSourcesToBranch(workspacePath, branch, sources);
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
      branch: nextBranch,
      title: `Synthesize evidence for ${nextBranch.title}`,
      prompt: `Read the newly discovered sources and synthesize the strongest evidence for branch "${nextBranch.title}".`,
      kind: "read_synthesize",
      payload: {
        branchId: nextBranch.id,
        sourceIds: sources.map((entry) => entry.id),
        questions: [`What evidence strengthens or weakens the hypothesis "${nextBranch.hypothesis}"?`]
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
    const newFindings = outcome.findings.map((finding) => {
      const source = projection.sources.find(
        (entry) => entry.locator === finding.sourceLocator || entry.canonicalLocator === finding.sourceLocator
      );
      const record = {
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
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      this.deps.store.upsertProjection(workspacePath, "finding", record);
      return record;
    });
    this.deps.store.upsertProjection(workspacePath, "branch", {
      ...branch,
      findingIds: Array.from(new Set([...branch.findingIds, ...newFindings.map((entry) => entry.id)])),
      updatedAt: nowIso()
    });
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
    const payload = task.payload as TaskPayload & { verificationCommands?: string[]; successCriteria?: string[] };
    const verificationCommands = "verificationCommands" in payload ? payload.verificationCommands ?? [] : [];
    if (outcome.status === "completed" && verificationCommands.length > 0) {
      this.enqueueTask({
        workspacePath,
        objective,
        run,
        branch,
        title: `Run verification for ${branch.title}`,
        prompt: verificationCommands.join("\n"),
        kind: "run_experiment",
        payload: {
          branchId: branch.id,
          commands: verificationCommands,
          timeoutMs: 20 * 60_000,
          expectedMetrics: []
        } satisfies ExperimentTaskPayload,
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
      sourceRefs: branch.sourceIds.slice(-5),
      focus: `Evaluate the latest code change for branch "${branch.title}".`
    });
  }

  private applyExperimentOutcome(workspacePath: string, objective: ObjectiveRecord, task: TaskRecord, outcome: TaskOutcome) {
    const run = this.deps.store.readProjection(workspacePath, "run", task.runId);
    const branch = this.deps.store.readProjection(workspacePath, "branch", task.branchId);
    if (!run || !branch || !outcome.experimentManifest) {
      return;
    }

    const now = nowIso();
    const experiment: ExperimentRecord = {
      id: createId("exp"),
      objectiveId: objective.id,
      branchId: branch.id,
      taskId: task.id,
      status: outcome.status,
      summary: outcome.summary,
      manifestRef: outcome.artifactRefs.find((entry) => entry.kind === "manifest"),
      stdoutRef: outcome.artifactRefs.find((entry) => entry.kind === "stdout"),
      stderrRef: outcome.artifactRefs.find((entry) => entry.kind === "stderr"),
      patchArtifactRef: outcome.artifactRefs.find((entry) => entry.kind === "patch"),
      changedFiles: outcome.changedFiles,
      metrics: outcome.metrics,
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.upsertProjection(workspacePath, "experiment", experiment);
    const metricRefs: string[] = [];
    for (const metric of outcome.metrics) {
      const record: MetricRecord = {
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
      };
      this.deps.store.upsertProjection(workspacePath, "metric", record);
      metricRefs.push(record.id);
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
      experimentIds: [experiment.id],
      metricRefs,
      sourceRefs: branch.sourceIds.slice(-5),
      focus: `Evaluate the latest experiment results for branch "${branch.title}".`
    });
  }

  private async applyEvaluationOutcome(workspacePath: string, objective: ObjectiveRecord, run: RunRecord, task: TaskRecord, outcome: TaskOutcome) {
    const branch = this.deps.store.readProjection(workspacePath, "branch", task.branchId);
    if (!branch || !outcome.evaluation) {
      return;
    }

    const now = nowIso();
    const evaluation: EvaluationRecord = {
      id: createId("eval"),
      objectiveId: objective.id,
      branchId: branch.id,
      taskId: task.id,
      verdict: outcome.evaluation.verdict,
      scoreDelta: outcome.evaluation.scoreDelta,
      summary: outcome.evaluation.summary,
      rationale: outcome.evaluation.rationale,
      followupPrompt: outcome.evaluation.followupPrompt,
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.upsertProjection(workspacePath, "evaluation", evaluation);
    const subjectTaskId = (task.payload as EvaluateTaskPayload).subjectTaskId;
    const subjectTask = this.deps.store.readProjection(workspacePath, "task", subjectTaskId);
    const nextBranch: BranchRecord = {
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
    this.deps.store.upsertProjection(workspacePath, "branch", nextBranch);
    this.deps.store.upsertProjection(workspacePath, "task", {
      ...task,
      evaluationId: evaluation.id,
      updatedAt: now
    });

    if (evaluation.verdict === "continue" || evaluation.verdict === "complete") {
      const patchRef = subjectTask?.artifactRefs?.find((entry) => entry.kind === "patch");
      if (subjectTask?.kind === "build_change" && patchRef?.path) {
        const promotion = await this.deps.leaseManager.promotePatchArtifact(workspacePath, patchRef.path).catch((error) => ({
          promotionStatus: "failed" as const,
          promotionError: error instanceof Error ? error.message : String(error)
        }));
        if (promotion.promotionStatus === "promoted") {
          this.deps.store.upsertProjection(workspacePath, "branch", {
            ...nextBranch,
            promotionHeadCommit: nextBranch.headCommit,
            updatedAt: nowIso()
          });
        }
      }
    }

    if (evaluation.verdict === "complete") {
      this.deps.store.upsertProjection(workspacePath, "objective", {
        ...objective,
        status: "completed",
        summary: evaluation.summary,
        updatedAt: now
      });
      this.deps.store.upsertProjection(workspacePath, "run", {
        ...run,
        status: "completed",
        stopReason: undefined,
        updatedAt: now,
        endedAt: now
      });
      return;
    }

    if (evaluation.followupPrompt && run.status === "active") {
      this.enqueueTask({
        workspacePath,
        objective,
        run,
        branch: nextBranch,
        title: `Follow up ${nextBranch.title}`,
        prompt: evaluation.followupPrompt,
        kind: "discover",
        payload: {
          branchId: nextBranch.id,
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
      baselineRefs: [],
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
      maxAttempts: 1
    });
  }

  private buildPayloadForProposal(workspacePath: string, objective: ObjectiveRecord, branch: BranchRecord, proposal: TaskProposal): TaskPayload {
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
          sourceIds: proposal.sourceIds?.length ? proposal.sourceIds : branch.sourceIds.slice(-6),
          questions: proposal.questions?.length ? proposal.questions : [proposal.prompt]
        };
      case "build_change":
        return {
          branchId: branch.id,
          goal: proposal.prompt,
          constraints: [],
          verificationCommands: proposal.verificationCommands ?? [],
          successCriteria: proposal.successRubric.length > 0 ? proposal.successRubric : objective.successCriteria
        };
      case "run_experiment":
        return {
          branchId: branch.id,
          commands: proposal.commands?.length ? proposal.commands : [proposal.prompt],
          timeoutMs: 20 * 60_000,
          expectedMetrics: []
        };
      case "evaluate_branch": {
        const projection = this.deps.store.getProjection(workspacePath);
        const subjectTask =
          projection.tasks
            .filter((entry) => entry.branchId === branch.id && entry.status === "completed")
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
        return {
          branchId: branch.id,
          subjectTaskId: subjectTask?.id ?? createId("task_missing"),
          subjectTaskStatus: subjectTask?.status === "completed" ? "completed" : "failed",
          workerRunId: subjectTask?.workerRunId,
          patchArtifactRef: subjectTask?.artifactRefs?.find((entry) => entry.kind === "patch"),
          changedFiles: subjectTask?.changedFiles ?? [],
          experimentResultIds: [],
          metricRefs: [],
          sourceRefs: branch.sourceIds.slice(-5),
          successCriteria: objective.successCriteria,
          baselineRefs: [],
          focus: proposal.prompt
        };
      }
    }
    throw new Error(`Unsupported proposal kind: ${String(proposal.kind)}`);
  }

  private enqueueTask(input: {
    workspacePath: string;
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
  }) {
    const now = nowIso();
    const task: TaskRecord = {
      id: createId("task"),
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
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.upsertProjection(input.workspacePath, "task", task);
    this.deps.store.upsertProjection(input.workspacePath, "branch", {
      ...input.branch,
      taskIds: Array.from(new Set([...input.branch.taskIds, task.id])),
      updatedAt: now
    });
    this.deps.store.appendEvent(
      input.workspacePath,
      this.deps.store.createEvent({
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
    );
    return task;
  }

  private createBranch(workspacePath: string, objective: ObjectiveRecord, title: string, hypothesis: string) {
    const now = nowIso();
    const branch: BranchRecord = {
      id: createId("br"),
      objectiveId: objective.id,
      title: title.trim(),
      hypothesis: hypothesis.trim(),
      status: "candidate",
      score: 0.55,
      sourceIds: [],
      findingIds: [],
      taskIds: [],
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.upsertProjection(workspacePath, "branch", branch);
    this.deps.store.upsertProjection(workspacePath, "objective", {
      ...objective,
      branchIds: Array.from(new Set([...objective.branchIds, branch.id])),
      updatedAt: now
    });
    return branch;
  }

  private attachSourcesToBranch(workspacePath: string, branch: BranchRecord, sources: SourceRecord[]) {
    const updated: BranchRecord = {
      ...branch,
      sourceIds: Array.from(new Set([...branch.sourceIds, ...sources.map((entry) => entry.id)])),
      updatedAt: nowIso()
    };
    this.deps.store.upsertProjection(workspacePath, "branch", updated);
    return updated;
  }
}

function defaultRunBudget(): RunBudget {
  return {
    planning: 6,
    discovery: 12,
    build: 6,
    experiment: 6,
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

function resolveObjective(objectives: ObjectiveRecord[], objectiveId?: string) {
  if (objectiveId) {
    return objectives.find((entry) => entry.id === objectiveId) ?? null;
  }
  return [...objectives].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

function summarizeObjective(objective: string) {
  return objective.trim().split(/\s+/).slice(0, 8).join(" ");
}

function readBranchFromOutcome(outcome: TaskOutcome, branch: BranchRecord | null) {
  const maybeBranch =
    outcome.providerMetadata &&
    typeof outcome.providerMetadata === "object" &&
    "branch" in outcome.providerMetadata
      ? (outcome.providerMetadata.branch as BranchRecord | undefined)
      : undefined;
  return maybeBranch ?? branch;
}
