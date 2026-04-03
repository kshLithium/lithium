import type { ChatRouteDecision, LithiumHandoff } from "../../shared/types";
import { isOperationalAutomationMessage } from "../../shared/handoff-utils";

const STRATEGIST_MARKER = "LITHIUM_HANDOFF";
const BUILDER_MARKER = "LITHIUM_STATUS";
const ROUTER_MARKER = "LITHIUM_ROUTE";

const INCOMPLETE_STRATEGIST_PREFIX =
  /^(?:i['’]?m|let me|sure|certainly|okay|ok|alright|based on|here(?:'s| is)?|pulling|reviewing|comparing|synthesizing)\b/i;
const USER_VISIBLE_SYSTEM_NOISE_PATTERN =
  /^(?:connect econnrefused\b.*|prompt textarea did not appear before timeout\b.*|prompt did not appear in conversation before timeout\b.*|prompt-not-in-composer\b.*|send may have failed\b.*|reconnecting\.\.\.\s*\d+\/\d+\b.*|stream disconnected before comp\b.*|write_stdin failed\b.*|stdin is closed\b.*|chrome window closed before oracle finished\b.*|chrome disconnected before completion\b.*|if the saved chatgpt session expired\b.*|set lithium_oracle_visible=1\b.*|no (?:chatgpt )?cookies were applied\b.*|log in to chatgpt in chrome\b.*|provide inline cookies\b.*|unable to find model option matching\b.*)$/i;

type ParsedResearchWorkItem = NonNullable<LithiumHandoff["researchWorkItems"]>[number];

export function parseOracleOutput(rawOutput: string): LithiumHandoff {
  const parsed = parseMarkedJsonBlock(rawOutput, STRATEGIST_MARKER);

  if (parsed) {
    return normalizeStrategistHandoff(parsed, rawOutput);
  }

  const summary = extractFallbackStrategistSummary(rawOutput);
  const userMessage = extractVisibleStrategistMessage(rawOutput) || undefined;

  return {
    schemaVersion: "lithium_handoff_v1",
    role: "strategist",
    summary,
    machineSummary: summary,
    userMessage,
    rationale: "Oracle did not return a structured rationale.",
    files: [],
    risks: [],
    runActions: [],
    successCriteria: [],
    openQuestions: []
  };
}

export function parseBuilderOutput(finalMessage: string): LithiumHandoff {
  const parsed = parseMarkedJsonBlock(finalMessage, BUILDER_MARKER);

  if (parsed) {
    return normalizeBuilderHandoff(parsed, finalMessage);
  }

  const visibleMessage = extractVisibleBuilderMessage(finalMessage) || undefined;
  const summary = stripMarkedBlock(finalMessage, BUILDER_MARKER).replace(/\s+/g, " ").trim().slice(0, 180);

  return {
    schemaVersion: "lithium_handoff_v1",
    role: "builder",
    summary,
    machineSummary: summary,
    userMessage: visibleMessage,
    result: undefined,
    files: [],
    risks: [],
    runActions: [],
    successCriteria: [],
    openQuestions: []
  };
}

export function parseRouterOutput(rawOutput: string): ChatRouteDecision | null {
  const parsed = parseMarkedJsonBlock(rawOutput, ROUTER_MARKER) ?? parseWholeJsonBlock(rawOutput);

  if (!parsed) {
    return null;
  }

  const candidate = toRecord(parsed);
  const route = readString(candidate.route);

  if (route !== "strategist" && route !== "builder" && route !== "mixed") {
    return null;
  }

  return {
    route,
    rewrittenPrompt: readString(candidate.rewritten_prompt, candidate.rewrittenPrompt),
    reasonShort: readString(candidate.reason_short, candidate.reasonShort)
  };
}

export function describeIncompleteStrategistOutput(rawOutput: string) {
  const trimmed = rawOutput.trim();

  if (!trimmed) {
    return "Oracle strategist run completed without producing output.";
  }

  if (
    trimmed.includes(STRATEGIST_MARKER)
  ) {
    return null;
  }

  const normalized = trimmed.replace(/\s+/g, " ").trim();
  const wordCount = normalized.split(" ").filter(Boolean).length;

  if (normalized.length < 8 || wordCount <= 2) {
    return `Oracle strategist output looked truncated or non-final: ${normalized}`;
  }

  if (normalized.endsWith(":") && wordCount <= 8) {
    return `Oracle strategist output looked truncated or non-final: ${normalized}`;
  }

  if (INCOMPLETE_STRATEGIST_PREFIX.test(normalized) && !/[.?!]$/.test(normalized)) {
    return `Oracle strategist output looked truncated or non-final: ${normalized}`;
  }

  if (wordCount <= 4 && normalized.length < 32 && !/[.?!:]$/.test(normalized)) {
    return `Oracle strategist output looked truncated or non-final: ${normalized}`;
  }

  return null;
}

function normalizeStrategistHandoff(value: unknown, rawOutput: string): LithiumHandoff {
  const candidate = toRecord(value);
  const machineSummary =
    readString(candidate.machine_summary, candidate.machineSummary, candidate.summary) ||
    extractFallbackStrategistSummary(rawOutput);
  const userMessage =
    readString(candidate.user_message, candidate.userMessage) ||
    extractVisibleStrategistMessage(rawOutput) ||
    undefined;
  const automationMode = normalizeAutomationMode(readString(candidate.automation_mode, candidate.automationMode));
  const needsUserCheckpoint = readBoolean(candidate.needs_user_checkpoint, candidate.needsUserCheckpoint);
  const proposedBranches = readPlannerBranches(candidate.proposed_branches, candidate.proposedBranches);
  const researchWorkItems = readResearchWorkItems(candidate.research_work_items, candidate.researchWorkItems);

  return {
    schemaVersion: "lithium_handoff_v1",
    role: "strategist",
    summary: machineSummary,
    machineSummary,
    ...(userMessage ? { userMessage } : {}),
    rationale:
      readString(candidate.rationale) || "Oracle did not return a structured rationale.",
    files: readStringList(candidate.files),
    risks: readStringList(candidate.risks),
    runActions: readStringList(candidate.run_actions, candidate.runActions),
    successCriteria: readStringList(candidate.success_criteria, candidate.successCriteria),
    openQuestions: readStringList(candidate.open_questions, candidate.openQuestions),
    ...(proposedBranches.length > 0 ? { proposedBranches } : {}),
    ...(researchWorkItems.length > 0 ? { researchWorkItems } : {}),
    ...(automationMode ? { automationMode } : {}),
    ...(typeof needsUserCheckpoint === "boolean" ? { needsUserCheckpoint } : {})
  };
}

function normalizeBuilderHandoff(value: unknown, finalMessage: string): LithiumHandoff {
  const candidate = toRecord(value);
  const machineSummary =
    readString(candidate.machine_summary, candidate.machineSummary, candidate.summary) ||
    stripMarkedBlock(finalMessage, BUILDER_MARKER).replace(/\s+/g, " ").trim().slice(0, 180);
  const userMessage =
    readString(candidate.user_message, candidate.userMessage) ||
    extractVisibleBuilderMessage(finalMessage) ||
    undefined;
  const automationMode = normalizeAutomationMode(readString(candidate.automation_mode, candidate.automationMode));
  const needsUserCheckpoint = readBoolean(candidate.needs_user_checkpoint, candidate.needsUserCheckpoint);

  return {
    schemaVersion: "lithium_handoff_v1",
    role: "builder",
    summary: machineSummary,
    machineSummary,
    ...(userMessage ? { userMessage } : {}),
    result: normalizeResultTag(readString(candidate.result)),
    files: readStringList(candidate.files),
    risks: readStringList(candidate.risks),
    runActions: readStringList(candidate.run_actions, candidate.runActions),
    successCriteria: readStringList(candidate.success_criteria, candidate.successCriteria),
    openQuestions: readStringList(candidate.open_questions, candidate.openQuestions),
    ...(automationMode ? { automationMode } : {}),
    ...(typeof needsUserCheckpoint === "boolean" ? { needsUserCheckpoint } : {})
  };
}

function parseMarkedJsonBlock(rawText: string, marker: string) {
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

function stripCodeFence(value: string) {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/i);
  return fenced?.[1]?.trim() ?? value.trim();
}

function parseWholeJsonBlock(rawText: string) {
  const normalized = extractJsonObjectBlock(stripCodeFence(rawText));

  if (!normalized) {
    return null;
  }

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return null;
  }
}

function stripMarkedBlock(rawText: string, marker: string) {
  return rawText.replace(new RegExp(`\\n*${escapeRegExp(marker)}(?:\\s*\\n|\\s+)?[\\s\\S]*$`, "i"), "").trim();
}

export function extractVisibleStrategistMessage(rawOutput: string) {
  const stripped = stripUserVisibleSystemNoise(stripMarkedBlock(rawOutput, STRATEGIST_MARKER)).trim();

  if (!stripped || looksLikeStructuredStrategistOnly(stripped)) {
    return "";
  }

  return stripped;
}

export function containsUserVisibleSystemNoise(value: string) {
  return value
    .split("\n")
    .map((line) => normalizePotentialSystemNoiseLine(line))
    .some((line) => USER_VISIBLE_SYSTEM_NOISE_PATTERN.test(line));
}

export function stripUserVisibleSystemNoise(value: string) {
  const filteredLines = value
    .split("\n")
    .filter((line) => !USER_VISIBLE_SYSTEM_NOISE_PATTERN.test(normalizePotentialSystemNoiseLine(line)));

  return filteredLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractVisibleBuilderMessage(finalMessage: string) {
  const stripped = stripMarkedBlock(finalMessage, BUILDER_MARKER).trim();

  if (!stripped || looksLikeStructuredBuilderOnly(stripped) || isOperationalAutomationMessage(stripped)) {
    return "";
  }

  return stripped;
}

function extractJsonObjectBlock(value: string) {
  const start = value.indexOf("{");

  if (start < 0) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
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

  return "";
}

function looksLikeStructuredStrategistOnly(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return true;
  }

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || trimmed === STRATEGIST_MARKER) {
    return true;
  }

  const meaningfulLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return meaningfulLines.every((line) =>
    /^(summary|machine_summary|user_message|rationale|files|risks|run_actions|success_criteria|open_questions)\s*:/i.test(
      line
    )
  );
}

function looksLikeStructuredBuilderOnly(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return true;
  }

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || trimmed === BUILDER_MARKER) {
    return true;
  }

  const meaningfulLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return meaningfulLines.every((line) =>
    /^(summary|machine_summary|user_message|result|files|risks|run_actions|success_criteria|open_questions)\s*:/i.test(
      line
    )
  );
}

function firstNonEmptyLine(rawOutput: string) {
  return (
    rawOutput
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function extractFallbackStrategistSummary(rawOutput: string, maxChars = 280) {
  const stripped = stripUserVisibleSystemNoise(stripMarkedBlock(rawOutput, STRATEGIST_MARKER)).trim();

  if (!stripped) {
    return "";
  }

  const paragraphs = stripped
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    if (
      isHeadingOnlyParagraph(paragraph) ||
      isLeadInParagraph(paragraph) ||
      isBoilerplateCompletionParagraph(paragraph)
    ) {
      continue;
    }

    const normalized = normalizeSummaryParagraph(paragraph);

    if (normalized) {
      return truncateInline(normalized, maxChars);
    }
  }

  return truncateInline(firstNonEmptyLine(stripped), maxChars);
}

function normalizePotentialSystemNoiseLine(line: string) {
  return line
    .trim()
    .replace(/^(?:[-*+]|>\s*|\d+[.)])\s*/, "")
    .trim();
}

function isHeadingOnlyParagraph(paragraph: string) {
  const lines = paragraph
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.length === 1 && /^#{1,6}\s+\S/.test(lines[0]);
}

function isLeadInParagraph(paragraph: string) {
  const lines = paragraph
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== 1) {
    return false;
  }

  const normalized = lines[0].replace(/^#{1,6}\s+/, "").trim();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;

  return wordCount <= 12 && /[:：]\s*$/.test(normalized);
}

function isBoilerplateCompletionParagraph(paragraph: string) {
  const lines = paragraph
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== 1) {
    return false;
  }

  const normalized = lines[0].replace(/^#{1,6}\s+/, "").trim();
  const compact = normalized.replace(/\s+/g, " ");

  return [
    /^(?:완료|마무리|정리|반영|수정|업데이트)(?:했습니다|했어요|했습니다만)?[.!]?$/.test(compact),
    /^(?:done|completed|finished|updated)\.?$/i.test(compact),
    /^(?:here(?:'s| is) (?:the )?(?:update|summary)|요약하면)[.:]?\s*$/i.test(compact)
  ].some(Boolean);
}

function normalizeSummaryParagraph(paragraph: string) {
  return paragraph
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^#{1,6}\s+/, ""))
    .map((line) => line.replace(/^>\s*/, ""))
    .map((line) => line.replace(/^[-*+]\s+/, ""))
    .map((line) => line.replace(/^\d+\.\s+/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateInline(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  const budget = Math.max(0, maxChars - 1);
  return `${value.slice(0, budget).trimEnd()}…`;
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

function readBoolean(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();

      if (normalized === "true") {
        return true;
      }

      if (normalized === "false") {
        return false;
      }
    }
  }

  return undefined;
}

function readStringList(...values: unknown[]) {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    if (typeof value === "string" && value.trim()) {
      return splitLooseList(value);
    }
  }

  return [];
}

function readPlannerBranches(...values: unknown[]) {
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }

    const normalized = value.flatMap((entry) => {
      const record = toRecord(entry);
      const title = readString(record.title);
      const hypothesis = readString(record.hypothesis);

      if (!title || !hypothesis) {
        return [];
      }

      return [{ title, hypothesis }];
    });

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
}

function readResearchWorkItems(...values: unknown[]) {
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }

    const normalized = value.flatMap((entry) => {
      const record = toRecord(entry);
      const title = readString(record.title);
      const prompt = readString(record.prompt);
      const kind = readString(record.kind);
      const executor = readString(record.executor);
      const isolation = readString(record.isolation);
      const branchTitle = readString(record.branch_title, record.branchTitle);

      if (
        !title ||
        !prompt ||
        !kind ||
        !/^(planner|deep-research|code-edit|experiment|evaluation)$/.test(kind)
      ) {
        return [];
      }

      const normalizedExecutor =
        executor && /^(oracle-planner|oracle-research|builder-edit|experiment-run|evaluator)$/.test(executor)
          ? executor
          : undefined;
      const normalizedIsolation =
        isolation && /^(none|worktree)$/.test(isolation)
          ? isolation
          : undefined;

      return [
        {
          title,
          prompt,
          kind: kind as ParsedResearchWorkItem["kind"],
          executor: normalizedExecutor as ParsedResearchWorkItem["executor"],
          isolation: normalizedIsolation as ParsedResearchWorkItem["isolation"],
          branchTitle: branchTitle || undefined
        }
      ];
    });

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitLooseList(value: string) {
  return value
    .split(/[\n,;|]/)
    .map((entry) => entry.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .filter((entry) => !/^(none|n\/a|na)$/i.test(entry));
}

function normalizeResultTag(value: string) {
  if (value === "success" || value === "partial" || value === "failed") {
    return value;
  }

  return "failed";
}

function normalizeAutomationMode(value: string) {
  if (value === "continue" || value === "checkpoint" || value === "blocked" || value === "done") {
    return value;
  }

  return undefined;
}
