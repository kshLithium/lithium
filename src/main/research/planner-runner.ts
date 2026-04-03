import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CommandSpec,
  ResearchWorkItemExecutionMode,
  ResearchWorkItemKind,
  ResearchWorkItemLane
} from "../../shared/types";
import { readTextFileIfExists } from "../services/fs-utils";
import { runCommand } from "../services/process-runner";

export type PlannerSuggestedBranch = {
  title: string;
  hypothesis: string;
};

export type PlannerSuggestedWorkItem = {
  title: string;
  prompt: string;
  kind: ResearchWorkItemKind;
  lane: ResearchWorkItemLane;
  executionMode?: ResearchWorkItemExecutionMode;
  branchTitle?: string;
};

export type PlannerDecision = {
  summary: string;
  rationale: string;
  branches: PlannerSuggestedBranch[];
  workItems: PlannerSuggestedWorkItem[];
};

export type PlannerRunResult = {
  command: CommandSpec;
  rawOutput: string;
  decision: PlannerDecision;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  timedOut: boolean;
};

export class PlannerRunner {
  async plan(options: {
    workspacePath: string;
    objective: string;
    runtimeContext: string;
  }): Promise<PlannerRunResult> {
    const artifactDir = path.join(options.workspacePath, ".lithium", "research", "planner");
    await mkdir(artifactDir, { recursive: true });
    const token = randomUUID();
    const outputPath = path.join(artifactDir, `${token}.output.json`);
    const stdoutPath = path.join(artifactDir, `${token}.stdout.log`);
    const stderrPath = path.join(artifactDir, `${token}.stderr.log`);
    const command = this.buildCommand(options.workspacePath, options.objective, options.runtimeContext, outputPath);
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
      decision: parsePlannerDecision(rawOutput),
      ...result
    };
  }

  buildCommand(workspacePath: string, objective: string, runtimeContext: string, outputPath: string): CommandSpec {
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
        this.composePrompt(objective, runtimeContext)
      ],
      cwd: workspacePath
    };
  }

  composePrompt(objective: string, runtimeContext: string) {
    return [
      "You are the planner for a headless research engine.",
      "Return only one JSON object with keys summary, rationale, branches, workItems.",
      "Each branch must have title and hypothesis.",
      "Each work item must have title, prompt, kind, lane, and optional executionMode and branchTitle.",
      "Prefer a small queue of 1-3 high-value work items.",
      "Use kind planner|deep-research|code-edit|experiment|evaluation.",
      "Use lane planner|research|builder|experiment|evaluator.",
      "",
      `OBJECTIVE: ${objective.trim()}`,
      "",
      "RUNTIME_CONTEXT:",
      runtimeContext.trim()
    ].join("\n");
  }
}

export function parsePlannerDecision(rawOutput: string): PlannerDecision {
  const parsed = tryParseJson(rawOutput);

  if (!parsed || typeof parsed !== "object") {
    return {
      summary: "Planning fell back to a heuristic queue.",
      rationale: "The planner output was not valid JSON.",
      branches: [],
      workItems: []
    };
  }

  const payload = parsed as Record<string, unknown>;
  const branches = Array.isArray(payload.branches)
    ? payload.branches.flatMap((entry) => normalizePlannerBranch(entry))
    : [];
  const workItems = Array.isArray(payload.workItems)
    ? payload.workItems.flatMap((entry) => normalizePlannerWorkItem(entry))
    : [];

  return {
    summary: typeof payload.summary === "string" ? payload.summary.trim() || "Planned the next research queue." : "Planned the next research queue.",
    rationale:
      typeof payload.rationale === "string"
        ? payload.rationale.trim() || "Planner returned a minimal queue."
        : "Planner returned a minimal queue.",
    branches,
    workItems
  };
}

function normalizePlannerBranch(entry: unknown): PlannerSuggestedBranch[] {
  if (!entry || typeof entry !== "object") {
    return [];
  }

  const record = entry as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const hypothesis = typeof record.hypothesis === "string" ? record.hypothesis.trim() : "";

  if (!title || !hypothesis) {
    return [];
  }

  return [{ title, hypothesis }];
}

function normalizePlannerWorkItem(entry: unknown): PlannerSuggestedWorkItem[] {
  if (!entry || typeof entry !== "object") {
    return [];
  }

  const record = entry as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  const kind =
    typeof record.kind === "string" && /^(planner|deep-research|code-edit|experiment|evaluation)$/.test(record.kind)
      ? (record.kind as ResearchWorkItemKind)
      : null;
  const lane =
    typeof record.lane === "string" && /^(planner|research|builder|experiment|evaluator)$/.test(record.lane)
      ? (record.lane as ResearchWorkItemLane)
      : null;
  const executionMode =
    typeof record.executionMode === "string" && /^(sync|async|isolated)$/.test(record.executionMode)
      ? (record.executionMode as ResearchWorkItemExecutionMode)
      : undefined;
  const branchTitle = typeof record.branchTitle === "string" ? record.branchTitle.trim() : undefined;

  if (!title || !prompt || !kind || !lane) {
    return [];
  }

  return [
    {
      title,
      prompt,
      kind,
      lane,
      executionMode,
      branchTitle
    }
  ];
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
