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
});
