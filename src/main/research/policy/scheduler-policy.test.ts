import { describe, expect, it } from "vitest";
import { buildResearchPriorityScore, rankRunnableWorkItems } from "./scheduler-policy";
import type { ResearchBranchRecord, ResearchWorkItemRecord } from "../../../shared/types";

describe("scheduler-policy", () => {
  it("builds a stable composite priority score", () => {
    const score = buildResearchPriorityScore({
      kind: "experiment",
      objectiveAlignment: 0.9,
      expectedInformationGain: 0.8,
      feasibility: 0.7,
      estimatedCost: 0.4,
      branchFreshness: 0.6,
      duplicationPenalty: 0.1,
      reproducibilityPriority: 0.95
    });

    expect(score.total).toBeGreaterThan(5);
    expect(score.reproducibilityPriority).toBe(0.95);
  });

  it("ranks pending work items by total score before creation order", () => {
    const branches = new Map<string, ResearchBranchRecord>([
      [
        "RB001",
        {
          id: "RB001",
          objectiveId: "RO001",
          threadId: "TH001",
          title: "Primary branch",
          hypothesis: "Test the primary idea.",
          status: "active",
          score: 0.7,
          evidenceIds: [],
          sourceIds: [],
          findingIds: [],
          workItemIds: [],
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
          lastUpdatedAt: "2026-04-04T00:00:00.000Z"
        }
      ]
    ]);
    const workItems: ResearchWorkItemRecord[] = [
      {
        id: "RW001",
        objectiveId: "RO001",
        branchId: "RB001",
        threadId: "TH001",
        kind: "deep-research",
        lane: "research",
        title: "Read one more repo deeply",
        prompt: "Inspect a promising repo.",
        status: "pending",
        executionMode: "sync",
        priorityScore: buildResearchPriorityScore({ kind: "deep-research" }),
        sourceIds: [],
        dependsOnIds: [],
        createdAt: "2026-04-04T00:00:01.000Z",
        updatedAt: "2026-04-04T00:00:01.000Z"
      },
      {
        id: "RW002",
        objectiveId: "RO001",
        branchId: "RB001",
        threadId: "TH001",
        kind: "experiment",
        lane: "experiment",
        title: "Run the next isolated experiment",
        prompt: "Execute the next benchmark.",
        status: "pending",
        executionMode: "isolated",
        priorityScore: buildResearchPriorityScore({ kind: "experiment" }),
        sourceIds: [],
        dependsOnIds: [],
        createdAt: "2026-04-04T00:00:02.000Z",
        updatedAt: "2026-04-04T00:00:02.000Z"
      }
    ];

    const ranked = rankRunnableWorkItems(workItems, branches);

    expect(ranked[0]?.id).toBe("RW002");
    expect(ranked[1]?.id).toBe("RW001");
  });
});
