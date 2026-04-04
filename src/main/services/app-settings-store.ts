import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isBuilderModel,
  isBuilderReasoningEffort,
  normalizeOracleModel,
  normalizeOracleThinkingTime
} from "../../shared/model-config";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppSettingsUpdate,
  type BuilderModel,
  type BuilderReasoningEffort,
  type OracleModel,
  type OracleThinkingTime
} from "../../shared/types";

export class AppSettingsStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<AppSettings> {
    await this.writeQueue.catch(() => undefined);
    return await this.readCurrent();
  }

  async update(update: AppSettingsUpdate): Promise<AppSettings> {
    let nextSettings = DEFAULT_APP_SETTINGS;

    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      nextSettings = sanitizeAppSettings({
        ...(await this.readCurrent()),
        ...update
      });

      await this.write(nextSettings);
    });

    await this.writeQueue;
    return nextSettings;
  }

  private async readCurrent(): Promise<AppSettings> {
    const current = await this.readFromPath(this.filePath);
    return current ?? DEFAULT_APP_SETTINGS;
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
    const directory = path.dirname(this.filePath);
    const tempPath = path.join(
      directory,
      `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`
    );

    await mkdir(directory, { recursive: true });

    try {
      await writeFile(tempPath, JSON.stringify(settings, null, 2), "utf8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function sanitizeAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_APP_SETTINGS;
  }

  const candidate = value as Record<string, unknown>;

  return {
    promptLanguage: sanitizePromptLanguage(candidate.promptLanguage),
    oracleSessionReady:
      typeof candidate.oracleSessionReady === "boolean"
        ? candidate.oracleSessionReady
        : DEFAULT_APP_SETTINGS.oracleSessionReady,
    lastWorkspacePath:
      typeof candidate.lastWorkspacePath === "string"
        ? candidate.lastWorkspacePath
        : DEFAULT_APP_SETTINGS.lastWorkspacePath,
    oracleModel: sanitizeOracleModel(candidate.oracleModel),
    oracleThinkingTime: sanitizeOracleThinkingTime(
      candidate.oracleThinkingTime,
      sanitizeOracleModel(candidate.oracleModel)
    ),
    builderModel: sanitizeBuilderModel(candidate.builderModel),
    builderReasoningEffort: sanitizeBuilderReasoningEffort(candidate.builderReasoningEffort)
  };
}

export function sanitizePromptLanguage(...values: unknown[]): AppSettings["promptLanguage"] {
  const value = values.find((candidate) => typeof candidate === "string");
  return value === "auto" || value === "ko" || value === "en"
    ? value
    : DEFAULT_APP_SETTINGS.promptLanguage;
}

export function sanitizeOracleModel(...values: unknown[]): OracleModel {
  return normalizeOracleModel(values.find((candidate) => candidate !== undefined));
}

export function sanitizeOracleThinkingTime(
  value: unknown,
  _model: OracleModel = DEFAULT_APP_SETTINGS.oracleModel
): OracleThinkingTime {
  return normalizeOracleThinkingTime(value);
}

export function sanitizeBuilderModel(value: unknown): BuilderModel {
  return isBuilderModel(value) ? value : DEFAULT_APP_SETTINGS.builderModel;
}

export function sanitizeBuilderReasoningEffort(value: unknown): BuilderReasoningEffort {
  return isBuilderReasoningEffort(value) ? value : DEFAULT_APP_SETTINGS.builderReasoningEffort;
}
