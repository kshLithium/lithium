import { describe, expect, it } from "vitest";
import type { BranchRecord, RunRecord, TaskRecord } from "../../shared/types";
import { PolicyEngine, dependenciesSatisfied } from "./policy-engine";

describe("PolicyEngine", () => {
  it("honors success and terminal dependency conditions", () => {
    const completedTask = createTask({
      id: "task_success",
      status: "completed"
    });
    const failedTask = createTask({
      id: "task_failed",
      status: "failed"
    });
    const child = createTask({
      id: "child",
      dependencies: [
        { taskId: "task_success", on: "success" },
        { taskId: "task_failed", on: "terminal" }
      ]
    });

    expect(dependenciesSatisfied([completedTask, failedTask, child], child)).toBe(true);
  });

  it("blocks dispatch when build budget is exhausted", () => {
    const policy = new PolicyEngine();
    const run: RunRecord = {
      id: "run_1",
      objectiveId: "obj_1",
      status: "active",
      budget: {
        planning: 1,
        discovery: 1,
        build: 0,
        experiment: 1,
        evaluation: 1,
        wallClockMs: 1000,
        maxBranches: 3
      },
      budgetUsage: {
        planning: 0,
        discovery: 0,
        build: 0,
        experiment: 0,
        evaluation: 0,
        startedAt: new Date().toISOString()
      },
      activeTaskIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const task = createTask({
      id: "task_build",
      kind: "build_change"
    });

    const selected = policy.reserveRunnableTasks({
      run,
      tasks: [task],
      branches: [],
      activeTasks: []
    });

    expect(selected).toHaveLength(0);
  });

  it("greedily reserves executor slots and branch write locks", () => {
    const policy = new PolicyEngine();
    const run = createRun();
    const branches = [createBranch({ id: "br_1" }), createBranch({ id: "br_2" })];
    const strategistA = createTask({
      id: "plan_a",
      kind: "discover",
      executor: "strategist",
      priority: priority(3.2)
    });
    const strategistB = createTask({
      id: "plan_b",
      kind: "read_synthesize",
      executor: "strategist",
      priority: priority(2.8)
    });
    const buildA = createTask({
      id: "build_a",
      kind: "build_change",
      branchId: "br_1",
      executor: "builder",
      priority: priority(4.2)
    });
    const verifySameBranch = createTask({
      id: "verify_a",
      kind: "verify_change",
      branchId: "br_1",
      executor: "experimenter",
      priority: priority(4.0),
      payload: { branchId: "br_1", experimentSpecId: "spec_1" }
    });
    const verifyOtherBranch = createTask({
      id: "verify_b",
      kind: "verify_change",
      branchId: "br_2",
      executor: "experimenter",
      priority: priority(3.9),
      payload: { branchId: "br_2", experimentSpecId: "spec_2" }
    });

    const selected = policy.reserveRunnableTasks({
      run,
      tasks: [strategistA, strategistB, buildA, verifySameBranch, verifyOtherBranch],
      branches,
      activeTasks: []
    });

    expect(selected.map((entry) => entry.id)).toEqual(["build_a", "verify_b", "plan_a"]);
  });

  it("blocks branch actions behind a pending evaluation and on terminal branches", () => {
    const policy = new PolicyEngine();
    const run = createRun();
    const branches = [
      createBranch({ id: "br_active", status: "active" }),
      createBranch({ id: "br_killed", status: "killed" })
    ];
    const pendingEvaluation = createTask({
      id: "eval_pending",
      kind: "evaluate_branch",
      branchId: "br_active",
      executor: "evaluator",
      priority: priority(5)
    });
    const blockedDiscover = createTask({
      id: "discover_blocked",
      kind: "discover",
      branchId: "br_active",
      executor: "strategist",
      priority: priority(3.1)
    });
    const blockedBuild = createTask({
      id: "build_blocked",
      kind: "build_change",
      branchId: "br_active",
      executor: "builder",
      priority: priority(3.2)
    });
    const killedBranchTask = createTask({
      id: "discover_killed",
      kind: "discover",
      branchId: "br_killed",
      executor: "strategist",
      priority: priority(4.1)
    });

    const selected = policy.reserveRunnableTasks({
      run,
      tasks: [pendingEvaluation, blockedDiscover, blockedBuild, killedBranchTask],
      branches,
      activeTasks: []
    });

    expect(selected.map((entry) => entry.id)).toEqual(["eval_pending"]);
  });
});

function createRun(): RunRecord {
  const now = new Date().toISOString();
  return {
    id: "run_1",
    objectiveId: "obj_1",
    status: "active",
    budget: {
      planning: 4,
      discovery: 4,
      build: 4,
      experiment: 4,
      evaluation: 4,
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
    updatedAt: now
  };
}

function createBranch(input: Partial<BranchRecord> & Pick<BranchRecord, "id">): BranchRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    objectiveId: input.objectiveId ?? "obj_1",
    title: input.title ?? input.id,
    hypothesis: input.hypothesis ?? input.id,
    status: input.status ?? "active",
    score: input.score ?? 0.5,
    findingIds: input.findingIds ?? [],
    taskIds: input.taskIds ?? [],
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  };
}

function createTask(input: Partial<TaskRecord> & Pick<TaskRecord, "id">): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    objectiveId: input.objectiveId ?? "obj_1",
    branchId: input.branchId ?? "br_1",
    runId: input.runId ?? "run_1",
    kind: input.kind ?? "discover",
    executor: input.executor ?? "strategist",
    status: input.status ?? "pending",
    title: input.title ?? input.id,
    prompt: input.prompt ?? input.id,
    payload: input.payload ?? { branchId: "br_1", goal: "discover", maxResults: 3 },
    dependencies: input.dependencies ?? [],
    priority: input.priority ?? {
      objectiveAlignment: 0.5,
      expectedInfoGain: 0.5,
      feasibility: 0.5,
      estimatedCost: 0.5,
      evidenceStrength: 0.5,
      duplicationPenalty: 0,
      total: 1.5
    },
    attemptCount: input.attemptCount ?? 0,
    maxAttempts: input.maxAttempts ?? 1,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  };
}

function priority(total: number) {
  return {
    objectiveAlignment: 0.7,
    expectedInfoGain: 0.7,
    feasibility: 0.7,
    estimatedCost: 0.3,
    evidenceStrength: 0.5,
    duplicationPenalty: 0,
    total
  };
}
