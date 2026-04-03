import path from "node:path";
import type {
  LithiumHandoff,
  OracleModel,
  OracleThinkingTime,
  ResearchIsolationMode,
  ResearchWorkItemExecutor,
  ResearchWorkItemKind,
  ResearchWorkItemRecord
} from "../../shared/types";
import { parseOracleOutput } from "../services/protocol";
import { OracleRunner } from "../services/oracle-runner";
import { buildProjectPaths } from "../services/workspace-layout";
import { RecordStore } from "../services/record-store";

type OraclePoolDependencies = {
  oracleRunner?: Pick<OracleRunner, "consult">;
  model?: OracleModel;
  browserThinkingTime?: OracleThinkingTime;
};

export type OraclePlannerResult = {
  handoff: LithiumHandoff;
  rawOutput: string;
  oracleSessionSlug: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
};

export type OracleResearchResult = OraclePlannerResult;

export class OracleWorkerPool {
  private readonly records = new RecordStore();
  private readonly oracleRunner: Pick<OracleRunner, "consult">;
  private readonly model: OracleModel;
  private readonly browserThinkingTime: OracleThinkingTime;

  constructor(deps: OraclePoolDependencies = {}) {
    this.oracleRunner = deps.oracleRunner ?? new OracleRunner();
    this.model = deps.model ?? "gpt-5.4-pro";
    this.browserThinkingTime = deps.browserThinkingTime ?? "extended";
  }

  async runPlannerTask(input: {
    workspacePath: string;
    runId: string;
    objectiveTitle: string;
    objectiveSummary: string;
    branchTitle?: string;
    runtimeContext: string;
    workItem: ResearchWorkItemRecord;
  }): Promise<OraclePlannerResult> {
    return await this.runOracleTask({
      workspacePath: input.workspacePath,
      runId: input.runId,
      workItem: input.workItem,
      prompt: buildOraclePlannerPrompt(input)
    });
  }

  async runResearchTask(input: {
    workspacePath: string;
    runId: string;
    objectiveTitle: string;
    objectiveSummary: string;
    branchTitle: string;
    runtimeContext: string;
    workItem: ResearchWorkItemRecord;
  }): Promise<OracleResearchResult> {
    return await this.runOracleTask({
      workspacePath: input.workspacePath,
      runId: input.runId,
      workItem: input.workItem,
      prompt: buildOracleResearchPrompt(input)
    });
  }

  private async runOracleTask(input: {
    workspacePath: string;
    runId: string;
    workItem: ResearchWorkItemRecord;
    prompt: string;
  }) {
    const paths = buildProjectPaths(input.workspacePath);
    const slug = buildOracleSessionSlug(input.runId, input.workItem);
    const stdoutPath = path.join(paths.researchOracleSessionsDir, `${slug}.stdout.log`);
    const stderrPath = path.join(paths.researchOracleSessionsDir, `${slug}.stderr.log`);
    const outputPath = path.join(paths.researchOracleSessionsDir, `${slug}.output.txt`);

    const result = await this.oracleRunner.consult({
      workspacePath: input.workspacePath,
      prompt: input.prompt,
      model: this.model,
      browserThinkingTime: this.browserThinkingTime,
      files: [],
      stdoutPath,
      stderrPath,
      outputPath,
      slug,
      strategistSessionReady: true
    });
    const rawOutput = result.outputText || result.stdout || result.stderr;
    const handoff = parseOracleOutput(rawOutput);

    await this.records.writeJson(path.join(paths.researchOracleSessionsDir, `${slug}.json`), {
      slug,
      runId: input.runId,
      workItemId: input.workItem.id,
      executor: input.workItem.executor,
      stdoutPath,
      stderrPath,
      outputPath,
      model: this.model,
      createdAt: result.startedAt,
      updatedAt: result.endedAt,
      status: result.exitCode === 0 ? "completed" : "failed"
    });

    return {
      handoff,
      rawOutput,
      oracleSessionSlug: slug,
      stdoutPath,
      stderrPath,
      outputPath
    };
  }
}

function buildOracleSessionSlug(runId: string, workItem: ResearchWorkItemRecord) {
  const lane = workItem.executor === "oracle-planner" ? "planner" : "research";
  return `oracle-${lane}-${runId.toLowerCase()}-${workItem.id.toLowerCase()}`;
}

function buildOraclePlannerPrompt(input: {
  objectiveTitle: string;
  objectiveSummary: string;
  branchTitle?: string;
  runtimeContext: string;
  workItem: ResearchWorkItemRecord;
}) {
  return [
    "You are the planner for a headless research engine.",
    "Return a strategist handoff with the exact marker LITHIUM_HANDOFF followed by one JSON object.",
    "The JSON must include: summary, rationale, proposedBranches, researchWorkItems.",
    "Each proposed branch needs title and hypothesis.",
    "Each researchWorkItem needs title, prompt, kind, executor, optional isolation, optional branchTitle.",
    "Allowed kind values: deep-research, code-edit, experiment, evaluation.",
    "Allowed executor values: oracle-research, builder-edit, experiment-run, evaluator.",
    "Allowed isolation values: none, worktree.",
    "Keep the queue small: propose at most 3 work items.",
    "",
    `OBJECTIVE_TITLE: ${input.objectiveTitle}`,
    `OBJECTIVE_SUMMARY: ${input.objectiveSummary}`,
    input.branchTitle ? `ACTIVE_BRANCH: ${input.branchTitle}` : "",
    `PLANNER_TASK: ${input.workItem.prompt}`,
    "",
    "RUNTIME_CONTEXT:",
    input.runtimeContext.trim()
  ]
    .filter(Boolean)
    .join("\n");
}

function buildOracleResearchPrompt(input: {
  objectiveTitle: string;
  objectiveSummary: string;
  branchTitle: string;
  runtimeContext: string;
  workItem: ResearchWorkItemRecord;
}) {
  return [
    "You are the parallel strategist researcher for a headless research engine.",
    "Return a strategist handoff with the exact marker LITHIUM_HANDOFF followed by one JSON object.",
    "The JSON must include: summary, rationale, risks, runActions, openQuestions.",
    "Optional keys: proposedBranches, researchWorkItems.",
    "Do not write prose outside the handoff marker.",
    "",
    `OBJECTIVE_TITLE: ${input.objectiveTitle}`,
    `OBJECTIVE_SUMMARY: ${input.objectiveSummary}`,
    `BRANCH: ${input.branchTitle}`,
    `RESEARCH_TASK: ${input.workItem.prompt}`,
    "",
    "RUNTIME_CONTEXT:",
    input.runtimeContext.trim()
  ]
    .filter(Boolean)
    .join("\n");
}

export function normalizeSuggestedExecutor(
  kind: ResearchWorkItemKind,
  executor?: string,
  isolation?: string
): {
  executor: ResearchWorkItemExecutor;
  isolation: ResearchIsolationMode;
} {
  if (executor === "oracle-research") {
    return { executor, isolation: "none" };
  }

  if (executor === "builder-edit") {
    return { executor, isolation: isolation === "none" ? "none" : "worktree" };
  }

  if (executor === "experiment-run") {
    return { executor, isolation: "worktree" };
  }

  if (executor === "evaluator") {
    return { executor, isolation: "none" };
  }

  switch (kind) {
    case "deep-research":
      return { executor: "oracle-research", isolation: "none" };
    case "code-edit":
      return { executor: "builder-edit", isolation: "worktree" };
    case "experiment":
      return { executor: "experiment-run", isolation: "worktree" };
    case "evaluation":
    default:
      return { executor: "evaluator", isolation: "none" };
  }
}
