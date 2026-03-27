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
export const PREFERRED_STRATEGIST_MODEL: OracleModel = "gpt-5.4-pro";
export const PREFERRED_STRATEGIST_THINKING_TIME: OracleThinkingTime = "extended";

const STRATEGIST_MODEL_DISPLAY_LABELS: Record<OracleModel, string> = {
  "gpt-5.4-pro": "Pro"
};

export const STRATEGIST_MODEL_OPTIONS: ReadonlyArray<{ value: OracleModel; label: string }> = [
  { value: "gpt-5.4-pro", label: getStrategistModelDisplayLabel("gpt-5.4-pro") }
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

const STRATEGIST_THINKING_TIME_OPTIONS: ReadonlyArray<{
  value: OracleThinkingTime;
  label: string;
}> = [
  { value: "extended", label: "Extended" }
];

const STRATEGIST_THINKING_TIME_VALUES_BY_MODEL: Record<OracleModel, readonly OracleThinkingTime[]> = {
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

export function normalizeStrategistModel(_value?: unknown): OracleModel {
  return PREFERRED_STRATEGIST_MODEL;
}

export function normalizeStrategistThinkingTime(_value?: unknown): OracleThinkingTime {
  return PREFERRED_STRATEGIST_THINKING_TIME;
}

export function getStrategistModelDisplayLabel(model: OracleModel): string {
  return STRATEGIST_MODEL_DISPLAY_LABELS[model];
}

export function getStrategistPerspectiveLabel(model: OracleModel): string {
  return `${getStrategistModelDisplayLabel(model)} strategist`;
}

export function getStrategistThinkingTimeValues(model: OracleModel): readonly OracleThinkingTime[] {
  return STRATEGIST_THINKING_TIME_VALUES_BY_MODEL[model];
}

export function getStrategistThinkingOptions(model: OracleModel) {
  const allowed = new Set(getStrategistThinkingTimeValues(model));
  return STRATEGIST_THINKING_TIME_OPTIONS.filter((option) => allowed.has(option.value));
}

export function getDefaultStrategistThinkingTime(model: OracleModel): OracleThinkingTime {
  return PREFERRED_STRATEGIST_THINKING_TIME;
}

export function coerceStrategistThinkingTime(
  model: OracleModel,
  value: unknown,
  fallback?: OracleThinkingTime
): OracleThinkingTime {
  if (isOracleThinkingTime(value) && getStrategistThinkingTimeValues(model).includes(value)) {
    return value;
  }

  if (fallback && getStrategistThinkingTimeValues(model).includes(fallback)) {
    return fallback;
  }

  return getDefaultStrategistThinkingTime(model);
}
