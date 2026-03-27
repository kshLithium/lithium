import type { ChatRouteDecision, CommandSpec } from "../../shared/types";
import { readTextFileIfExists } from "./fs-utils";
import { runCommand } from "./process-runner";
import { parseRouterOutput } from "./protocol";

type RouterRunOptions = {
  workspacePath: string;
  prompt: string;
  activeThreadSummary?: string;
  threadMemory?: string;
  latestDecisionSummary?: string;
  latestTaskPrompt?: string;
  latestRunSummary?: string;
  latestRunStatus?: string;
  automationStatus?: string;
  automationStepSummary?: string;
  automationCheckpointSummary?: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  attachments?: Array<{
    name: string;
    kind: string;
    excerpt?: string;
  }>;
};

export type RouterRunResult = {
  decision: ChatRouteDecision;
  command: CommandSpec;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  rawOutput: string;
};

export class RouterRunner {
  async route(options: RouterRunOptions): Promise<RouterRunResult> {
    const command = this.buildRouteCommand(
      options.workspacePath,
      this.normalizePrompt(options),
      options.outputPath
    );
    const result = await runCommand({
      spec: command,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath
    });
    const rawOutput =
      (await this.readMaybe(options.outputPath)).trim() ||
      [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
    const parsed = parseRouterOutput(rawOutput);
    const decision = parsed
      ? {
          route: parsed.route,
          rewrittenPrompt: parsed.rewrittenPrompt.trim() || options.prompt.trim(),
          reasonShort:
            parsed.reasonShort.trim() ||
            `Router chose ${parsed.route} from the latest chat context.`
        }
      : {
          route: "strategist" as const,
          rewrittenPrompt: options.prompt.trim(),
          reasonShort: "Router output was malformed, so the message fell back to strategist."
        };

    return {
      decision,
      command,
      rawOutput,
      ...result
    };
  }

  buildRouteCommand(workspacePath: string, prompt: string, outputPath: string): CommandSpec {
    return {
      command: "codex",
      args: [
        "exec",
        "-c",
        'model_reasoning_effort="xhigh"',
        "--model",
        "gpt-5.4",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--output-last-message",
        outputPath,
        prompt
      ],
      cwd: workspacePath
    };
  }

  private normalizePrompt(options: RouterRunOptions) {
    const attachments = (options.attachments ?? [])
      .slice(0, 8)
      .map((attachment) => {
        const excerpt = attachment.excerpt?.trim() ? ` excerpt=${JSON.stringify(attachment.excerpt.trim())}` : "";
        return `- ${attachment.name} [${attachment.kind}]${excerpt}`;
      })
      .join("\n");

    return [
      "You are the chat router for this research workspace.",
      "Only choose a lane and rewrite the request. Do not answer the user.",
      "Choose `builder` for concrete workspace work: code edits, debugging, experiments, commands, file creation, or local artifact updates.",
      "Choose `strategist` for research thinking: planning, comparison, literature analysis, idea evaluation, or deciding what to do next.",
      "Choose `mixed` only when the user explicitly wants both a strategic judgment and a concrete workspace change that depends on that judgment.",
      "If analysis is only part of doing the edit, choose `builder`.",
      "For short follow-ups like `continue`, `go ahead`, or `do it`, choose `builder` only when the latest context already contains an executable builder task or unfinished builder run. Otherwise choose `strategist`.",
      "Keep `rewritten_prompt` faithful to the user intent but make it clearer for the chosen lane.",
      "Preserve concrete constraints and evidence in `rewritten_prompt`: filenames, datasets, error strings, metrics, comparison targets, quoted text, and user-imposed limits should not be compressed away.",
      "Return exactly this marker and one JSON object:",
      "LITHIUM_ROUTE",
      '{"route":"strategist|builder|mixed","rewritten_prompt":"...","reason_short":"..."}',
      "Do not use markdown fences.",
      "",
      "THREAD_CONTEXT:",
      `Active thread summary: ${options.activeThreadSummary?.trim() || "None"}`,
      `Thread memory: ${options.threadMemory?.trim() || "None"}`,
      `Latest strategist summary: ${options.latestDecisionSummary?.trim() || "None"}`,
      `Latest builder task: ${options.latestTaskPrompt?.trim() || "None"}`,
      `Latest run summary: ${options.latestRunSummary?.trim() || "None"}`,
      `Latest run status: ${options.latestRunStatus?.trim() || "None"}`,
      `Automation status: ${options.automationStatus?.trim() || "None"}`,
      `Automation step summary: ${options.automationStepSummary?.trim() || "None"}`,
      `Automation checkpoint: ${options.automationCheckpointSummary?.trim() || "None"}`,
      "Attachments:",
      attachments || "- None",
      "",
      `USER_MESSAGE: ${options.prompt.trim()}`
    ].join("\n");
  }

  private async readMaybe(filePath: string) {
    return await readTextFileIfExists(filePath);
  }
}
