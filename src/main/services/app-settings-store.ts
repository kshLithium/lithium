import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  coerceStrategistThinkingTime,
  isBuilderModel,
  isBuilderReasoningEffort,
  isOracleModel
} from "../../shared/model-config";
import {
  sanitizeCodeCanvasWidth,
  sanitizePaperPreviewWidth,
  sanitizeSidebarWidth
} from "../../shared/app-settings";
import {
  DEFAULT_APP_SETTINGS,
  type AutomationPromptLanguage,
  type AppSettings,
  type AppSettingsUpdate,
  type BuilderModel,
  type BuilderReasoningEffort,
  type DiscordBotSettings,
  type OracleModel,
  type OracleThinkingTime,
  type RemoteWorkspaceProfile,
  type TerminalConnectionProfile,
  type ThemePreference
} from "../../shared/types";

export class AppSettingsStore {
  constructor(
    private readonly filePath: string,
    private readonly legacyFilePath?: string
  ) {}

  async read(): Promise<AppSettings> {
    const current = await this.readFromPath(this.filePath);

    if (current) {
      return current;
    }

    if (!this.legacyFilePath || this.legacyFilePath === this.filePath) {
      return DEFAULT_APP_SETTINGS;
    }

    const legacy = await this.readFromPath(this.legacyFilePath);

    if (!legacy) {
      return DEFAULT_APP_SETTINGS;
    }

    await this.write(legacy);
    return legacy;
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
    themePreference: sanitizeThemePreference(candidate.themePreference),
    autopilotPromptLanguage: sanitizeAutomationPromptLanguage(candidate.autopilotPromptLanguage),
    onboardingDismissed:
      typeof candidate.onboardingDismissed === "boolean"
        ? candidate.onboardingDismissed
        : DEFAULT_APP_SETTINGS.onboardingDismissed,
    strategistSessionReady:
      typeof candidate.strategistSessionReady === "boolean"
        ? candidate.strategistSessionReady
        : DEFAULT_APP_SETTINGS.strategistSessionReady,
    lastWorkspacePath:
      typeof candidate.lastWorkspacePath === "string"
        ? candidate.lastWorkspacePath
        : DEFAULT_APP_SETTINGS.lastWorkspacePath,
    sidebarWidth: sanitizeSidebarWidth(candidate.sidebarWidth),
    codeCanvasWidth: sanitizeCodeCanvasWidth(candidate.codeCanvasWidth),
    paperPreviewWidth: sanitizePaperPreviewWidth(candidate.paperPreviewWidth),
    strategistModel: sanitizeOracleModel(candidate.strategistModel),
    strategistReasoningIntensity: sanitizeOracleThinkingTime(
      candidate.strategistReasoningIntensity,
      sanitizeOracleModel(candidate.strategistModel)
    ),
    builderModel: sanitizeBuilderModel(candidate.builderModel),
    builderReasoningEffort: sanitizeBuilderReasoningEffort(candidate.builderReasoningEffort),
    discordBot: sanitizeDiscordBotSettings(candidate.discordBot),
    terminalConnectionProfiles: sanitizeTerminalConnectionProfiles(candidate.terminalConnectionProfiles),
    remoteWorkspaceProfiles: sanitizeRemoteWorkspaceProfiles(candidate.remoteWorkspaceProfiles)
  };
}

export function sanitizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : DEFAULT_APP_SETTINGS.themePreference;
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

export function sanitizeDiscordBotSettings(value: unknown): DiscordBotSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_APP_SETTINGS.discordBot;
  }

  const candidate = value as Record<string, unknown>;

  return {
    enabled:
      typeof candidate.enabled === "boolean"
        ? candidate.enabled
        : DEFAULT_APP_SETTINGS.discordBot.enabled,
    token:
      typeof candidate.token === "string" ? candidate.token.trim() : DEFAULT_APP_SETTINGS.discordBot.token,
    workspacePath:
      typeof candidate.workspacePath === "string"
        ? candidate.workspacePath.trim()
        : DEFAULT_APP_SETTINGS.discordBot.workspacePath,
    allowedUserIds: sanitizeDiscordIdList(candidate.allowedUserIds),
    allowedChannelIds: sanitizeDiscordIdList(candidate.allowedChannelIds)
  };
}

export function sanitizeTerminalConnectionProfiles(value: unknown): TerminalConnectionProfile[] {
  if (!Array.isArray(value)) {
    return DEFAULT_APP_SETTINGS.terminalConnectionProfiles;
  }

  const seenIds = new Set<string>();

  return value
    .map((entry, index) => sanitizeTerminalConnectionProfile(entry, index))
    .filter((entry): entry is TerminalConnectionProfile => Boolean(entry))
    .map((entry, index) => {
      const baseId = entry.id || `terminal-profile-${index + 1}`;
      let nextId = baseId;
      let suffix = 2;

      while (seenIds.has(nextId)) {
        nextId = `${baseId}-${suffix}`;
        suffix += 1;
      }

      seenIds.add(nextId);

      return {
        ...entry,
        id: nextId
      };
    })
    .slice(0, 16);
}

export function sanitizeRemoteWorkspaceProfiles(value: unknown): RemoteWorkspaceProfile[] {
  if (!Array.isArray(value)) {
    return DEFAULT_APP_SETTINGS.remoteWorkspaceProfiles;
  }

  const seenIds = new Set<string>();

  return value
    .map((entry, index) => sanitizeRemoteWorkspaceProfile(entry, index))
    .filter((entry): entry is RemoteWorkspaceProfile => Boolean(entry))
    .map((entry, index) => {
      const baseId = entry.id || `remote-workspace-${index + 1}`;
      let nextId = baseId;
      let suffix = 2;

      while (seenIds.has(nextId)) {
        nextId = `${baseId}-${suffix}`;
        suffix += 1;
      }

      seenIds.add(nextId);

      return {
        ...entry,
        id: nextId
      };
    })
    .slice(0, 24);
}

function sanitizeTerminalConnectionProfile(value: unknown, index: number): TerminalConnectionProfile | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const command = typeof candidate.command === "string" ? candidate.command.trim() : "";

  if (!name || !command) {
    return null;
  }

  const id =
    typeof candidate.id === "string" && candidate.id.trim()
      ? candidate.id.trim()
      : `terminal-profile-${index + 1}`;
  const description =
    typeof candidate.description === "string" && candidate.description.trim()
      ? candidate.description.trim()
      : undefined;

  return {
    id,
    name,
    command,
    description
  };
}

function sanitizeDiscordIdList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean)
      .slice(0, 64)
  )];
}

function sanitizeRemoteWorkspaceProfile(value: unknown, index: number): RemoteWorkspaceProfile | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind === "container" || candidate.kind === "ssh" ? candidate.kind : null;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const host = typeof candidate.host === "string" ? candidate.host.trim() : "";
  const username = typeof candidate.username === "string" ? candidate.username.trim() : "";
  const remotePath = typeof candidate.remotePath === "string" ? candidate.remotePath.trim() : "";

  if (!kind || !name || !host || !username || !remotePath) {
    return null;
  }

  const id =
    typeof candidate.id === "string" && candidate.id.trim()
      ? candidate.id.trim()
      : `remote-workspace-${index + 1}`;
  const description =
    typeof candidate.description === "string" && candidate.description.trim()
      ? candidate.description.trim()
      : undefined;
  const port =
    typeof candidate.port === "number" &&
    Number.isFinite(candidate.port) &&
    candidate.port >= 1 &&
    candidate.port <= 65535
      ? Math.round(candidate.port)
      : undefined;
  const privateKeyPath =
    typeof candidate.privateKeyPath === "string" && candidate.privateKeyPath.trim()
      ? candidate.privateKeyPath.trim()
      : undefined;
  const hostFingerprint =
    typeof candidate.hostFingerprint === "string" && candidate.hostFingerprint.trim()
      ? candidate.hostFingerprint.trim()
      : undefined;
  const shell =
    typeof candidate.shell === "string" && candidate.shell.trim()
      ? candidate.shell.trim()
      : undefined;
  const bootstrapCommand =
    typeof candidate.bootstrapCommand === "string" && candidate.bootstrapCommand.trim()
      ? candidate.bootstrapCommand.trim()
      : undefined;
  const containerName =
    kind === "container" && typeof candidate.containerName === "string" && candidate.containerName.trim()
      ? candidate.containerName.trim()
      : undefined;
  const containerWorkspacePath =
    kind === "container" &&
    typeof candidate.containerWorkspacePath === "string" &&
    candidate.containerWorkspacePath.trim()
      ? candidate.containerWorkspacePath.trim()
      : undefined;
  const devcontainerConfigPath =
    kind === "container" &&
    typeof candidate.devcontainerConfigPath === "string" &&
    candidate.devcontainerConfigPath.trim()
      ? candidate.devcontainerConfigPath.trim()
      : undefined;
  const dockerContext =
    kind === "container" && typeof candidate.dockerContext === "string" && candidate.dockerContext.trim()
      ? candidate.dockerContext.trim()
      : undefined;

  if (kind === "container" && !containerName && !devcontainerConfigPath) {
    return null;
  }

  return {
    id,
    name,
    kind,
    host,
    username,
    remotePath,
    description,
    port,
    privateKeyPath,
    hostFingerprint,
    shell,
    bootstrapCommand,
    containerName,
    containerWorkspacePath,
    devcontainerConfigPath,
    dockerContext
  };
}
