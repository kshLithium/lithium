import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store";
import { PolicyEngine } from "./policy-engine";
import { effectiveElapsedMs, RunManager } from "./run-manager";
import { SourceIngest } from "./source-ingest";
import { ResearchStore } from "./store";
import { WorkerLeaseManager } from "./worker-lease-manager";

describe("RunManager", () => {
  it("enqueues an artifact-aware evaluation task after a failed build outcome", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-v4-run-"));
    const store = new ResearchStore();
    await store.initializeWorkspace(workspacePath);
    const runManager = createRunManager(store);
    const now = new Date().toISOString();
    const objective = {
      id: "obj_1",
      title: "Objective",
      objective: "Objective",
      summary: "Objective",
      status: "active" as const,
      successCriteria: ["tests stay green"],
      branchIds: ["br_1"],
      activeBranchId: "br_1",
      activeRunId: "run_1",
      createdAt: now,
      updatedAt: now
    };
    const branch = {
      id: "br_1",
      objectiveId: "obj_1",
      title: "Primary branch",
      hypothesis: "Hypothesis",
      status: "active" as const,
      score: 0.5,
      sourceIds: [],
      findingIds: [],
      taskIds: ["task_build"],
      createdAt: now,
      updatedAt: now
    };
    const run = {
      id: "run_1",
      objectiveId: "obj_1",
      status: "active" as const,
      budget: {
        planning: 3,
        discovery: 3,
        build: 3,
        experiment: 3,
        evaluation: 3,
        wallClockMs: 1000,
        maxBranches: 3
      },
      budgetUsage: {
        planning: 0,
        discovery: 0,
        build: 0,
        experiment: 0,
        evaluation: 0,
        startedAt: now
      },
      activeTaskIds: [],
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };
    const buildTask = {
      id: "task_build",
      objectiveId: "obj_1",
      branchId: "br_1",
      runId: "run_1",
      kind: "build_change" as const,
      executor: "builder" as const,
      status: "running" as const,
      title: "Build branch",
      prompt: "Build branch",
      payload: {
        branchId: "br_1",
        goal: "Fix it",
        constraints: [],
        verificationCommands: [],
        successCriteria: ["tests stay green"]
      },
      dependencies: [],
      priority: {
        objectiveAlignment: 0.7,
        expectedInfoGain: 0.6,
        feasibility: 0.5,
        estimatedCost: 0.5,
        evidenceStrength: 0.4,
        duplicationPenalty: 0,
        total: 2.0
      },
      attemptCount: 1,
      maxAttempts: 2,
      workerRunId: "wrk_1",
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };
    const workerRun = {
      id: "wrk_1",
      taskId: "task_build",
      runId: "run_1",
      objectiveId: "obj_1",
      branchId: "br_1",
      provider: "builder" as const,
      command: {
        command: "true",
        args: [],
        cwd: workspacePath
      },
      status: "running" as const,
      pid: null,
      stdoutPath: path.join(workspacePath, "stdout.log"),
      stderrPath: path.join(workspacePath, "stderr.log"),
      outputPath: path.join(workspacePath, "output.log"),
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };

    store.upsertProjection(workspacePath, "objective", objective);
    store.upsertProjection(workspacePath, "branch", branch);
    store.upsertProjection(workspacePath, "run", run);
    store.upsertProjection(workspacePath, "task", buildTask);
    store.upsertProjection(workspacePath, "worker_run", workerRun);

    await runManager.handleTaskOutcome({
      workspacePath,
      task: buildTask,
      run,
      workerRun,
      outcome: {
        status: "failed",
        summary: "Build failed.",
        failureReason: "Compilation error",
        retryability: "needs-human",
        artifactRefs: [],
        changedFiles: ["src/index.ts"],
        metrics: []
      }
    });

    const evaluationTasks = store
      .listProjections(workspacePath, "task")
      .filter((entry) => entry.kind === "evaluate_branch");
    expect(evaluationTasks).toHaveLength(1);
    expect(evaluationTasks[0]?.dependencies).toEqual([{ taskId: "task_build", on: "terminal" }]);
    expect(evaluationTasks[0]?.payload).toMatchObject({
      subjectTaskId: "task_build",
      subjectTaskStatus: "failed",
      changedFiles: ["src/index.ts"]
    });
  });

  it("marks an unrecoverable running task as needs-human", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-v4-recover-"));
    const store = new ResearchStore();
    await store.initializeWorkspace(workspacePath);
    const runManager = createRunManager(store);
    const now = new Date().toISOString();
    const run = {
      id: "run_1",
      objectiveId: "obj_1",
      status: "active" as const,
      budget: {
        planning: 1,
        discovery: 1,
        build: 1,
        experiment: 1,
        evaluation: 1,
        wallClockMs: 1000,
        maxBranches: 1
      },
      budgetUsage: {
        planning: 0,
        discovery: 0,
        build: 0,
        experiment: 0,
        evaluation: 0,
        startedAt: now
      },
      activeTaskIds: ["task_1"],
      createdAt: now,
      updatedAt: now
    };
    const task = {
      id: "task_1",
      objectiveId: "obj_1",
      branchId: "br_1",
      runId: "run_1",
      kind: "discover" as const,
      executor: "strategist" as const,
      status: "running" as const,
      title: "Discover",
      prompt: "Discover",
      payload: {
        branchId: "br_1",
        goal: "Discover",
        maxResults: 3
      },
      dependencies: [],
      priority: {
        objectiveAlignment: 0.7,
        expectedInfoGain: 0.6,
        feasibility: 0.7,
        estimatedCost: 0.2,
        evidenceStrength: 0.2,
        duplicationPenalty: 0,
        total: 2.0
      },
      attemptCount: 1,
      maxAttempts: 1,
      createdAt: now,
      updatedAt: now
    };

    store.upsertProjection(workspacePath, "run", run);
    store.upsertProjection(workspacePath, "task", task);
    await runManager.recoverTask(workspacePath, task, run, "worker disappeared");

    expect(store.readProjection(workspacePath, "task", "task_1")?.status).toBe("needs-human");
    expect(store.readProjection(workspacePath, "run", "run_1")?.status).toBe("needs-human");
  });

  it("hard-pauses active tasks and preserves them as pending work", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-v5-pause-"));
    const store = new ResearchStore();
    await store.initializeWorkspace(workspacePath);
    const runManager = createRunManager(store);
    const now = new Date().toISOString();
    const objective = {
      id: "obj_pause",
      title: "Objective",
      objective: "Objective",
      summary: "Objective",
      status: "active" as const,
      successCriteria: [],
      branchIds: ["br_pause"],
      activeBranchId: "br_pause",
      activeRunId: "run_pause",
      createdAt: now,
      updatedAt: now
    };
    const branch = {
      id: "br_pause",
      objectiveId: "obj_pause",
      title: "Primary branch",
      hypothesis: "Hypothesis",
      status: "active" as const,
      score: 0.5,
      findingIds: [],
      taskIds: ["task_pause"],
      createdAt: now,
      updatedAt: now
    };
    const run = {
      id: "run_pause",
      objectiveId: "obj_pause",
      status: "active" as const,
      budget: {
        planning: 2,
        discovery: 2,
        build: 2,
        experiment: 2,
        evaluation: 2,
        wallClockMs: 1000,
        maxBranches: 2
      },
      budgetUsage: {
        planning: 0,
        discovery: 0,
        build: 0,
        experiment: 0,
        evaluation: 0,
        startedAt: now
      },
      activeTaskIds: ["task_pause"],
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      totalPausedMs: 0
    };
    const task = {
      id: "task_pause",
      objectiveId: "obj_pause",
      branchId: "br_pause",
      runId: "run_pause",
      kind: "discover" as const,
      executor: "strategist" as const,
      status: "running" as const,
      title: "Discover",
      prompt: "Find evidence",
      payload: {
        branchId: "br_pause",
        goal: "Find evidence",
        maxResults: 5
      },
      dependencies: [],
      priority: {
        objectiveAlignment: 0.7,
        expectedInfoGain: 0.7,
        feasibility: 0.7,
        estimatedCost: 0.3,
        evidenceStrength: 0.3,
        duplicationPenalty: 0,
        total: 2.1
      },
      attemptCount: 1,
      maxAttempts: 2,
      workerRunId: "wrk_pause",
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };
    const workerRun = {
      id: "wrk_pause",
      taskId: "task_pause",
      runId: "run_pause",
      objectiveId: "obj_pause",
      branchId: "br_pause",
      provider: "strategist" as const,
      command: {
        command: "true",
        args: [],
        cwd: workspacePath
      },
      status: "running" as const,
      pid: null,
      stdoutPath: path.join(workspacePath, "pause.stdout"),
      stderrPath: path.join(workspacePath, "pause.stderr"),
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };

    store.upsertProjection(workspacePath, "objective", objective);
    store.upsertProjection(workspacePath, "branch", branch);
    store.upsertProjection(workspacePath, "run", run);
    store.upsertProjection(workspacePath, "task", task);
    store.upsertProjection(workspacePath, "worker_run", workerRun);

    await runManager.pauseRun(workspacePath, "obj_pause", "run_pause", [
      {
        task,
        run,
        workerRun,
        branch
      }
    ]);

    expect(store.readProjection(workspacePath, "task", "task_pause")?.status).toBe("pending");
    expect(store.readProjection(workspacePath, "worker_run", "wrk_pause")?.status).toBe("cancelled");
    expect(store.readProjection(workspacePath, "run", "run_pause")?.status).toBe("paused");
    expect(store.readProjection(workspacePath, "run", "run_pause")?.pausedAt).toBeTruthy();
  });

  it("subtracts paused wall-clock time when resuming a run", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-v5-resume-"));
    const store = new ResearchStore();
    await store.initializeWorkspace(workspacePath);
    const runManager = createRunManager(store);
    const now = new Date().toISOString();
    const pausedAt = new Date(Date.now() - 4_000).toISOString();
    const objective = {
      id: "obj_resume",
      title: "Objective",
      objective: "Objective",
      summary: "Objective",
      status: "active" as const,
      successCriteria: [],
      branchIds: ["br_resume"],
      activeBranchId: "br_resume",
      activeRunId: "run_resume",
      createdAt: now,
      updatedAt: now
    };
    const run = {
      id: "run_resume",
      objectiveId: "obj_resume",
      status: "paused" as const,
      budget: {
        planning: 1,
        discovery: 1,
        build: 1,
        experiment: 1,
        evaluation: 1,
        wallClockMs: 10_000,
        maxBranches: 1
      },
      budgetUsage: {
        planning: 0,
        discovery: 0,
        build: 0,
        experiment: 0,
        evaluation: 0,
        startedAt: new Date(Date.now() - 10_000).toISOString()
      },
      activeTaskIds: [],
      stopReason: "Paused by the user.",
      pausedAt,
      totalPausedMs: 1_000,
      createdAt: now,
      updatedAt: now,
      startedAt: new Date(Date.now() - 10_000).toISOString()
    };

    store.upsertProjection(workspacePath, "objective", objective);
    store.upsertProjection(workspacePath, "run", run);

    const resumed = runManager.resumeRun(workspacePath, "obj_resume", "run_resume");

    expect(resumed.status).toBe("active");
    expect((resumed.totalPausedMs ?? 0)).toBeGreaterThanOrEqual(4_000);
    expect(effectiveElapsedMs(resumed)).toBeLessThan(10_000);
  });

  it("enqueues a promotion task after a successful branch evaluation", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-v5-promote-"));
    const store = new ResearchStore();
    await store.initializeWorkspace(workspacePath);
    const runManager = createRunManager(store);
    const now = new Date().toISOString();
    const patchPath = path.join(workspacePath, "candidate.patch");
    const objective = {
      id: "obj_promote",
      title: "Objective",
      objective: "Objective",
      summary: "Objective",
      status: "active" as const,
      successCriteria: [],
      branchIds: ["br_promote"],
      activeBranchId: "br_promote",
      activeRunId: "run_promote",
      createdAt: now,
      updatedAt: now
    };
    const branch = {
      id: "br_promote",
      objectiveId: "obj_promote",
      title: "Primary branch",
      hypothesis: "Hypothesis",
      status: "active" as const,
      score: 0.5,
      findingIds: [],
      taskIds: ["task_build", "task_eval"],
      createdAt: now,
      updatedAt: now
    };
    const run = {
      id: "run_promote",
      objectiveId: "obj_promote",
      status: "active" as const,
      budget: {
        planning: 2,
        discovery: 2,
        build: 2,
        experiment: 2,
        evaluation: 2,
        wallClockMs: 1000,
        maxBranches: 2
      },
      budgetUsage: {
        planning: 0,
        discovery: 0,
        build: 0,
        experiment: 0,
        evaluation: 0,
        startedAt: now
      },
      activeTaskIds: ["task_eval"],
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      totalPausedMs: 0
    };
    const buildTask = {
      id: "task_build",
      objectiveId: "obj_promote",
      branchId: "br_promote",
      runId: "run_promote",
      kind: "build_change" as const,
      executor: "builder" as const,
      status: "completed" as const,
      title: "Build",
      prompt: "Build",
      payload: {
        branchId: "br_promote",
        goal: "Implement",
        constraints: [],
        successCriteria: []
      },
      dependencies: [],
      priority: {
        objectiveAlignment: 0.8,
        expectedInfoGain: 0.7,
        feasibility: 0.7,
        estimatedCost: 0.4,
        evidenceStrength: 0.3,
        duplicationPenalty: 0,
        total: 2.2
      },
      attemptCount: 1,
      maxAttempts: 2,
      artifactRefs: [
        {
          id: "patch_1",
          kind: "patch" as const,
          path: patchPath,
          createdAt: now
        }
      ],
      createdAt: now,
      updatedAt: now,
      completedAt: now
    };
    const evalTask = {
      id: "task_eval",
      objectiveId: "obj_promote",
      branchId: "br_promote",
      runId: "run_promote",
      kind: "evaluate_branch" as const,
      executor: "evaluator" as const,
      status: "running" as const,
      title: "Evaluate",
      prompt: "Evaluate",
      payload: {
        branchId: "br_promote",
        subjectTaskId: "task_build",
        subjectTaskStatus: "completed" as const,
        changedFiles: [],
        experimentResultIds: [],
        metricRefs: [],
        sourceRefs: [],
        successCriteria: [],
        focus: "Evaluate"
      },
      dependencies: [{ taskId: "task_build", on: "terminal" as const }],
      priority: {
        objectiveAlignment: 0.8,
        expectedInfoGain: 0.7,
        feasibility: 0.8,
        estimatedCost: 0.2,
        evidenceStrength: 0.4,
        duplicationPenalty: 0,
        total: 2.5
      },
      attemptCount: 1,
      maxAttempts: 2,
      workerRunId: "wrk_eval",
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };
    const workerRun = {
      id: "wrk_eval",
      taskId: "task_eval",
      runId: "run_promote",
      objectiveId: "obj_promote",
      branchId: "br_promote",
      provider: "evaluator" as const,
      command: {
        command: "true",
        args: [],
        cwd: workspacePath
      },
      status: "running" as const,
      pid: null,
      stdoutPath: path.join(workspacePath, "eval.stdout"),
      stderrPath: path.join(workspacePath, "eval.stderr"),
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };

    store.upsertProjection(workspacePath, "objective", objective);
    store.upsertProjection(workspacePath, "branch", branch);
    store.upsertProjection(workspacePath, "run", run);
    store.upsertProjection(workspacePath, "task", buildTask);
    store.upsertProjection(workspacePath, "task", evalTask);
    store.upsertProjection(workspacePath, "worker_run", workerRun);

    await runManager.handleTaskOutcome({
      workspacePath,
      task: evalTask,
      run,
      workerRun,
      outcome: {
        status: "completed",
        summary: "Evaluation passed.",
        retryability: "needs-human",
        artifactRefs: [],
        changedFiles: [],
        metrics: [],
        evaluation: {
          verdict: "continue",
          gateStatus: "passed",
          scoreDelta: 0.2,
          summary: "Looks good.",
          rationale: "All gates passed."
        }
      }
    });

    const promotionTasks = store
      .listProjections(workspacePath, "task")
      .filter((entry) => entry.kind === "promote_patch");
    expect(promotionTasks).toHaveLength(1);
    expect(promotionTasks[0]?.payload).toMatchObject({
      sourceTaskId: "task_build"
    });
  });
});

function createRunManager(store: ResearchStore) {
  const artifactStore = new ArtifactStore();
  return new RunManager({
    store,
    policy: new PolicyEngine(),
    sourceIngest: new SourceIngest({
      store,
      artifactStore
    }),
    leaseManager: new WorkerLeaseManager(),
    artifactStore
  });
}
