import path from "node:path";
import type {
  DiscoverSourceSpec,
  LithiumHandoff,
  OracleModel,
  OracleThinkingTime,
  ResearchWorkItemRecord
} from "../../shared/types";
import { parseMarkedJsonPayload, parseOracleOutput } from "../services/protocol";
import { OracleRunner } from "../services/oracle-runner";
import { buildProjectPaths } from "../services/workspace-layout";

type OraclePoolDependencies = {
  oracleRunner?: Pick<OracleRunner, "consult" | "startConsult">;
  model?: OracleModel;
  browserThinkingTime?: OracleThinkingTime;
};

export type OracleTaskSession<Result> = {
  oracleSessionSlug: string;
  terminate: (signal?: NodeJS.Signals) => void;
  result: Promise<Result>;
};

export type OraclePlannerResult = {
  handoff: LithiumHandoff;
  oracleSessionSlug: string;
  rawOutput: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
};

export type OracleDiscoverResult = {
  summary: string;
  sources: DiscoverSourceSpec[];
  oracleSessionSlug: string;
  rawOutput: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
};

export type OracleSynthesisResult = {
  summary: string;
  findings: Array<{
    summary: string;
    detail?: string;
    sourceLocator: string;
    citationText?: string;
  }>;
  oracleSessionSlug: string;
  rawOutput: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
};

export class OracleWorkerPool {
  private readonly oracleRunner: Pick<OracleRunner, "consult" | "startConsult">;
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
    activeBranchTitle?: string;
    runtimeContext: string;
    task: ResearchWorkItemRecord;
  }): Promise<OraclePlannerResult> {
    return await (await this.startPlannerTask(input)).result;
  }

  async startPlannerTask(input: {
    workspacePath: string;
    runId: string;
    objectiveTitle: string;
    objectiveSummary: string;
    activeBranchTitle?: string;
    runtimeContext: string;
    task: ResearchWorkItemRecord;
  }): Promise<OracleTaskSession<OraclePlannerResult>> {
    const response = await this.startOracleTask({
      workspacePath: input.workspacePath,
      runId: input.runId,
      task: input.task,
      lane: "plan",
      prompt: buildPlannerPrompt(input),
      files: []
    });

    return {
      oracleSessionSlug: response.oracleSessionSlug,
      terminate: response.terminate,
      result: response.result.then((payload) => ({
        handoff: parseOracleOutput(payload.rawOutput),
        oracleSessionSlug: payload.oracleSessionSlug,
        rawOutput: payload.rawOutput,
        stdoutPath: payload.stdoutPath,
        stderrPath: payload.stderrPath,
        outputPath: payload.outputPath
      }))
    };
  }

  async runDiscoverTask(input: {
    workspacePath: string;
    runId: string;
    objectiveTitle: string;
    branchTitle: string;
    runtimeContext: string;
    task: ResearchWorkItemRecord;
  }): Promise<OracleDiscoverResult> {
    return await (await this.startDiscoverTask(input)).result;
  }

  async startDiscoverTask(input: {
    workspacePath: string;
    runId: string;
    objectiveTitle: string;
    branchTitle: string;
    runtimeContext: string;
    task: ResearchWorkItemRecord;
  }): Promise<OracleTaskSession<OracleDiscoverResult>> {
    const response = await this.startOracleTask({
      workspacePath: input.workspacePath,
      runId: input.runId,
      task: input.task,
      lane: "discover",
      prompt: buildDiscoverPrompt(input),
      files: []
    });

    return {
      oracleSessionSlug: response.oracleSessionSlug,
      terminate: response.terminate,
      result: response.result.then((payload) => {
        const parsed = toRecord(parseMarkedJsonPayload(payload.rawOutput, "LITHIUM_HANDOFF"));
        const sources = Array.isArray(parsed.sources)
          ? parsed.sources.flatMap((entry) => normalizeDiscoveredSource(entry))
          : [];

        return {
          summary: readString(parsed.summary) || payload.rawOutput.replace(/\s+/g, " ").trim().slice(0, 180),
          sources,
          oracleSessionSlug: payload.oracleSessionSlug,
          rawOutput: payload.rawOutput,
          stdoutPath: payload.stdoutPath,
          stderrPath: payload.stderrPath,
          outputPath: payload.outputPath
        };
      })
    };
  }

  async runReadSynthesisTask(input: {
    workspacePath: string;
    runId: string;
    objectiveTitle: string;
    branchTitle: string;
    runtimeContext: string;
    task: ResearchWorkItemRecord;
    files: string[];
  }): Promise<OracleSynthesisResult> {
    return await (await this.startReadSynthesisTask(input)).result;
  }

  async startReadSynthesisTask(input: {
    workspacePath: string;
    runId: string;
    objectiveTitle: string;
    branchTitle: string;
    runtimeContext: string;
    task: ResearchWorkItemRecord;
    files: string[];
  }): Promise<OracleTaskSession<OracleSynthesisResult>> {
    const response = await this.startOracleTask({
      workspacePath: input.workspacePath,
      runId: input.runId,
      task: input.task,
      lane: "read",
      prompt: buildReadPrompt(input),
      files: input.files
    });

    return {
      oracleSessionSlug: response.oracleSessionSlug,
      terminate: response.terminate,
      result: response.result.then((payload) => {
        const parsed = toRecord(parseMarkedJsonPayload(payload.rawOutput, "LITHIUM_HANDOFF"));
        const findings = Array.isArray(parsed.findings)
          ? parsed.findings.flatMap((entry) => {
              const record = toRecord(entry);
              const summary = readString(record.summary);
              const sourceLocator = readString(record.source_locator, record.sourceLocator);
              if (!summary || !sourceLocator) {
                return [];
              }
              return [
                {
                  summary,
                  detail: readString(record.detail),
                  sourceLocator,
                  citationText: readString(record.citation_text, record.citationText)
                }
              ];
            })
          : [];

        return {
          summary: readString(parsed.summary) || payload.rawOutput.replace(/\s+/g, " ").trim().slice(0, 180),
          findings,
          oracleSessionSlug: payload.oracleSessionSlug,
          rawOutput: payload.rawOutput,
          stdoutPath: payload.stdoutPath,
          stderrPath: payload.stderrPath,
          outputPath: payload.outputPath
        };
      })
    };
  }

  private async startOracleTask(input: {
    workspacePath: string;
    runId: string;
    task: ResearchWorkItemRecord;
    lane: "plan" | "discover" | "read";
    prompt: string;
    files: string[];
  }) {
    const paths = buildProjectPaths(input.workspacePath);
    const slug = `oracle-${input.lane}-${input.runId.toLowerCase()}-${input.task.id.toLowerCase()}`;
    const stdoutPath = path.join(paths.oracleSessionsDir, `${slug}.stdout.log`);
    const stderrPath = path.join(paths.oracleSessionsDir, `${slug}.stderr.log`);
    const outputPath = path.join(paths.oracleSessionsDir, `${slug}.output.txt`);
    const session = await this.oracleRunner.startConsult({
      workspacePath: input.workspacePath,
      prompt: input.prompt,
      model: this.model,
      browserThinkingTime: this.browserThinkingTime,
      files: input.files,
      stdoutPath,
      stderrPath,
      outputPath,
      slug,
      oracleSessionReady: true
    });

    return {
      oracleSessionSlug: slug,
      terminate: session.terminate,
      result: session.result.then((result) => ({
        oracleSessionSlug: slug,
        rawOutput: result.outputText || result.stdout || result.stderr,
        stdoutPath,
        stderrPath,
        outputPath
      }))
    };
  }
}

function buildPlannerPrompt(input: {
  objectiveTitle: string;
  objectiveSummary: string;
  activeBranchTitle?: string;
  runtimeContext: string;
  task: ResearchWorkItemRecord;
}) {
  return [
    "You are the planner for Lithium V3.",
    "Return LITHIUM_HANDOFF followed by one JSON object.",
    "The JSON must include: summary, rationale, proposedBranches, researchWorkItems.",
    "Each proposedBranch needs title and hypothesis.",
    "Each researchWorkItem needs title, prompt, kind, executor, optional branchTitle, optional isolation.",
    "Allowed kind values: discover, read_synthesize, build_change, run_experiment, evaluate_branch.",
    "Allowed executor values: discoverer, reader-synthesizer, builder, experimenter, evaluator.",
    "Allowed isolation values: none, worktree.",
    "Keep the plan bounded: propose at most 4 work items.",
    "",
    `OBJECTIVE_TITLE: ${input.objectiveTitle}`,
    `OBJECTIVE_SUMMARY: ${input.objectiveSummary}`,
    input.activeBranchTitle ? `ACTIVE_BRANCH: ${input.activeBranchTitle}` : "",
    `PLANNER_TASK: ${input.task.prompt}`,
    "",
    "RUNTIME_CONTEXT:",
    input.runtimeContext.trim()
  ]
    .filter(Boolean)
    .join("\n");
}

function buildDiscoverPrompt(input: {
  objectiveTitle: string;
  branchTitle: string;
  runtimeContext: string;
  task: ResearchWorkItemRecord;
}) {
  return [
    "You are the discoverer for Lithium V3.",
    "Use browser research as needed and return only LITHIUM_HANDOFF plus one JSON object.",
    "The JSON must include: summary and sources.",
    "Each source must include: locator, title, kind, summary, optional excerpt, optional citation_text.",
    "Allowed kind values: paper, repo, web.",
    "",
    `OBJECTIVE_TITLE: ${input.objectiveTitle}`,
    `BRANCH: ${input.branchTitle}`,
    `DISCOVER_TASK: ${input.task.prompt}`,
    "",
    "RUNTIME_CONTEXT:",
    input.runtimeContext.trim()
  ].join("\n");
}

function buildReadPrompt(input: {
  objectiveTitle: string;
  branchTitle: string;
  runtimeContext: string;
  task: ResearchWorkItemRecord;
}) {
  return [
    "You are the reader-synthesizer for Lithium V3.",
    "You may rely on the attached files when present.",
    "Return only LITHIUM_HANDOFF plus one JSON object.",
    "The JSON must include: summary and findings.",
    "Each finding must include: summary, source_locator, optional detail, optional citation_text.",
    "",
    `OBJECTIVE_TITLE: ${input.objectiveTitle}`,
    `BRANCH: ${input.branchTitle}`,
    `READ_TASK: ${input.task.prompt}`,
    "",
    "RUNTIME_CONTEXT:",
    input.runtimeContext.trim()
  ].join("\n");
}

function normalizeDiscoveredSource(value: unknown): DiscoverSourceSpec[] {
  const record = toRecord(value);
  const locator = readString(record.locator);
  const title = readString(record.title);
  const kind = readString(record.kind);

  if (!locator || !title || !kind || !/^(paper|repo|web)$/.test(kind)) {
    return [];
  }

  return [
    {
      locator,
      title,
      kind: kind as DiscoverSourceSpec["kind"],
      summary: readString(record.summary) || title,
      excerpt: readString(record.excerpt),
      citationText: readString(record.citation_text, record.citationText),
      branchTitle: readString(record.branch_title, record.branchTitle)
    }
  ];
}

function toRecord(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}
