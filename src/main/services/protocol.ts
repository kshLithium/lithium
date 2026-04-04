import type {
  DiscoveredSourceSpec,
  PlannerProposal,
  SynthesizedFindingSpec,
  TaskProposal
} from "../../shared/types";
import { clamp01, normalizeWhitespace } from "../lithium/utils";

export const LITHIUM_PLAN_MARKER = "LITHIUM_PLAN";
export const LITHIUM_DISCOVER_MARKER = "LITHIUM_DISCOVER";
export const LITHIUM_READ_MARKER = "LITHIUM_READ";
export const LITHIUM_STATUS_MARKER = "LITHIUM_STATUS";

type BuilderStatusPayload = {
  machineSummary: string;
  result: "success" | "partial" | "failed";
  files: string[];
  risks: string[];
  runActions: string[];
  successCriteria: string[];
  openQuestions: string[];
};

export function parsePlannerOutput(rawOutput: string): PlannerProposal {
  const parsed = parseMarkedJsonPayload(rawOutput, LITHIUM_PLAN_MARKER);
  if (!parsed || typeof parsed !== "object") {
    return {
      summary: fallbackSummary(rawOutput, LITHIUM_PLAN_MARKER),
      rationale: "Planner output was not valid structured JSON.",
      proposedBranches: [],
      proposedTasks: []
    };
  }

  const record = parsed as Record<string, unknown>;
  return {
    summary: readString(record.summary) || fallbackSummary(rawOutput, LITHIUM_PLAN_MARKER),
    rationale: readString(record.rationale) || "No planner rationale was returned.",
    proposedBranches: readPlannerBranches(record.proposed_branches, record.proposedBranches),
    proposedTasks: readTaskProposals(record.proposed_tasks, record.proposedTasks)
  };
}

export function parseDiscoverOutput(rawOutput: string) {
  const parsed = parseMarkedJsonPayload(rawOutput, LITHIUM_DISCOVER_MARKER);
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return {
    summary: readString(record.summary) || fallbackSummary(rawOutput, LITHIUM_DISCOVER_MARKER),
    sources: readDiscoveredSources(record.sources)
  };
}

export function parseReadOutput(rawOutput: string) {
  const parsed = parseMarkedJsonPayload(rawOutput, LITHIUM_READ_MARKER);
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return {
    summary: readString(record.summary) || fallbackSummary(rawOutput, LITHIUM_READ_MARKER),
    findings: readFindings(record.findings)
  };
}

export function parseBuilderStatus(rawOutput: string): BuilderStatusPayload {
  const parsed = parseMarkedJsonPayload(rawOutput, LITHIUM_STATUS_MARKER);
  if (!parsed || typeof parsed !== "object") {
    return {
      machineSummary: fallbackSummary(rawOutput, LITHIUM_STATUS_MARKER),
      result: "partial",
      files: [],
      risks: [],
      runActions: [],
      successCriteria: [],
      openQuestions: []
    };
  }

  const record = parsed as Record<string, unknown>;
  return {
    machineSummary: readString(record.machine_summary, record.machineSummary, record.summary) || "Task completed.",
    result: readResult(record.result),
    files: readStringList(record.files),
    risks: readStringList(record.risks),
    runActions: readStringList(record.run_actions, record.runActions),
    successCriteria: readStringList(record.success_criteria, record.successCriteria),
    openQuestions: readStringList(record.open_questions, record.openQuestions)
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

export function parseMarkedJsonPayload(rawText: string, marker: string) {
  const markerIndex = rawText.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const rawBlock = rawText.slice(markerIndex + marker.length).trim();
  const normalized = extractJsonObjectBlock(stripCodeFence(rawBlock));
  if (!normalized) {
    return null;
  }

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return null;
  }
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

function readTaskProposals(...values: unknown[]): TaskProposal[] {
  const entries = values.find(Array.isArray);
  if (!entries) {
    return [];
  }

  const proposals: TaskProposal[] = [];
  for (const entry of entries) {
    const record = toRecord(entry);
    const title = readString(record.title);
    const prompt = readString(record.prompt);
    const kind = readTaskKind(record.kind);
    if (!title || !prompt || !kind) {
      continue;
    }
    proposals.push({
      title,
      prompt,
      kind,
      branchTitle: readString(record.branch_title, record.branchTitle) || undefined,
      expectedInfoGain: clamp01(readNumber(record.expected_info_gain, record.expectedInfoGain, 0.5)),
      estimatedCost: clamp01(readNumber(record.estimated_cost, record.estimatedCost, 0.5)),
      evidenceNeeded: readStringList(record.evidence_needed, record.evidenceNeeded),
      successRubric: readStringList(record.success_rubric, record.successRubric),
      stopCondition: readString(record.stop_condition, record.stopCondition) || "Stop when the task no longer yields new evidence.",
      dependencyMode: readDependencyMode(record.dependency_mode, record.dependencyMode),
      branchUpdateIntent: readBranchIntent(record.branch_update_intent, record.branchUpdateIntent),
      sourceIds: readStringList(record.source_ids, record.sourceIds),
      verificationCommands: readStringList(record.verification_commands, record.verificationCommands),
      questions: readStringList(record.questions),
      commands: readStringList(record.commands)
    });
  }
  return proposals;
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

function readResult(value: unknown): BuilderStatusPayload["result"] {
  return value === "success" || value === "partial" || value === "failed" ? value : "partial";
}

function readTaskKind(value: unknown): TaskProposal["kind"] | null {
  return value === "discover" ||
    value === "read_synthesize" ||
    value === "build_change" ||
    value === "run_experiment" ||
    value === "evaluate_branch"
    ? value
    : null;
}

function readDependencyMode(value: unknown, fallback: unknown): TaskProposal["dependencyMode"] {
  const candidate = typeof value === "string" ? value : typeof fallback === "string" ? fallback : "";
  return candidate === "success" || candidate === "failed" || candidate === "terminal" ? candidate : "success";
}

function readBranchIntent(value: unknown, fallback: unknown): TaskProposal["branchUpdateIntent"] {
  const candidate = typeof value === "string" ? value : typeof fallback === "string" ? fallback : "";
  return candidate === "advance" || candidate === "branch" || candidate === "verify" || candidate === "kill"
    ? candidate
    : "advance";
}

function readSourceKind(value: unknown): DiscoveredSourceSpec["kind"] | null {
  return value === "web" || value === "repo" || value === "paper" ? value : null;
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

function toRecord(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
