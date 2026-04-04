import type {
  BuilderModel,
  BuilderReasoningEffort,
  OracleModel,
  OracleThinkingTime
} from "./types";

export const ORACLE_MODELS = ["gpt-5.4-pro"] as const;
export const ORACLE_THINKING_TIMES = ["extended"] as const;
export const BUILDER_MODELS = ["gpt-5.4", "gpt-5.3-codex"] as const;
export const BUILDER_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export const PREFERRED_ORACLE_MODEL: OracleModel = "gpt-5.4-pro";
export const PREFERRED_ORACLE_THINKING_TIME: OracleThinkingTime = "extended";

const ORACLE_MODEL_DISPLAY_LABELS: Record<OracleModel, string> = {
  "gpt-5.4-pro": "Pro"
};

export const ORACLE_MODEL_OPTIONS: ReadonlyArray<{ value: OracleModel; label: string }> = [
  { value: "gpt-5.4-pro", label: getOracleModelDisplayLabel("gpt-5.4-pro") }
];

export const BUILDER_MODEL_OPTIONS: ReadonlyArray<{ value: BuilderModel; label: string }> = [
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" }
];

export const BUILDER_REASONING_OPTIONS: ReadonlyArray<{
  value: BuilderReasoningEffort;
  label: string;
}> = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" }
];

const ORACLE_THINKING_TIME_OPTIONS: ReadonlyArray<{
  value: OracleThinkingTime;
  label: string;
}> = [
  { value: "extended", label: "Extended" }
];

const ORACLE_THINKING_TIME_VALUES_BY_MODEL: Record<OracleModel, readonly OracleThinkingTime[]> = {
  "gpt-5.4-pro": ["extended"]
};

export function isOracleModel(value: unknown): value is OracleModel {
  return typeof value === "string" && (ORACLE_MODELS as readonly string[]).includes(value);
}

export function isOracleThinkingTime(value: unknown): value is OracleThinkingTime {
  return typeof value === "string" && (ORACLE_THINKING_TIMES as readonly string[]).includes(value);
}

export function isBuilderModel(value: unknown): value is BuilderModel {
  return typeof value === "string" && (BUILDER_MODELS as readonly string[]).includes(value);
}

export function isBuilderReasoningEffort(value: unknown): value is BuilderReasoningEffort {
  return typeof value === "string" && (BUILDER_REASONING_EFFORTS as readonly string[]).includes(value);
}

export function normalizeOracleModel(_value?: unknown): OracleModel {
  return PREFERRED_ORACLE_MODEL;
}

export function normalizeOracleThinkingTime(_value?: unknown): OracleThinkingTime {
  return PREFERRED_ORACLE_THINKING_TIME;
}

export function getOracleModelDisplayLabel(model: OracleModel): string {
  return ORACLE_MODEL_DISPLAY_LABELS[model];
}

export function getOraclePerspectiveLabel(model: OracleModel): string {
  return `${getOracleModelDisplayLabel(model)} planner`;
}

export function getOracleThinkingTimeValues(model: OracleModel): readonly OracleThinkingTime[] {
  return ORACLE_THINKING_TIME_VALUES_BY_MODEL[model];
}

export function getOracleThinkingOptions(model: OracleModel) {
  const allowed = new Set(getOracleThinkingTimeValues(model));
  return ORACLE_THINKING_TIME_OPTIONS.filter((option) => allowed.has(option.value));
}

export function getDefaultOracleThinkingTime(model: OracleModel): OracleThinkingTime {
  return getOracleThinkingTimeValues(model)[0] ?? PREFERRED_ORACLE_THINKING_TIME;
}

export function coerceOracleThinkingTime(
  model: OracleModel,
  value: unknown,
  fallback?: OracleThinkingTime
): OracleThinkingTime {
  if (isOracleThinkingTime(value) && getOracleThinkingTimeValues(model).includes(value)) {
    return value;
  }

  if (fallback && getOracleThinkingTimeValues(model).includes(fallback)) {
    return fallback;
  }

  return getDefaultOracleThinkingTime(model);
}
