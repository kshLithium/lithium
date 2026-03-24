import type { ChatRouteDecision, LithiumHandoff } from "../../shared/types";
import { isOperationalAutomationMessage } from "../../shared/handoff-utils";

const STRATEGIST_MARKER = "LITHIUM_HANDOFF";
const BUILDER_MARKER = "LITHIUM_STATUS";
const ROUTER_MARKER = "LITHIUM_ROUTE";

const INCOMPLETE_STRATEGIST_PREFIX =
  /^(?:i['’]?m|let me|sure|certainly|okay|ok|alright|based on|here(?:'s| is)?|pulling|reviewing|comparing|synthesizing)\b/i;

export function parseOracleOutput(rawOutput: string): LithiumHandoff {
  const parsed = parseMarkedJsonBlock(rawOutput, STRATEGIST_MARKER);

  if (parsed) {
    return normalizeStrategistHandoff(parsed, rawOutput);
  }

  return {
    schemaVersion: "lithium_handoff_v1",
    role: "strategist",
    summary: extractTaggedLine(rawOutput, "SUMMARY") || extractFallbackStrategistSummary(rawOutput),
    machineSummary: extractTaggedLine(rawOutput, "MACHINE_SUMMARY") || extractTaggedLine(rawOutput, "SUMMARY") || extractFallbackStrategistSummary(rawOutput),
    userMessage: extractTaggedLine(rawOutput, "USER_MESSAGE") || extractVisibleStrategistMessage(rawOutput) || undefined,
    rationale:
      extractTaggedLine(rawOutput, "RATIONALE") || "Oracle did not return a structured rationale.",
    files: parseTaggedList(rawOutput, "FILES"),
    risks: parseTaggedList(rawOutput, "RISKS"),
    paperActions: parseTaggedList(rawOutput, "PAPER_ACTIONS"),
    runActions: parseTaggedList(rawOutput, "RUN_ACTIONS"),
    successCriteria: parseTaggedList(rawOutput, "SUCCESS_CRITERIA"),
    openQuestions: parseTaggedList(rawOutput, "OPEN_QUESTIONS")
  };
}

export function parseBuilderOutput(finalMessage: string): LithiumHandoff {
  const parsed = parseMarkedJsonBlock(finalMessage, BUILDER_MARKER);

  if (parsed) {
    return normalizeBuilderHandoff(parsed, finalMessage);
  }

  return {
    schemaVersion: "lithium_handoff_v1",
    role: "builder",
    summary:
      extractTaggedLine(finalMessage, "SUMMARY") ||
      stripMarkedBlock(finalMessage, BUILDER_MARKER).replace(/\s+/g, " ").trim().slice(0, 180),
    machineSummary:
      extractTaggedLine(finalMessage, "MACHINE_SUMMARY") ||
      extractTaggedLine(finalMessage, "SUMMARY") ||
      stripMarkedBlock(finalMessage, BUILDER_MARKER).replace(/\s+/g, " ").trim().slice(0, 180),
    userMessage: extractTaggedLine(finalMessage, "USER_MESSAGE") || extractVisibleBuilderMessage(finalMessage) || undefined,
    result: normalizeResultTag(extractTaggedLine(finalMessage, "RESULT")),
    files: parseTaggedList(finalMessage, "FILES"),
    risks: parseTaggedList(finalMessage, "RISKS"),
    paperActions: parseTaggedList(finalMessage, "PAPER_ACTIONS"),
    runActions: parseTaggedList(finalMessage, "RUN_ACTIONS"),
    successCriteria: parseTaggedList(finalMessage, "SUCCESS_CRITERIA"),
    openQuestions: parseTaggedList(finalMessage, "OPEN_QUESTIONS")
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
    trimmed.includes(STRATEGIST_MARKER) ||
    /^SUMMARY:\s*/im.test(trimmed) ||
    /^NEXT_TASK:\s*/im.test(trimmed)
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

  return {
    schemaVersion: "lithium_handoff_v1",
    role: "strategist",
    summary: machineSummary,
    machineSummary,
    userMessage,
    rationale:
      readString(candidate.rationale) || "Oracle did not return a structured rationale.",
    files: readStringList(candidate.files),
    risks: readStringList(candidate.risks),
    paperActions: readStringList(candidate.paper_actions, candidate.paperActions),
    runActions: readStringList(candidate.run_actions, candidate.runActions),
    successCriteria: readStringList(candidate.success_criteria, candidate.successCriteria),
    openQuestions: readStringList(candidate.open_questions, candidate.openQuestions),
    automationMode: normalizeAutomationMode(readString(candidate.automation_mode, candidate.automationMode)),
    needsUserCheckpoint: readBoolean(candidate.needs_user_checkpoint, candidate.needsUserCheckpoint)
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

  return {
    schemaVersion: "lithium_handoff_v1",
    role: "builder",
    summary: machineSummary,
    machineSummary,
    userMessage,
    result: normalizeResultTag(readString(candidate.result)),
    files: readStringList(candidate.files),
    risks: readStringList(candidate.risks),
    paperActions: readStringList(candidate.paper_actions, candidate.paperActions),
    runActions: readStringList(candidate.run_actions, candidate.runActions),
    successCriteria: readStringList(candidate.success_criteria, candidate.successCriteria),
    openQuestions: readStringList(candidate.open_questions, candidate.openQuestions),
    automationMode: normalizeAutomationMode(readString(candidate.automation_mode, candidate.automationMode)),
    needsUserCheckpoint: readBoolean(candidate.needs_user_checkpoint, candidate.needsUserCheckpoint)
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
  return rawText.replace(new RegExp(`\\n*${marker}\\s*\\n[\\s\\S]*$`, "i"), "").trim();
}

function extractVisibleStrategistMessage(rawOutput: string) {
  const stripped = stripMarkedBlock(rawOutput, STRATEGIST_MARKER).trim();

  if (!stripped || looksLikeStructuredStrategistOnly(stripped)) {
    return "";
  }

  return stripped;
}

function extractVisibleBuilderMessage(finalMessage: string) {
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

function extractTaggedLine(rawOutput: string, tag: string) {
  const match = rawOutput.match(new RegExp(`^${tag}:\\s*(.+)$`, "imu"));
  return match?.[1]?.trim() ?? "";
}

function parseTaggedList(rawOutput: string, tag: string) {
  const lines = rawOutput.split(/\r?\n/);
  let lineIndex = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (new RegExp(`^${tag}:\\s*`, "i").test(lines[index])) {
      lineIndex = index;
      break;
    }
  }

  if (lineIndex < 0) {
    return [];
  }

  const valueLines = [lines[lineIndex].replace(new RegExp(`^${tag}:\\s*`, "i"), "").trim()];

  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      valueLines.push("");
      continue;
    }

    if (/^[A-Z][A-Z0-9 _-]{2,}:\s*/.test(trimmed) || trimmed === STRATEGIST_MARKER || trimmed === BUILDER_MARKER) {
      break;
    }

    valueLines.push(trimmed);
  }

  const rawValue = valueLines.join("\n").trim();

  if (!rawValue || /^(none|n\/a|na)$/i.test(rawValue)) {
    return [];
  }

  return rawValue
    .split(/[\n,;|]/)
    .map((entry) => entry.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .filter((entry) => !/^(none|n\/a|na)$/i.test(entry));
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
    /^(summary|machine_summary|user_message|next[_ ]task|rationale|files|risks|paper_actions|run_actions|success_criteria|open_questions)\s*:/i.test(
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
    /^(summary|machine_summary|user_message|result|files|risks|paper_actions|run_actions|success_criteria|open_questions)\s*:/i.test(
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
  const stripped = stripMarkedBlock(rawOutput, STRATEGIST_MARKER).trim();

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
