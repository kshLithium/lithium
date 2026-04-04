import type {
  LithiumHandoff,
  ResearchIsolationMode,
  ResearchWorkItemExecutor,
  ResearchWorkItemKind
} from "../../shared/types";

const PLANNER_MARKER = "LITHIUM_HANDOFF";
const BUILDER_MARKER = "LITHIUM_STATUS";
const INCOMPLETE_PLANNER_PREFIX =
  /^(?:i['’]?m|let me|sure|certainly|okay|ok|alright|based on|here(?:'s| is)?|pulling|reviewing|comparing|synthesizing)\b/i;
const USER_VISIBLE_RUNTIME_NOISE_PATTERN =
  /^(?:connect econnrefused\b.*|prompt textarea did not appear before timeout\b.*|prompt did not appear before timeout\b.*|prompt-not-in-composer\b.*|send may have failed\b.*|reconnecting\.\.\.\s*\d+\/\d+\b.*|stream disconnected before comp\b.*|write_stdin failed\b.*|stdin is closed\b.*|chrome window closed before oracle finished\b.*|chrome disconnected before completion\b.*|if the saved chatgpt session expired\b.*|set lithium_oracle_visible=1\b.*|no (?:chatgpt )?cookies were applied\b.*|log in to chatgpt in chrome\b.*|provide inline cookies\b.*|unable to find model option matching\b.*)$/i;

type ParsedResearchWorkItem = NonNullable<LithiumHandoff["researchWorkItems"]>[number];

export function parseOracleOutput(rawOutput: string): LithiumHandoff {
  const parsed = parseMarkedJsonPayload(rawOutput, PLANNER_MARKER);

  if (parsed) {
    return normalizePlannerHandoff(parsed, rawOutput);
  }

  const summary = extractFallbackSummary(rawOutput, PLANNER_MARKER);
  return createEmptyHandoff("planner", summary, "Oracle did not return a structured planning rationale.");
}

export function parseBuilderOutput(finalMessage: string): LithiumHandoff {
  const parsed = parseMarkedJsonPayload(finalMessage, BUILDER_MARKER);

  if (parsed) {
    return normalizeBuilderHandoff(parsed, finalMessage);
  }

  const summary = extractFallbackSummary(finalMessage, BUILDER_MARKER);
  return createEmptyHandoff("builder", summary, "Builder did not return a structured result rationale.");
}

export function describeIncompletePlannerOutput(rawOutput: string) {
  const trimmed = rawOutput.trim();

  if (!trimmed) {
    return "Oracle planner run completed without producing output.";
  }

  if (trimmed.includes(PLANNER_MARKER)) {
    return null;
  }

  const normalized = trimmed.replace(/\s+/g, " ").trim();
  const wordCount = normalized.split(" ").filter(Boolean).length;

  if (normalized.length < 8 || wordCount <= 2) {
    return `Oracle planner output looked truncated or non-final: ${normalized}`;
  }

  if (normalized.endsWith(":") && wordCount <= 8) {
    return `Oracle planner output looked truncated or non-final: ${normalized}`;
  }

  if (INCOMPLETE_PLANNER_PREFIX.test(normalized) && !/[.?!]$/.test(normalized)) {
    return `Oracle planner output looked truncated or non-final: ${normalized}`;
  }

  if (wordCount <= 4 && normalized.length < 32 && !/[.?!:]$/.test(normalized)) {
    return `Oracle planner output looked truncated or non-final: ${normalized}`;
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

function normalizePlannerHandoff(value: unknown, rawOutput: string): LithiumHandoff {
  const candidate = toRecord(value);
  const machineSummary =
    readString(candidate.machine_summary, candidate.machineSummary, candidate.summary) ||
    extractFallbackSummary(rawOutput, PLANNER_MARKER);
  const proposedBranches = readPlannerBranches(candidate.proposed_branches, candidate.proposedBranches);
  const researchWorkItems = readResearchWorkItems(candidate.research_work_items, candidate.researchWorkItems);

  return {
    ...createEmptyHandoff(
      "planner",
      machineSummary,
      readString(candidate.rationale) || "Oracle did not return a structured planning rationale."
    ),
    files: readStringList(candidate.files),
    risks: readStringList(candidate.risks),
    runActions: readStringList(candidate.run_actions, candidate.runActions),
    successCriteria: readStringList(candidate.success_criteria, candidate.successCriteria),
    openQuestions: readStringList(candidate.open_questions, candidate.openQuestions),
    ...(proposedBranches.length > 0 ? { proposedBranches } : {}),
    ...(researchWorkItems.length > 0 ? { researchWorkItems } : {}),
    ...(typeof candidate.confidence === "number" ? { confidence: clamp01(candidate.confidence) } : {})
  };
}

function normalizeBuilderHandoff(value: unknown, finalMessage: string): LithiumHandoff {
  const candidate = toRecord(value);
  const machineSummary =
    readString(candidate.machine_summary, candidate.machineSummary, candidate.summary) ||
    extractFallbackSummary(finalMessage, BUILDER_MARKER);

  return {
    ...createEmptyHandoff(
      "builder",
      machineSummary,
      readString(candidate.rationale) || "Builder did not return a structured result rationale."
    ),
    result: normalizeResultTag(readString(candidate.result)),
    files: readStringList(candidate.files),
    risks: readStringList(candidate.risks),
    runActions: readStringList(candidate.run_actions, candidate.runActions),
    successCriteria: readStringList(candidate.success_criteria, candidate.successCriteria),
    openQuestions: readStringList(candidate.open_questions, candidate.openQuestions)
  };
}

function createEmptyHandoff(role: LithiumHandoff["role"], summary: string, rationale: string): LithiumHandoff {
  return {
    schemaVersion: "lithium_handoff_v1",
    role,
    summary,
    machineSummary: summary,
    rationale,
    files: [],
    risks: [],
    runActions: [],
    successCriteria: [],
    openQuestions: []
  };
}

function stripCodeFence(value: string) {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/i);
  return fenced?.[1]?.trim() ?? value.trim();
}

function stripMarkedBlock(rawText: string, marker: string) {
  return rawText.replace(new RegExp(`\\n*${escapeRegExp(marker)}(?:\\s*\\n|\\s+)?[\\s\\S]*$`, "i"), "").trim();
}

function extractFallbackSummary(rawText: string, marker: string) {
  const stripped = stripRuntimeNoise(stripMarkedBlock(rawText, marker)).trim();
  if (!stripped) {
    return "";
  }

  const paragraphs = stripped
    .split(/\n\s*\n/)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return paragraphs[0] ?? stripped.replace(/\s+/g, " ").trim();
}

function stripRuntimeNoise(value: string) {
  return value
    .split("\n")
    .filter((line) => !USER_VISIBLE_RUNTIME_NOISE_PATTERN.test(normalizePotentialRuntimeNoiseLine(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizePotentialRuntimeNoiseLine(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeResultTag(value: string | null) {
  return value === "success" || value === "partial" || value === "failed" ? value : undefined;
}

function readPlannerBranches(...values: unknown[]) {
  const entries = values.find(Array.isArray);
  if (!entries) {
    return [];
  }

  return entries
    .map((entry) => {
      const candidate = toRecord(entry);
      const title = readString(candidate.title);
      const hypothesis = readString(candidate.hypothesis);
      if (!title || !hypothesis) {
        return null;
      }
      return { title, hypothesis };
    })
    .filter((entry): entry is NonNullable<LithiumHandoff["proposedBranches"]>[number] => Boolean(entry));
}

function readResearchWorkItems(...values: unknown[]): ParsedResearchWorkItem[] {
  const entries = values.find(Array.isArray);
  if (!entries) {
    return [];
  }

  return entries
    .map((entry) => {
      const candidate = toRecord(entry);
      const title = readString(candidate.title);
      const prompt = readString(candidate.prompt);
      const kind = readTaskKind(candidate.kind);
      const executor = readTaskExecutor(candidate.executor);
      const isolation = readIsolation(candidate.isolation);
      const branchTitle = readString(candidate.branch_title, candidate.branchTitle);

      if (!title || !prompt || !kind) {
        return null;
      }

      return {
        title,
        prompt,
        kind,
        ...(executor ? { executor } : {}),
        ...(isolation ? { isolation } : {}),
        ...(branchTitle ? { branchTitle } : {})
      };
    })
    .filter((entry): entry is ParsedResearchWorkItem => Boolean(entry));
}

function readTaskKind(value: unknown): ParsedResearchWorkItem["kind"] | null {
  return value === "discover" ||
    value === "read_synthesize" ||
    value === "build_change" ||
    value === "run_experiment" ||
    value === "evaluate_branch"
    ? value
    : null;
}

function readTaskExecutor(value: unknown): ParsedResearchWorkItem["executor"] | undefined {
  return value === "discoverer" ||
    value === "reader-synthesizer" ||
    value === "builder" ||
    value === "experimenter" ||
    value === "evaluator"
    ? value
    : undefined;
}

function readIsolation(value: unknown): ResearchIsolationMode | undefined {
  return value === "none" || value === "worktree" ? value : undefined;
}

function readString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}

function readStringList(...values: unknown[]) {
  const items = values.find(Array.isArray);
  if (!items) {
    return [];
  }

  return items
    .flatMap((entry) => (typeof entry === "string" ? [entry.trim()] : []))
    .filter(Boolean);
}

function toRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function extractJsonObjectBlock(value: string) {
  const start = value.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
