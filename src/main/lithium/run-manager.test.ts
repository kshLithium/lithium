import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store";
import { PolicyEngine } from "./policy-engine";
import { RunManager } from "./run-manager";
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
        retryability: "retryable",
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
});

function createRunManager(store: ResearchStore) {
  return new RunManager({
    store,
    policy: new PolicyEngine(),
    sourceIngest: new SourceIngest({
      store,
      artifactStore: new ArtifactStore()
    }),
    leaseManager: new WorkerLeaseManager()
  });
}
