import type {
  EvaluationRecord,
  ResearchBranchRecord,
  ResearchFindingRecord,
  ResearchObjectiveRecord,
  ResearchProjectionRecord,
  ResearchRunRecord,
  ResearchWorkItemRecord
} from "../../shared/types";

export class ChatProjectionService {
  buildProjection(input: {
    projectionId: string;
    objective: ResearchObjectiveRecord;
    branches: ResearchBranchRecord[];
    findings: ResearchFindingRecord[];
    workItems: ResearchWorkItemRecord[];
    evaluations: EvaluationRecord[];
    run?: ResearchRunRecord | null;
  }): ResearchProjectionRecord {
    const now = new Date().toISOString();
    const activeBranch =
      input.branches.find((branch) => branch.id === input.objective.activeBranchId) ??
      input.branches[0] ??
      null;
    const pendingItems = input.workItems.filter((workItem) => workItem.status === "pending");
    const runningItems = input.workItems.filter((workItem) => workItem.status === "running");
    const latestEvaluation = input.evaluations[0] ?? null;
    const latestFinding = input.findings[0] ?? null;
    const latestPromotedPatch =
      input.workItems.find((workItem) => workItem.promotionStatus === "promoted") ?? null;
    const currentFocus =
      pendingItems[0]?.title ||
      latestEvaluation?.summary ||
      latestFinding?.summary ||
      input.objective.summary ||
      input.objective.objective;
    const status = deriveProjectionStatus(input.objective.status, activeBranch?.status, pendingItems.length, input.run?.status);
    const topNextActions = pendingItems.slice(0, 3).map((workItem) => workItem.title);
    const recentEvidence = input.findings.slice(0, 3).map((finding) => finding.summary);

    return {
      id: input.projectionId,
      objectiveId: input.objective.id,
      objectiveTitle: input.objective.title,
      status,
      summary: `${input.objective.title}: ${currentFocus}`,
      currentFocus,
      activeBranchTitle: activeBranch?.title || "none",
      queueDepth: pendingItems.length,
      topNextActions,
      recentEvidence,
      latestEvaluationSummary: latestEvaluation?.summary,
      activeRunId: input.run?.id,
      activeRunStatus: input.run?.status,
      blockedReason: input.run?.blockedReason,
      activeSlots: runningItems.map((workItem) => `${workItem.executor ?? "builder"}:${workItem.title}`),
      lastBranchSwitch:
        activeBranch?.id && activeBranch.id !== input.objective.activeBranchId
          ? `${activeBranch.title}`
          : activeBranch?.title,
      lastPatchPromotion: latestPromotedPatch
        ? `${latestPromotedPatch.title} -> ${latestPromotedPatch.patchArtifactPath ?? "applied"}`
        : undefined,
      createdAt: now,
      updatedAt: now,
      lastUpdatedAt: now
    };
  }
}

function deriveProjectionStatus(
  objectiveStatus: ResearchObjectiveRecord["status"],
  branchStatus: ResearchBranchRecord["status"] | undefined,
  pendingCount: number,
  runStatus?: ResearchRunRecord["status"]
): ResearchProjectionRecord["status"] {
  if (runStatus === "blocked") {
    return "blocked";
  }

  if (runStatus === "paused") {
    return "paused";
  }

  if (runStatus === "completed") {
    return "completed";
  }

  if (objectiveStatus === "completed") {
    return "completed";
  }

  if (objectiveStatus === "paused") {
    return "paused";
  }

  if (branchStatus === "blocked" || branchStatus === "killed") {
    return "blocked";
  }

  if (objectiveStatus === "active" || pendingCount > 0) {
    return "running";
  }

  return "idle";
}
