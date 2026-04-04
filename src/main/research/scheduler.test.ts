import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchBranchRecord, ResearchObjectiveRecord, ResearchRunRecord } from "../../shared/types";
import { ResearchScheduler } from "./scheduler";
import { ResearchStateStore } from "./state-store";
import { createTaskRecord } from "./task-contracts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe("ResearchScheduler", () => {
  it("uses edge-trigger replanning instead of endlessly enqueueing planners", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-scheduler-"));
    tempDirs.push(workspacePath);
    const stateStore = new ResearchStateStore();
    const scheduler = new ResearchScheduler({ stateStore });
    const project = await stateStore.initWorkspace(workspacePath);
    const now = new Date().toISOString();
    const objective: ResearchObjectiveRecord = {
      id: "RO001",
      title: "Benchmark objective",
      objective: "Advance the benchmark branch.",
      summary: "Advance the benchmark branch.",
      status: "active",
      successCriteria: ["Improve metric."],
      activeBranchId: "RB001",
      activeRunId: "RR001",
      sourceIds: [],
      branchIds: ["RB001"],
      createdAt: now,
      updatedAt: now
    };
    const branch: ResearchBranchRecord = {
      id: "RB001",
      objectiveId: objective.id,
      title: "Primary branch",
      hypothesis: "The primary branch can improve the benchmark.",
      status: "active",
      score: 0.6,
      evidenceIds: [],
      sourceIds: [],
      findingIds: [],
      workItemIds: [],
      createdAt: now,
      updatedAt: now,
      lastUpdatedAt: now
    };
    const run: ResearchRunRecord = {
      id: "RR001",
      objectiveId: objective.id,
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
      dispatchPaused: false,
      lastPlanAt: now,
      lastPlanSourceCount: 0,
      lastPlanCompletedCount: 0,
      lastPlanBranchScore: 0.6,
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };
    await stateStore.writeProject(workspacePath, {
      ...(project!),
      activeObjectiveId: objective.id,
      updatedAt: now
    });
    await stateStore.writeObjective(workspacePath, objective);
    await stateStore.writeBranch(workspacePath, branch);
    await stateStore.writeRun(workspacePath, run);

    const discoverOne = createTaskRecord({
      id: "RT001",
      objectiveId: objective.id,
      branchId: branch.id,
      title: "Discover one",
      prompt: "Find evidence",
      kind: "discover"
    });
    const discoverTwo = createTaskRecord({
      id: "RT002",
      objectiveId: objective.id,
      branchId: branch.id,
      title: "Discover two",
      prompt: "Find more evidence",
      kind: "discover"
    });
    await stateStore.writeWorkItem(workspacePath, discoverOne);
    await stateStore.writeWorkItem(workspacePath, discoverTwo);

    await scheduler.ensureQueue({ workspacePath, objective, run });
    let state = await stateStore.readState(workspacePath, objective.id);
    expect(state.workItems.filter((task) => task.kind === "plan")).toHaveLength(0);

    for (let index = 0; index < 3; index += 1) {
      await stateStore.writeSource(workspacePath, {
        id: `RS00${index + 1}`,
        objectiveId: objective.id,
        branchId: branch.id,
        kind: "web",
        title: `Source ${index + 1}`,
        locator: `https://example.com/${index + 1}`,
        provenance: "oracle-session:test",
        summary: "summary",
        createdAt: now,
        updatedAt: now
      });
    }

    await scheduler.ensureQueue({ workspacePath, objective, run });
    await scheduler.ensureQueue({ workspacePath, objective, run });
    state = await stateStore.readState(workspacePath, objective.id);
    expect(state.workItems.filter((task) => task.kind === "plan")).toHaveLength(1);
  });
});
