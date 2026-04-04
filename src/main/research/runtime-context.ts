import type {
  ResearchObjectiveRecord,
  ResearchRunRecord
} from "../../shared/types";
import type { ResearchStateSnapshot } from "./state-store";

export function buildResearchRuntimeContext(input: {
  state: ResearchStateSnapshot;
  objective: ResearchObjectiveRecord;
  run: ResearchRunRecord;
}) {
  const { state, objective, run } = input;
  const activeBranch =
    state.branches.find((branch) => branch.id === objective.activeBranchId) ??
    [...state.branches].sort((left, right) => right.score - left.score)[0] ??
    null;
  const pending = state.workItems.filter((task) => task.status === "pending").slice(0, 6);
  const running = state.workItems.filter((task) => task.status === "running").slice(0, 4);
  const recentSources = state.sources.slice(0, 5);
  const recentFindings = state.findings.slice(0, 5);
  const recentExperiments = state.experimentResults.slice(0, 3);
  const recentEvaluations = state.evaluations.slice(0, 3);

  return [
    "OBJECTIVE",
    `- id: ${objective.id}`,
    `- title: ${objective.title}`,
    `- summary: ${objective.summary}`,
    `- success_criteria: ${objective.successCriteria.join(" | ")}`,
    "",
    "RUN",
    `- id: ${run.id}`,
    `- status: ${run.status}`,
    `- budget_completed: ${run.slotBudget.completedWorkItems}/${run.slotBudget.maxTotalWorkItems}`,
    "",
    "BRANCHES",
    ...state.branches.slice(0, 5).map((branch) => {
      const focus = branch.id === activeBranch?.id ? " active" : "";
      return `- ${branch.id}${focus}: ${branch.title} [${branch.status}] score=${branch.score.toFixed(3)}`;
    }),
    "",
    "QUEUE",
    ...(pending.length
      ? pending.map((task) => `- pending ${task.id}: ${task.executor ?? task.kind} :: ${task.title}`)
      : ["- none"]),
    ...(running.length
      ? running.map((task) => `- running ${task.id}: ${task.executor ?? task.kind} :: ${task.title}`)
      : []),
    "",
    "RECENT_SOURCES",
    ...(recentSources.length
      ? recentSources.map((source) => `- ${source.kind}: ${source.title} @ ${source.locator}`)
      : ["- none"]),
    "",
    "RECENT_FINDINGS",
    ...(recentFindings.length ? recentFindings.map((finding) => `- ${finding.summary}`) : ["- none"]),
    "",
    "RECENT_EXPERIMENTS",
    ...(recentExperiments.length
      ? recentExperiments.map((experiment) => `- ${experiment.status}: ${experiment.summary}`)
      : ["- none"]),
    "",
    "RECENT_EVALUATIONS",
    ...(recentEvaluations.length
      ? recentEvaluations.map((evaluation) => `- ${evaluation.verdict}: ${evaluation.summary}`)
      : ["- none"])
  ].join("\n");
}
