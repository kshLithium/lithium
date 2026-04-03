import type {
  ResearchBranchRecord,
  ResearchPriorityScore,
  ResearchWorkItemKind,
  ResearchWorkItemRecord
} from "../../../shared/types";

const KIND_BASELINES: Record<
  ResearchWorkItemKind,
  Omit<ResearchPriorityScore, "total">
> = {
  planner: {
    objectiveAlignment: 0.8,
    expectedInformationGain: 0.9,
    feasibility: 0.8,
    estimatedCost: 0.2,
    branchFreshness: 0.7,
    duplicationPenalty: 0,
    reproducibilityPriority: 0.5
  },
  "deep-research": {
    objectiveAlignment: 0.7,
    expectedInformationGain: 0.95,
    feasibility: 0.55,
    estimatedCost: 0.7,
    branchFreshness: 0.8,
    duplicationPenalty: 0.05,
    reproducibilityPriority: 0.45
  },
  "code-edit": {
    objectiveAlignment: 0.85,
    expectedInformationGain: 0.65,
    feasibility: 0.85,
    estimatedCost: 0.45,
    branchFreshness: 0.65,
    duplicationPenalty: 0.08,
    reproducibilityPriority: 0.7
  },
  experiment: {
    objectiveAlignment: 0.9,
    expectedInformationGain: 0.88,
    feasibility: 0.7,
    estimatedCost: 0.6,
    branchFreshness: 0.75,
    duplicationPenalty: 0.08,
    reproducibilityPriority: 0.95
  },
  evaluation: {
    objectiveAlignment: 0.82,
    expectedInformationGain: 0.78,
    feasibility: 0.92,
    estimatedCost: 0.25,
    branchFreshness: 0.7,
    duplicationPenalty: 0.02,
    reproducibilityPriority: 0.92
  }
};

export function buildResearchPriorityScore(
  input: Partial<Omit<ResearchPriorityScore, "total">> & {
    kind?: ResearchWorkItemKind;
  } = {}
): ResearchPriorityScore {
  const base = input.kind ? KIND_BASELINES[input.kind] : KIND_BASELINES.planner;
  const score = {
    objectiveAlignment: clamp01(input.objectiveAlignment ?? base.objectiveAlignment),
    expectedInformationGain: clamp01(input.expectedInformationGain ?? base.expectedInformationGain),
    feasibility: clamp01(input.feasibility ?? base.feasibility),
    estimatedCost: clamp01(input.estimatedCost ?? base.estimatedCost),
    branchFreshness: clamp01(input.branchFreshness ?? base.branchFreshness),
    duplicationPenalty: clamp01(input.duplicationPenalty ?? base.duplicationPenalty),
    reproducibilityPriority: clamp01(input.reproducibilityPriority ?? base.reproducibilityPriority)
  };

  return {
    ...score,
    total: roundScore(
      score.objectiveAlignment * 3 +
        score.expectedInformationGain * 3 +
        score.feasibility * 2 +
        score.branchFreshness * 1.5 +
        score.reproducibilityPriority * 1.5 -
        score.estimatedCost * 1.5 -
        score.duplicationPenalty * 2
    )
  };
}

export function scoreWorkItemForScheduling(input: {
  workItem: Pick<ResearchWorkItemRecord, "kind" | "title" | "prompt">;
  branch?: Pick<ResearchBranchRecord, "status" | "score" | "updatedAt"> | null;
  duplicatePenalty?: number;
  branchFreshnessOverride?: number;
}) {
  const branchBlocked = input.branch?.status === "blocked" || input.branch?.status === "killed";
  const branchFreshness =
    input.branchFreshnessOverride ??
    (branchBlocked ? 0.2 : input.branch?.score && input.branch.score > 0 ? 0.8 : 0.6);

  return buildResearchPriorityScore({
    kind: input.workItem.kind,
    branchFreshness,
    duplicationPenalty: input.duplicatePenalty ?? 0
  });
}

export function rankRunnableWorkItems(
  workItems: ResearchWorkItemRecord[],
  branchesById: Map<string, ResearchBranchRecord>
) {
  return [...workItems]
    .filter((workItem) => workItem.status === "pending")
    .sort((left, right) => {
      const leftScore =
        left.priorityScore?.total ??
        scoreWorkItemForScheduling({
          workItem: left,
          branch: branchesById.get(left.branchId)
        }).total;
      const rightScore =
        right.priorityScore?.total ??
        scoreWorkItemForScheduling({
          workItem: right,
          branch: branchesById.get(right.branchId)
        }).total;

      return (
        rightScore - leftScore ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
      );
    });
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
