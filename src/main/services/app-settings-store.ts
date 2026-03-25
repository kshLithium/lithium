import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  coerceStrategistThinkingTime,
  isBuilderModel,
  isBuilderReasoningEffort,
  isOracleModel
} from "../../shared/model-config";
import {
  DEFAULT_APP_SETTINGS,
  type AutomationPromptLanguage,
  type AppSettings,
  type AppSettingsUpdate,
  type BuilderModel,
  type BuilderReasoningEffort,
  type OracleModel,
  type OracleThinkingTime
} from "../../shared/types";

export class AppSettingsStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<AppSettings> {
    const current = await this.readFromPath(this.filePath);

    if (current) {
      return current;
    }

    return DEFAULT_APP_SETTINGS;
  }

  async update(update: AppSettingsUpdate): Promise<AppSettings> {
    const nextSettings = sanitizeAppSettings({
      ...(await this.read()),
      ...update
    });

    await this.write(nextSettings);
    return nextSettings;
  }

  private async readFromPath(filePath: string): Promise<AppSettings | null> {
    try {
      const raw = await readFile(filePath, "utf8");
      return sanitizeAppSettings(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async write(settings: AppSettings) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(settings, null, 2));
  }
}

export function sanitizeAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_APP_SETTINGS;
  }

  const candidate = value as Record<string, unknown>;

  return {
    autopilotPromptLanguage: sanitizeAutomationPromptLanguage(candidate.autopilotPromptLanguage),
    strategistSessionReady:
      typeof candidate.strategistSessionReady === "boolean"
        ? candidate.strategistSessionReady
        : DEFAULT_APP_SETTINGS.strategistSessionReady,
    lastWorkspacePath:
      typeof candidate.lastWorkspacePath === "string"
        ? candidate.lastWorkspacePath
        : DEFAULT_APP_SETTINGS.lastWorkspacePath,
    strategistModel: sanitizeOracleModel(candidate.strategistModel),
    strategistReasoningIntensity: sanitizeOracleThinkingTime(
      candidate.strategistReasoningIntensity,
      sanitizeOracleModel(candidate.strategistModel)
    ),
    builderModel: sanitizeBuilderModel(candidate.builderModel),
    builderReasoningEffort: sanitizeBuilderReasoningEffort(candidate.builderReasoningEffort)
  };
}

export function sanitizeAutomationPromptLanguage(value: unknown): AutomationPromptLanguage {
  return value === "auto" || value === "ko" || value === "en"
    ? value
    : DEFAULT_APP_SETTINGS.autopilotPromptLanguage;
}

export function sanitizeOracleModel(value: unknown): OracleModel {
  return isOracleModel(value) ? value : DEFAULT_APP_SETTINGS.strategistModel;
}

export function sanitizeOracleThinkingTime(
  value: unknown,
  model: OracleModel = DEFAULT_APP_SETTINGS.strategistModel
): OracleThinkingTime {
  return coerceStrategistThinkingTime(model, value);
}

export function sanitizeBuilderModel(value: unknown): BuilderModel {
  return isBuilderModel(value) ? value : DEFAULT_APP_SETTINGS.builderModel;
}

export function sanitizeBuilderReasoningEffort(value: unknown): BuilderReasoningEffort {
  return isBuilderReasoningEffort(value) ? value : DEFAULT_APP_SETTINGS.builderReasoningEffort;
}
