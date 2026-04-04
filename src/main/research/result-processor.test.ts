import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchBranchRecord, ResearchObjectiveRecord, ResearchRunRecord, ResearchWorkItemRecord } from "../../shared/types";
import { ArtifactService } from "./artifact-service";
import { ResearchResultProcessor } from "./result-processor";
import { ResearchStateStore } from "./state-store";
import { createTaskRecord } from "./task-contracts";
import type { WorkerGateway } from "./worker-gateway";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe("ResearchResultProcessor", () => {
  it("turns discovered sources into source records and a follow-up read task", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-result-processor-"));
    tempDirs.push(workspacePath);
    const stateStore = new ResearchStateStore();
    await stateStore.initWorkspace(workspacePath);
    const artifactService = new ArtifactService({ stateStore });
    const processor = new ResearchResultProcessor({
      stateStore,
      artifactService,
      workerGateway: {
        promotePatchArtifact: vi.fn().mockResolvedValue({ promotionStatus: "skipped" })
      } as unknown as WorkerGateway
    });
    const now = new Date().toISOString();
    const objective: ResearchObjectiveRecord = {
      id: "RO001",
      title: "Evidence objective",
      objective: "Gather stronger evidence.",
      summary: "Gather stronger evidence.",
      status: "active",
      successCriteria: ["Collect cited evidence."],
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
      hypothesis: "A better source pass will help.",
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
      activeWorkItemIds: ["RT001"],
      oracleSessionSlugs: [],
      worktreeLeases: [],
      dispatchPaused: false,
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };
    const task: ResearchWorkItemRecord = createTaskRecord({
      id: "RT001",
      objectiveId: objective.id,
      branchId: branch.id,
      title: "Discover evidence",
      prompt: "Find the next strong sources.",
      kind: "discover"
    });

    await stateStore.writeObjective(workspacePath, objective);
    await stateStore.writeBranch(workspacePath, branch);
    await stateStore.writeRun(workspacePath, run);
    await stateStore.writeWorkItem(workspacePath, {
      ...task,
      status: "running",
      startedAt: now,
      updatedAt: now
    });

    await processor.processCompletion({
      workspacePath,
      objectiveId: objective.id,
      runId: run.id,
      taskId: task.id,
      result: {
        summary: "Found one relevant paper.",
        status: "completed",
        changedFiles: [],
        risks: [],
        openQuestions: [],
        runActions: [],
        discoveredSources: [
          {
            locator: "https://example.com/paper",
            title: "Example paper",
            kind: "web",
            summary: "A useful source."
          }
        ]
      }
    });

    const state = await stateStore.readState(workspacePath, objective.id);
    expect(state.sources).toHaveLength(1);
    expect(state.sources[0]?.locator).toBe("https://example.com/paper");
    expect(state.workItems.some((entry) => entry.kind === "read_synthesize" && entry.status === "pending")).toBe(true);
  });
});
