import {
  coerceStrategistThinkingTime,
  isBuilderModel,
  isBuilderReasoningEffort,
  isOracleModel,
  isOracleThinkingTime
} from "../../shared/model-config";
import type {
  AutomationMode,
  AutomationWorkerMode,
  BuilderModel,
  BuilderReasoningEffort,
  OracleModel,
  OracleThinkingTime
} from "../../shared/types";

export type OrchestratorBuilderExecutionMode = "sync" | "live";

export type OrchestratorBuilderDirective = {
  lane: "builder";
  prompt: string;
  executionMode?: OrchestratorBuilderExecutionMode;
  model?: BuilderModel;
  reasoningEffort?: BuilderReasoningEffort;
};

export type OrchestratorStrategistDirective = {
  lane: "strategist";
  prompt: string;
  workerMode?: AutomationWorkerMode;
  model?: OracleModel;
  reasoningIntensity?: OracleThinkingTime;
  attachExplicitWorkspaceFiles?: boolean;
};

export type OrchestratorAutomationDirective = {
  lane: "automation";
  prompt: string;
  mode?: AutomationMode;
  maxSteps?: number;
  maxRuntimeMinutes?: number;
  maxRetries?: number;
  paperWriteEnabled?: boolean;
};

export type OrchestratorDelegationDirective =
  | OrchestratorBuilderDirective
  | OrchestratorStrategistDirective
  | OrchestratorAutomationDirective;

const BUILDER_HEADER_KEYS = new Set(["execution", "executionmode", "model", "reasoning", "reasoningeffort", "task"]);
const STRATEGIST_HEADER_KEYS = new Set([
  "execution",
  "workermode",
  "model",
  "intensity",
  "reasoning",
  "reasoningintensity",
  "attachexplicitfiles",
  "attachexplicitworkspacefiles",
  "task"
]);
const AUTOMATION_HEADER_KEYS = new Set([
  "mode",
  "maxsteps",
  "maxruntimeminutes",
  "maxretries",
  "paperwrite",
  "paperwriteenabled",
  "task"
]);

export function parseOrchestratorDelegationRequest(
  lane: OrchestratorDelegationDirective["lane"],
  raw: string
): OrchestratorDelegationDirective | null {
  const trimmed = raw.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = splitDirectiveHeaders(trimmed, lane);
  const prompt = parsed.body.trim() || trimmed;

  if (!prompt) {
    return null;
  }

  if (lane === "builder") {
    const executionMode = parseBuilderExecutionMode(parsed.headers.execution);
    const model = parseBuilderModel(parsed.headers.model);
    const reasoningEffort = parseBuilderReasoning(
      parsed.headers.reasoningeffort ?? parsed.headers.reasoning
    );

    return {
      lane,
      prompt,
      executionMode,
      model,
      reasoningEffort
    };
  }

  if (lane === "strategist") {
    const workerMode = parseWorkerMode(parsed.headers.execution ?? parsed.headers.workermode);
    const model = parseOracleModel(parsed.headers.model);
    const reasoningIntensity = parseStrategistIntensity(
      parsed.headers.reasoningintensity ?? parsed.headers.reasoning ?? parsed.headers.intensity,
      model
    );
    const attachExplicitWorkspaceFiles = parseBooleanLike(
      parsed.headers.attachexplicitworkspacefiles ?? parsed.headers.attachexplicitfiles
    );

    return {
      lane,
      prompt,
      workerMode,
      model,
      reasoningIntensity,
      attachExplicitWorkspaceFiles
    };
  }

  return {
    lane,
    prompt,
    mode: parseAutomationMode(parsed.headers.mode),
    maxSteps: parsePositiveInteger(parsed.headers.maxsteps),
    maxRuntimeMinutes: parsePositiveInteger(parsed.headers.maxruntimeminutes),
    maxRetries: parseNonNegativeInteger(parsed.headers.maxretries),
    paperWriteEnabled: parseBooleanLike(parsed.headers.paperwriteenabled ?? parsed.headers.paperwrite)
  };
}

function splitDirectiveHeaders(raw: string, lane: OrchestratorDelegationDirective["lane"]) {
  const lines = raw.split(/\r?\n/);
  const headers: Record<string, string> = {};
  let index = 0;

  while (index < lines.length && !lines[index].trim()) {
    index += 1;
  }

  if (index < lines.length && isLaneHeading(lines[index], lane)) {
    index += 1;
  }

  while (index < lines.length) {
    const line = lines[index].trim();

    if (!line) {
      index += 1;
      break;
    }

    const headerMatch = line.match(/^(?:[-*]\s*)?([A-Za-z][A-Za-z0-9 _-]{1,48}):\s*(.*)$/);

    if (!headerMatch) {
      break;
    }

    const key = normalizeHeaderKey(headerMatch[1]);

    if (!isKnownHeaderKey(lane, key)) {
      break;
    }

    if (key === "task") {
      const inlineTask = headerMatch[2].trim();
      const remainingBody = lines.slice(index + 1).join("\n").trim();
      return {
        headers,
        body: [inlineTask, remainingBody].filter(Boolean).join("\n\n")
      };
    }

    headers[key] = headerMatch[2].trim();
    index += 1;
  }

  return {
    headers,
    body: lines.slice(index).join("\n")
  };
}

function isLaneHeading(line: string, lane: OrchestratorDelegationDirective["lane"]) {
  const trimmed = line.trim().toLowerCase();

  if (!trimmed.startsWith("#")) {
    return false;
  }

  return (
    (lane === "builder" && /\bbuilder\b/.test(trimmed)) ||
    (lane === "strategist" && /\bstrategist\b/.test(trimmed)) ||
    (lane === "automation" && /\bautomation\b/.test(trimmed))
  );
}

function normalizeHeaderKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isKnownHeaderKey(lane: OrchestratorDelegationDirective["lane"], key: string) {
  if (lane === "builder") {
    return BUILDER_HEADER_KEYS.has(key);
  }

  if (lane === "strategist") {
    return STRATEGIST_HEADER_KEYS.has(key);
  }

  return AUTOMATION_HEADER_KEYS.has(key);
}

function parseBuilderExecutionMode(value: string | undefined): OrchestratorBuilderExecutionMode | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "live" || normalized === "sync" ? normalized : undefined;
}

function parseWorkerMode(value: string | undefined): AutomationWorkerMode | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "async" || normalized === "sync" ? normalized : undefined;
}

function parseBuilderModel(value: string | undefined): BuilderModel | undefined {
  const trimmed = value?.trim();
  return isBuilderModel(trimmed) ? trimmed : undefined;
}

function parseBuilderReasoning(value: string | undefined): BuilderReasoningEffort | undefined {
  const trimmed = value?.trim();
  return isBuilderReasoningEffort(trimmed) ? trimmed : undefined;
}

function parseOracleModel(value: string | undefined): OracleModel | undefined {
  const trimmed = value?.trim();
  return isOracleModel(trimmed) ? trimmed : undefined;
}

function parseStrategistIntensity(
  value: string | undefined,
  model: OracleModel | undefined
): OracleThinkingTime | undefined {
  const trimmed = value?.trim();

  if (!trimmed || !isOracleThinkingTime(trimmed)) {
    return undefined;
  }

  return model ? coerceStrategistThinkingTime(model, trimmed) : trimmed;
}

function parseAutomationMode(value: string | undefined): AutomationMode | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "continuous" || normalized === "checkpoint" ? normalized : undefined;
}

function parsePositiveInteger(value: string | undefined) {
  const parsed = Number.parseInt(value?.trim() || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined) {
  const parsed = Number.parseInt(value?.trim() || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseBooleanLike(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (["yes", "true", "on", "enable", "enabled", "y"].includes(normalized)) {
    return true;
  }

  if (["no", "false", "off", "disable", "disabled", "n"].includes(normalized)) {
    return false;
  }

  return undefined;
}
