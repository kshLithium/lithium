import type {
  DiscoveredSourceSpec,
  EvaluationDecisionInput,
  ExperimentSpecInput,
  PlanStepProposal,
  PlannerProposal,
  SynthesizedFindingSpec
} from "../../shared/types";
import { clamp01, normalizeWhitespace } from "../lithium/utils";

export const LITHIUM_PLAN_MARKER = "LITHIUM_PLAN";
export const LITHIUM_DISCOVER_MARKER = "LITHIUM_DISCOVER";
export const LITHIUM_READ_MARKER = "LITHIUM_READ";
export const LITHIUM_STATUS_MARKER = "LITHIUM_STATUS";
export const LITHIUM_EVALUATION_MARKER = "LITHIUM_EVALUATION";

export type BuilderStatusPayload = {
  machineSummary: string;
  result: "success" | "partial" | "failed";
  files: string[];
  risks: string[];
  runActions: string[];
  successCriteria: string[];
  openQuestions: string[];
};

export type StructuredParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: string;
    };

export function parsePlannerOutput(rawOutput: string): StructuredParseResult<PlannerProposal> {
  const parsed = parseMarkedJsonPayload(rawOutput, LITHIUM_PLAN_MARKER);
  if (!parsed.ok) {
    return parsed;
  }

  const record = toRecord(parsed.value);
  const summary = readString(record.summary) || fallbackSummary(rawOutput, LITHIUM_PLAN_MARKER);
  const rationale = readString(record.rationale);
  if (!summary || !rationale) {
    return {
      ok: false,
      error: "Planner output is missing required summary or rationale fields."
    };
  }

  return {
    ok: true,
    value: {
      summary,
      rationale,
      proposedBranches: readPlannerBranches(record.proposed_branches, record.proposedBranches),
      proposedTasks: readPlanStepProposals(record.proposed_tasks, record.proposedTasks)
    }
  };
}

export function parseDiscoverOutput(rawOutput: string): StructuredParseResult<{
  summary: string;
  sources: DiscoveredSourceSpec[];
}> {
  const parsed = parseMarkedJsonPayload(rawOutput, LITHIUM_DISCOVER_MARKER);
  if (!parsed.ok) {
    return parsed;
  }

  const record = toRecord(parsed.value);
  const summary = readString(record.summary) || fallbackSummary(rawOutput, LITHIUM_DISCOVER_MARKER);
  const sources = readDiscoveredSources(record.sources);
  if (!summary) {
    return {
      ok: false,
      error: "Discovery output is missing a summary."
    };
  }
  return {
    ok: true,
    value: {
      summary,
      sources
    }
  };
}

export function parseReadOutput(rawOutput: string): StructuredParseResult<{
  summary: string;
  findings: SynthesizedFindingSpec[];
}> {
  const parsed = parseMarkedJsonPayload(rawOutput, LITHIUM_READ_MARKER);
  if (!parsed.ok) {
    return parsed;
  }

  const record = toRecord(parsed.value);
  const summary = readString(record.summary) || fallbackSummary(rawOutput, LITHIUM_READ_MARKER);
  const findings = readFindings(record.findings);
  if (!summary) {
    return {
      ok: false,
      error: "Read/synthesize output is missing a summary."
    };
  }
  return {
    ok: true,
    value: {
      summary,
      findings
    }
  };
}

export function parseBuilderStatus(rawOutput: string): StructuredParseResult<BuilderStatusPayload> {
  const parsed = parseMarkedJsonPayload(rawOutput, LITHIUM_STATUS_MARKER);
  if (!parsed.ok) {
    return parsed;
  }

  const record = toRecord(parsed.value);
  const machineSummary = readString(record.machine_summary, record.machineSummary, record.summary);
  const result = readResult(record.result);
  if (!machineSummary || !result) {
    return {
      ok: false,
      error: "Builder status payload is missing machine_summary or has an invalid result."
    };
  }

  return {
    ok: true,
    value: {
      machineSummary,
      result,
      files: readStringList(record.files),
      risks: readStringList(record.risks),
      runActions: readStringList(record.run_actions, record.runActions),
      successCriteria: readStringList(record.success_criteria, record.successCriteria),
      openQuestions: readStringList(record.open_questions, record.openQuestions)
    }
  };
}

export function parseEvaluatorDecision(rawOutput: string): StructuredParseResult<EvaluationDecisionInput> {
  const parsed = parseMarkedJsonPayload(rawOutput, LITHIUM_EVALUATION_MARKER, true);
  if (!parsed.ok) {
    return parsed;
  }

  const record = toRecord(parsed.value);
  const verdict = readVerdict(record.verdict);
  const gateStatus = readGateStatus(record.gateStatus, record.gate_status);
  const summary = readString(record.summary);
  const rationale = readString(record.rationale);
  if (!verdict || !gateStatus || !summary || !rationale) {
    return {
      ok: false,
      error: "Evaluator output is missing verdict, gateStatus, summary, or rationale."
    };
  }

  return {
    ok: true,
    value: {
      verdict,
      gateStatus,
      scoreDelta: typeof record.scoreDelta === "number" && Number.isFinite(record.scoreDelta) ? record.scoreDelta : 0,
      summary,
      rationale,
      followupPrompt: readString(record.followupPrompt, record.followup_prompt) || undefined,
      comparator: readComparator(record.comparator)
    }
  };
}

export function describeIncompletePlannerOutput(rawOutput: string) {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    return "Strategist output was empty.";
  }
  if (trimmed.includes(LITHIUM_PLAN_MARKER)) {
    return null;
  }
  const summary = normalizeWhitespace(trimmed);
  if (summary.length < 24 || !/[.?!}]$/.test(summary)) {
    return `Strategist output looked incomplete: ${summary}`;
  }
  return null;
}

export function parseMarkedJsonPayload(
  rawText: string,
  marker: string,
  allowBareJson = false
): StructuredParseResult<unknown> {
  const candidateBlocks = allowBareJson
    ? [rawText.trim(), extractCandidateAfterMarker(rawText, marker)]
    : [extractCandidateAfterMarker(rawText, marker)];

  for (const candidate of candidateBlocks) {
    if (!candidate) {
      continue;
    }
    const normalized = extractJsonObjectBlock(stripCodeFence(candidate));
    if (!normalized) {
      continue;
    }
    try {
      return {
        ok: true,
        value: JSON.parse(normalized) as unknown
      };
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    error: `Structured output marker ${marker} or valid JSON payload was not found.`
  };
}

export function fallbackSummary(rawText: string, marker: string) {
  const stripped = rawText.replace(new RegExp(`\\n*${escapeRegExp(marker)}[\\s\\S]*$`, "i"), "").trim();
  if (!stripped) {
    return "";
  }
  const paragraph = stripped
    .split(/\n\s*\n/)
    .map((entry) => normalizeWhitespace(entry))
    .find(Boolean);
  return paragraph ?? normalizeWhitespace(stripped);
}

function extractCandidateAfterMarker(rawText: string, marker: string) {
  const markerIndex = rawText.lastIndexOf(marker);
  if (markerIndex < 0) {
    return "";
  }
  return rawText.slice(markerIndex + marker.length).trim();
}

function stripCodeFence(value: string) {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/i);
  return fenced?.[1]?.trim() ?? value.trim();
}

function extractJsonObjectBlock(value: string) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return value.slice(start, end + 1);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readPlanStepProposals(...values: unknown[]): PlanStepProposal[] {
  const entries = values.find(Array.isArray);
  if (!entries) {
    return [];
  }

  const proposals: PlanStepProposal[] = [];
  for (const entry of entries) {
    const record = toRecord(entry);
    const stepId = readString(record.step_id, record.stepId);
    const title = readString(record.title);
    const prompt = readString(record.prompt);
    const kind = readTaskKind(record.kind);
    if (!stepId || !title || !prompt || !kind) {
      continue;
    }
    proposals.push({
      stepId,
      title,
      prompt,
      kind,
      branchTitle: readString(record.branch_title, record.branchTitle) || undefined,
      dependsOn: readStringList(record.depends_on, record.dependsOn),
      expectedInfoGain: clamp01(readNumber(record.expected_info_gain, record.expectedInfoGain, 0.5)),
      estimatedCost: clamp01(readNumber(record.estimated_cost, record.estimatedCost, 0.5)),
      evidenceNeeded: readStringList(record.evidence_needed, record.evidenceNeeded),
      successRubric: readStringList(record.success_rubric, record.successRubric),
      stopCondition: readString(record.stop_condition, record.stopCondition) || "Stop when the task no longer yields new evidence.",
      branchUpdateIntent: readBranchIntent(record.branch_update_intent ?? record.branchUpdateIntent),
      sourceIds: readStringList(record.source_ids, record.sourceIds),
      questions: readStringList(record.questions),
      experimentSpec: readExperimentSpec(record.experiment_spec, record.experimentSpec),
      verificationSpec: readExperimentSpec(record.verification_spec, record.verificationSpec)
    });
  }
  return proposals;
}

function readExperimentSpec(...values: unknown[]): ExperimentSpecInput | undefined {
  const record = toRecord(values.find((value) => typeof value === "object" && value !== null));
  const cwd = readString(record.cwd);
  const commands = readStringList(record.commands);
  const timeoutMs = readNumber(record.timeoutMs, record.timeout_ms, 0);
  const mode = readExperimentMode(record.mode);
  if (!cwd || commands.length === 0 || timeoutMs <= 0 || !mode) {
    return undefined;
  }
  return {
    title: readString(record.title) || undefined,
    cwd,
    commands,
    timeoutMs,
    mode,
    expectedMetrics: readMetricExpectations(record.expectedMetrics, record.expected_metrics),
    artifactGlobs: readStringList(record.artifactGlobs, record.artifact_globs)
  };
}

function readMetricExpectations(...values: unknown[]) {
  const entries = values.find(Array.isArray);
  if (!entries) {
    return [];
  }
  return entries
    .map((entry) => {
      const record = toRecord(entry);
      const name = readString(record.name);
      if (!name) {
        return null;
      }
      return {
        name,
        value: readOptionalNumber(record.value),
        min: readOptionalNumber(record.min),
        max: readOptionalNumber(record.max),
        baselineDelta: readOptionalNumber(record.baselineDelta, record.baseline_delta)
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function readPlannerBranches(...values: unknown[]) {
  const entries = values.find(Array.isArray);
  if (!entries) {
    return [];
  }
  return entries
    .map((entry) => {
      const record = toRecord(entry);
      const title = readString(record.title);
      const hypothesis = readString(record.hypothesis);
      if (!title || !hypothesis) {
        return null;
      }
      return { title, hypothesis };
    })
    .filter((entry): entry is PlannerProposal["proposedBranches"][number] => Boolean(entry));
}

function readDiscoveredSources(value: unknown): DiscoveredSourceSpec[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const sources: DiscoveredSourceSpec[] = [];
  for (const entry of value) {
    const record = toRecord(entry);
    const locator = readString(record.locator);
    const title = readString(record.title);
    const kind = readSourceKind(record.kind);
    if (!locator || !title || !kind) {
      continue;
    }
    sources.push({
      locator,
      title,
      kind,
      summary: readString(record.summary) || title,
      excerpt: readString(record.excerpt) || undefined,
      branchTitle: readString(record.branch_title, record.branchTitle) || undefined
    });
  }
  return sources;
}

function readFindings(value: unknown): SynthesizedFindingSpec[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const findings: SynthesizedFindingSpec[] = [];
  for (const entry of value) {
    const record = toRecord(entry);
    const summary = readString(record.summary);
    const sourceLocator = readString(record.source_locator, record.sourceLocator);
    if (!summary || !sourceLocator) {
      continue;
    }
    findings.push({
      summary,
      detail: readString(record.detail) || undefined,
      sourceLocator,
      citationText: readString(record.citation_text, record.citationText) || undefined
    });
  }
  return findings;
}

function readComparator(value: unknown) {
  const record = toRecord(value);
  const metricDeltasRecord = toRecord(record.metricDeltas ?? record.metric_deltas);
  const metricDeltas = Object.fromEntries(
    Object.entries(metricDeltasRecord)
      .filter((entry): entry is [string, number] => typeof entry[0] === "string" && typeof entry[1] === "number")
      .map(([key, numeric]) => [key, numeric])
  );
  if (!record.baselineExperimentId && Object.keys(metricDeltas).length === 0) {
    return undefined;
  }
  return {
    baselineExperimentId: readString(record.baselineExperimentId, record.baseline_experiment_id) || undefined,
    metricDeltas
  };
}

function readResult(value: unknown): BuilderStatusPayload["result"] | null {
  return value === "success" || value === "partial" || value === "failed" ? value : null;
}

function readTaskKind(value: unknown): PlanStepProposal["kind"] | null {
  return value === "discover" ||
    value === "read_synthesize" ||
    value === "build_change" ||
    value === "verify_change" ||
    value === "run_experiment" ||
    value === "evaluate_branch" ||
    value === "promote_patch"
    ? value
    : null;
}

function readBranchIntent(value: unknown): PlanStepProposal["branchUpdateIntent"] {
  return value === "advance" || value === "branch" || value === "verify" || value === "kill" ? value : "advance";
}

function readSourceKind(value: unknown): DiscoveredSourceSpec["kind"] | null {
  return value === "web" || value === "repo" || value === "paper" ? value : null;
}

function readExperimentMode(value: unknown) {
  return value === "read-only" || value === "write-allowed" ? value : null;
}

function readVerdict(value: unknown): EvaluationDecisionInput["verdict"] | null {
  return value === "continue" || value === "kill" || value === "pivot" || value === "complete" ? value : null;
}

function readGateStatus(...values: unknown[]): EvaluationDecisionInput["gateStatus"] | null {
  const value = values.find((candidate) => typeof candidate === "string");
  return value === "passed" || value === "failed" || value === "inconclusive" ? value : null;
}

function readString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function readStringList(...values: unknown[]) {
  const array = values.find(Array.isArray);
  if (!array) {
    return [];
  }
  return array
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function readOptionalNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function toRecord(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
