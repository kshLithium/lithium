import type { DecisionRecord, RunRecord } from "../../shared/types";
import { extractFinalSummary } from "./run-artifacts";

export class ManuscriptEngine {
  updateResults(input: { decision?: DecisionRecord; run?: RunRecord }) {
    const { decision, run } = input;

    const runSummary = run?.finalMessage.trim()
      ? extractFinalSummary(run.finalMessage)
      : "No final builder message was captured.";

    return [
      "# Results",
      "",
      `Updated: ${new Date().toISOString()}`,
      "",
      "## Strategist Direction",
      "",
      decision?.summary || "No strategist summary available.",
      "",
      "## Strategic Rationale",
      "",
      decision?.rationale || "No rationale available.",
      "",
      "## Builder Execution",
      "",
      `- Task ID: ${run?.taskId ?? "n/a"}`,
      `- Run ID: ${run?.id ?? "n/a"}`,
      `- Model: ${run?.model ?? "n/a"}`,
      `- Exit code: ${run?.exitCode ?? "unknown"}`,
      `- Status: ${run?.status ?? "pending"}`,
      "",
      "## Builder Summary",
      "",
      runSummary,
      ""
    ].join("\n");
  }
}
