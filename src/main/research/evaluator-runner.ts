import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CommandSpec, ResearchEvaluationVerdict } from "../../shared/types";
import { readTextFileIfExists } from "../services/fs-utils";
import { runCommand } from "../services/process-runner";

export type EvaluatorDecision = {
  verdict: ResearchEvaluationVerdict;
  scoreDelta: number;
  summary: string;
  rationale: string;
  followupPrompt?: string;
};

export type EvaluatorRunResult = {
  command: CommandSpec;
  rawOutput: string;
  decision: EvaluatorDecision;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  timedOut: boolean;
};

export class EvaluatorRunner {
  async evaluate(options: {
    workspacePath: string;
    branchTitle: string;
    workItemTitle: string;
    executionSummary: string;
    runtimeContext: string;
  }): Promise<EvaluatorRunResult> {
    const artifactDir = path.join(options.workspacePath, ".lithium", "research", "evaluator");
    await mkdir(artifactDir, { recursive: true });
    const token = randomUUID();
    const outputPath = path.join(artifactDir, `${token}.output.json`);
    const stdoutPath = path.join(artifactDir, `${token}.stdout.log`);
    const stderrPath = path.join(artifactDir, `${token}.stderr.log`);
    const command = this.buildCommand(options.workspacePath, options, outputPath);
    const result = await runCommand({
      spec: command,
      stdoutPath,
      stderrPath
    });
    const rawOutput =
      (await readTextFileIfExists(outputPath)).trim() ||
      [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();

    return {
      command,
      rawOutput,
      decision: parseEvaluatorDecision(rawOutput),
      ...result
    };
  }

  buildCommand(
    workspacePath: string,
    input: {
      branchTitle: string;
      workItemTitle: string;
      executionSummary: string;
      runtimeContext: string;
    },
    outputPath: string
  ): CommandSpec {
    return {
      command: "codex",
      args: [
        "exec",
        "-c",
        'model_reasoning_effort="high"',
        "--model",
        "gpt-5.4",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--output-last-message",
        outputPath,
        this.composePrompt(input)
      ],
      cwd: workspacePath
    };
  }

  composePrompt(input: {
    branchTitle: string;
    workItemTitle: string;
    executionSummary: string;
    runtimeContext: string;
  }) {
    return [
      "You are the evaluator for a headless research engine.",
      "Return only one JSON object with verdict, scoreDelta, summary, rationale, and optional followupPrompt.",
      "verdict must be continue|kill|pivot|complete.",
      "",
      `BRANCH: ${input.branchTitle}`,
      `WORK_ITEM: ${input.workItemTitle}`,
      `EXECUTION_SUMMARY: ${input.executionSummary}`,
      "",
      "RUNTIME_CONTEXT:",
      input.runtimeContext.trim()
    ].join("\n");
  }
}

export function parseEvaluatorDecision(rawOutput: string): EvaluatorDecision {
  const parsed = tryParseJson(rawOutput);

  if (!parsed || typeof parsed !== "object") {
    return {
      verdict: "continue",
      scoreDelta: 0,
      summary: "Evaluation fell back to the default heuristic.",
      rationale: "The evaluator output was not valid JSON."
    };
  }

  const payload = parsed as Record<string, unknown>;
  const verdict =
    typeof payload.verdict === "string" && /^(continue|kill|pivot|complete)$/.test(payload.verdict)
      ? (payload.verdict as ResearchEvaluationVerdict)
      : "continue";

  return {
    verdict,
    scoreDelta: Number.isFinite(payload.scoreDelta) ? Number(payload.scoreDelta) : 0,
    summary:
      typeof payload.summary === "string" ? payload.summary.trim() || "Evaluated the latest work item." : "Evaluated the latest work item.",
    rationale:
      typeof payload.rationale === "string" ? payload.rationale.trim() || "No additional rationale provided." : "No additional rationale provided.",
    followupPrompt: typeof payload.followupPrompt === "string" ? payload.followupPrompt.trim() || undefined : undefined
  };
}

function tryParseJson(rawOutput: string) {
  const trimmed = rawOutput.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start < 0 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
