import { describe, expect, it } from "vitest";
import type { RunRecord, TaskRecord } from "../../shared/types";
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

    const selected = policy.selectRunnableTasks({
      run,
      tasks: [task],
      branches: [],
      activeTasks: []
    });

    expect(selected).toHaveLength(0);
  });
});

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
