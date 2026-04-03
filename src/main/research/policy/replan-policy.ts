import type {
  EvaluationRecord,
  ResearchBranchRecord,
  ResearchSourceRecord,
  ResearchWorkItemRecord
} from "../../../shared/types";

export type ResearchReplanTrigger =
  | "queue-empty"
  | "high-value-source"
  | "failure-boundary"
  | "branch-saturated"
  | "metric-shift"
  | "budget-boundary";

export function collectResearchReplanTriggers(input: {
  runnableQueueDepth: number;
  latestEvaluation?: EvaluationRecord | null;
  latestBranch?: ResearchBranchRecord | null;
  latestSource?: ResearchSourceRecord | null;
  latestWorkItem?: ResearchWorkItemRecord | null;
  budgetBoundary?: boolean;
  metricShift?: boolean;
}) {
  const triggers: ResearchReplanTrigger[] = [];

  if (input.runnableQueueDepth <= 0) {
    triggers.push("queue-empty");
  }

  if (input.latestSource && /paper|repo|web/i.test(input.latestSource.kind)) {
    triggers.push("high-value-source");
  }

  if (
    input.latestEvaluation &&
    (input.latestEvaluation.verdict === "kill" || input.latestEvaluation.verdict === "pivot")
  ) {
    triggers.push("failure-boundary");
  }

  if (input.latestBranch && (input.latestBranch.status === "blocked" || input.latestBranch.status === "pivoted")) {
    triggers.push("branch-saturated");
  }

  if (input.metricShift) {
    triggers.push("metric-shift");
  }

  if (input.budgetBoundary) {
    triggers.push("budget-boundary");
  }

  return Array.from(new Set(triggers));
}

export function shouldReplanResearchQueue(
  input: Parameters<typeof collectResearchReplanTriggers>[0]
) {
  return collectResearchReplanTriggers(input).length > 0;
}
