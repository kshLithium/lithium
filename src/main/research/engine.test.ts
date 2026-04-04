import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchObjectiveRecord, ResearchRunRecord } from "../../shared/types";
import { ResearchEngine } from "./engine";
import { ResearchStateStore } from "./state-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe("ResearchEngine", () => {
  it("creates planner work, dispatches oracle/codex batches, and materializes a projection", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-research-engine-"));
    tempDirs.push(workspacePath);
    const stateStore = new ResearchStateStore();
    await stateStore.initWorkspace(workspacePath);

    const now = "2026-04-04T00:00:00.000Z";
    const objective: ResearchObjectiveRecord = {
      id: "RO001",
      threadId: "RO001",
      title: "Benchmark objective",
      objective: "Find the next reproducible benchmark step.",
      summary: "Find the next reproducible benchmark step.",
      status: "active",
      successCriteria: ["Generate a bounded queue."],
      activeBranchId: "RB001",
      activeRunId: "RR001",
      sourceIds: [],
      branchIds: ["RB001"],
      createdAt: now,
      updatedAt: now
    };
    const run: ResearchRunRecord = {
      id: "RR001",
      objectiveId: "RO001",
      threadId: "RO001",
      status: "active",
      slotBudget: {
        codexSlots: 1,
        oracleSlots: 2,
        maxTotalWorkItems: 12,
        completedWorkItems: 0
      },
      activeWorkItemIds: [],
      oracleSessionSlugs: [],
      worktreeLeases: [],
      createdAt: now,
      updatedAt: now
    };

    await stateStore.writeObjective(workspacePath, objective);
    await stateStore.writeBranch(workspacePath, {
      id: "RB001",
      objectiveId: "RO001",
      threadId: "RO001",
      title: "Primary branch",
      hypothesis: "The next best move is still external research.",
      status: "active",
      score: 0.6,
      evidenceIds: [],
      sourceIds: [],
      findingIds: [],
      workItemIds: [],
      createdAt: now,
      updatedAt: now,
      lastUpdatedAt: now
    });
    await stateStore.writeRun(workspacePath, run);

    const engine = new ResearchEngine({
      stateStore
    });

    const triggers = await engine.ensureRunnableQueue({
      workspacePath,
      objective,
      run,
      runtimeContext: "OBJECTIVE: Benchmark objective"
    });
    const batch = await engine.pickDispatchBatch({
      workspacePath,
      objectiveId: objective.id,
      runId: run.id
    });
    const projection = await engine.materializeProjection(workspacePath, objective.id);

    expect(triggers).toContain("queue-empty");
    expect(batch?.oracleWorkItems[0]?.executor).toBe("oracle-planner");
    expect(projection?.queueDepth).toBeGreaterThan(0);
    expect(projection?.summary).toContain("Benchmark objective");
  });

  it("applies planner handoffs without losing branch, hypothesis, or work item links", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-research-engine-handoff-"));
    tempDirs.push(workspacePath);
    const stateStore = new ResearchStateStore();
    await stateStore.initWorkspace(workspacePath);

    const now = "2026-04-04T00:00:00.000Z";
    const objective: ResearchObjectiveRecord = {
      id: "RO001",
      threadId: "RO001",
      title: "Planner objective",
      objective: "Keep the best branch alive and add bounded work.",
      summary: "Keep the best branch alive and add bounded work.",
      status: "active",
      successCriteria: ["Do not lose planner updates."],
      activeBranchId: "RB001",
      activeRunId: "RR001",
      sourceIds: [],
      branchIds: ["RB001"],
      createdAt: now,
      updatedAt: now
    };
    const run: ResearchRunRecord = {
      id: "RR001",
      objectiveId: "RO001",
      threadId: "RO001",
      status: "active",
      slotBudget: {
        codexSlots: 2,
        oracleSlots: 2,
        maxTotalWorkItems: 12,
        completedWorkItems: 0
      },
      activeWorkItemIds: [],
      oracleSessionSlugs: [],
      worktreeLeases: [],
      createdAt: now,
      updatedAt: now
    };

    await stateStore.writeObjective(workspacePath, objective);
    await stateStore.writeBranch(workspacePath, {
      id: "RB001",
      objectiveId: "RO001",
      threadId: "RO001",
      title: "Primary branch",
      hypothesis: "The baseline branch is still best.",
      status: "active",
      score: 0.7,
      evidenceIds: [],
      sourceIds: [],
      findingIds: [],
      workItemIds: [],
      createdAt: now,
      updatedAt: now,
      lastUpdatedAt: now
    });
    await stateStore.writeHypothesis(workspacePath, {
      id: "RH001",
      objectiveId: "RO001",
      branchId: "RB001",
      threadId: "RO001",
      statement: "The baseline branch is still best.",
      status: "open",
      confidence: 0.5,
      evidenceIds: [],
      createdAt: now,
      updatedAt: now
    });
    await stateStore.writeRun(workspacePath, run);

    const engine = new ResearchEngine({
      stateStore
    });

    await engine.applyPlannerHandoff({
      workspacePath,
      objective,
      run,
      workItem: {
        id: "RW000",
        objectiveId: objective.id,
        branchId: "RB001",
        threadId: objective.threadId,
        kind: "planner",
        lane: "planner",
        executor: "oracle-planner",
        title: "Replan",
        prompt: "Replan",
        status: "completed",
        executionMode: "async",
        isolation: "none",
        priorityScore: {
          objectiveAlignment: 0.8,
          expectedInformationGain: 0.9,
          feasibility: 0.8,
          estimatedCost: 0.2,
          branchFreshness: 0.7,
          duplicationPenalty: 0,
          reproducibilityPriority: 0.5,
          total: 4.9
        },
        sourceIds: [],
        dependsOnIds: [],
        createdAt: now,
        updatedAt: now
      },
      handoff: {
        schemaVersion: "lithium_handoff_v1",
        role: "strategist",
        summary: "Add two candidate branches and bounded work.",
        rationale: "We need more than one branch.",
        files: [],
        risks: [],
        runActions: [],
        successCriteria: [],
        openQuestions: [],
        proposedBranches: [
          {
            title: "Ablation branch",
            hypothesis: "Removing the extra feature will stabilize the metric."
          },
          {
            title: "Source mining branch",
            hypothesis: "External evidence may show a cheaper alternative."
          }
        ],
        researchWorkItems: [
          {
            title: "Run the ablation",
            prompt: "Run the ablation in an isolated worktree.",
            kind: "experiment",
            executor: "experiment-run",
            isolation: "worktree",
            branchTitle: "Ablation branch"
          },
          {
            title: "Inspect the cheaper alternative",
            prompt: "Search for the cheaper alternative.",
            kind: "deep-research",
            executor: "oracle-research",
            isolation: "none",
            branchTitle: "Source mining branch"
          },
          {
            title: "Polish the baseline",
            prompt: "Make the smallest code edit on the baseline branch.",
            kind: "code-edit",
            executor: "builder-edit",
            isolation: "worktree",
            branchTitle: "Primary branch"
          }
        ]
      },
      oracleSessionSlug: "oracle-planner-RR001-RW000"
    });

    const state = await stateStore.readState(workspacePath, objective.id);
    const ablation = state.branches.find((entry) => entry.title === "Ablation branch");
    const sourceMining = state.branches.find((entry) => entry.title === "Source mining branch");
    const primary = state.branches.find((entry) => entry.id === "RB001");

    expect(state.objectives[0]?.branchIds).toEqual(expect.arrayContaining(["RB001", ablation?.id ?? "", sourceMining?.id ?? ""]));
    expect(state.hypotheses).toHaveLength(3);
    expect(ablation?.workItemIds).toHaveLength(1);
    expect(sourceMining?.workItemIds).toHaveLength(1);
    expect(primary?.workItemIds).toHaveLength(1);
    expect(ablation?.nextWorkItemId).toBe(ablation?.workItemIds[0]);
    expect(sourceMining?.nextWorkItemId).toBe(sourceMining?.workItemIds[0]);
  });

  it("uses the configured codex slot budget when dispatching runnable work", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-research-engine-slots-"));
    tempDirs.push(workspacePath);
    const stateStore = new ResearchStateStore();
    await stateStore.initWorkspace(workspacePath);

    const now = "2026-04-04T00:00:00.000Z";
    await stateStore.writeObjective(workspacePath, {
      id: "RO001",
      threadId: "RO001",
      title: "Slot objective",
      objective: "Dispatch two codex work items.",
      summary: "Dispatch two codex work items.",
      status: "active",
      successCriteria: [],
      activeBranchId: "RB001",
      activeRunId: "RR001",
      sourceIds: [],
      branchIds: ["RB001"],
      createdAt: now,
      updatedAt: now
    });
    await stateStore.writeBranch(workspacePath, {
      id: "RB001",
      objectiveId: "RO001",
      threadId: "RO001",
      title: "Primary branch",
      hypothesis: "Two codex slots should be used.",
      status: "active",
      score: 0.8,
      evidenceIds: [],
      sourceIds: [],
      findingIds: [],
      workItemIds: ["RW001", "RW002"],
      createdAt: now,
      updatedAt: now,
      lastUpdatedAt: now
    });
    await stateStore.writeRun(workspacePath, {
      id: "RR001",
      objectiveId: "RO001",
      threadId: "RO001",
      status: "active",
      slotBudget: {
        codexSlots: 2,
        oracleSlots: 1,
        maxTotalWorkItems: 12,
        completedWorkItems: 0
      },
      activeWorkItemIds: [],
      oracleSessionSlugs: [],
      worktreeLeases: [],
      createdAt: now,
      updatedAt: now
    });
    await stateStore.writeWorkItem(workspacePath, {
      id: "RW001",
      objectiveId: "RO001",
      branchId: "RB001",
      threadId: "RO001",
      kind: "code-edit",
      lane: "builder",
      executor: "builder-edit",
      title: "Edit one",
      prompt: "Edit one",
      status: "pending",
      executionMode: "isolated",
      isolation: "worktree",
      priorityScore: {
        objectiveAlignment: 0.9,
        expectedInformationGain: 0.7,
        feasibility: 0.8,
        estimatedCost: 0.4,
        branchFreshness: 0.8,
        duplicationPenalty: 0,
        reproducibilityPriority: 0.7,
        total: 4.9
      },
      sourceIds: [],
      dependsOnIds: [],
      createdAt: now,
      updatedAt: now
    });
    await stateStore.writeWorkItem(workspacePath, {
      id: "RW002",
      objectiveId: "RO001",
      branchId: "RB001",
      threadId: "RO001",
      kind: "experiment",
      lane: "experiment",
      executor: "experiment-run",
      title: "Experiment two",
      prompt: "Experiment two",
      status: "pending",
      executionMode: "isolated",
      isolation: "worktree",
      priorityScore: {
        objectiveAlignment: 0.88,
        expectedInformationGain: 0.85,
        feasibility: 0.7,
        estimatedCost: 0.5,
        branchFreshness: 0.8,
        duplicationPenalty: 0,
        reproducibilityPriority: 0.95,
        total: 5.1
      },
      sourceIds: [],
      dependsOnIds: [],
      createdAt: "2026-04-04T00:00:01.000Z",
      updatedAt: "2026-04-04T00:00:01.000Z"
    });

    const engine = new ResearchEngine({ stateStore });
    const batch = await engine.pickDispatchBatch({
      workspacePath,
      objectiveId: "RO001",
      runId: "RR001"
    });

    expect(batch?.codexWorkItems).toHaveLength(2);
    expect(batch?.codexWorkItems.map((entry) => entry.id)).toEqual(["RW002", "RW001"]);
  });
});
