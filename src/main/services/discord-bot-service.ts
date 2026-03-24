import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message
} from "discord.js";
import type {
  BuilderRunControlRequest,
  BuilderRunInspection,
  ChatRequest,
  DiscordBotRuntimeStatus,
  DiscordBotSettings,
  ProjectSnapshot,
  RunRecord,
  ThreadCreateRequest
} from "../../shared/types";

const DISCORD_MESSAGE_LIMIT = 1_900;
const THREAD_TITLE_LIMIT = 64;
const RUN_POLL_INTERVAL_MS = 2_000;
const STATE_FILE_DIR = path.join(".lithium", "integrations");
const STATE_FILE_NAME = "discord-bot.json";
const STATUS_MARKER = "LITHIUM_STATUS";
const DEFAULT_DISCORD_BOT_STATUS: DiscordBotRuntimeStatus = {
  state: "disabled",
  botTag: "",
  botUserId: "",
  lastError: null,
  workspacePath: ""
};

export type DiscordBotConfig = {
  enabled: boolean;
  token: string;
  workspacePath: string;
  allowedUserIds: string[];
  allowedChannelIds: string[];
};

export type DiscordConversationRequest = {
  key: string;
  prompt: string;
  threadTitle: string;
};

export type DiscordBotBridge = {
  resolveWorkspacePath: () => Promise<string>;
  getSnapshot: (workspacePath: string) => Promise<ProjectSnapshot>;
  createThread: (request: ThreadCreateRequest) => Promise<ProjectSnapshot>;
  sendChatMessage: (request: ChatRequest) => Promise<ProjectSnapshot>;
  inspectBuilderRun: (request: BuilderRunControlRequest) => Promise<BuilderRunInspection | null>;
};

type DiscordBotDependencies = {
  bridge: DiscordBotBridge;
  log?: (message: string) => void;
};

type DiscordConversationState = {
  version: 1;
  conversations: Record<
    string,
    {
      threadId: string;
      title: string;
      updatedAt: string;
    }
  >;
};

type DerivedReply = {
  initialReply: string;
  followUpRunId: string | null;
};

export class DiscordBotService {
  private readonly bridge: DiscordBotBridge;
  private readonly log: (message: string) => void;
  private readonly conversationQueue = new Map<string, Promise<void>>();
  private client: Client | null = null;
  private status: DiscordBotRuntimeStatus = DEFAULT_DISCORD_BOT_STATUS;
  private config: DiscordBotConfig = {
    enabled: false,
    token: "",
    workspacePath: "",
    allowedUserIds: [],
    allowedChannelIds: []
  };

  constructor(dependencies: DiscordBotDependencies) {
    this.bridge = dependencies.bridge;
    this.log = dependencies.log ?? (() => undefined);
  }

  getStatus(): DiscordBotRuntimeStatus {
    return { ...this.status };
  }

  async configure(config: DiscordBotConfig) {
    const nextConfig = normalizeDiscordBotConfig(config);
    const configChanged = serializeConfig(this.config) !== serializeConfig(nextConfig);

    this.config = nextConfig;

    if (!configChanged) {
      return;
    }

    if (this.client) {
      await this.stop("reconfigure");
    }

    if (!this.config.enabled) {
      this.updateStatus({
        state: "disabled",
        botTag: "",
        botUserId: "",
        lastError: null,
        workspacePath: this.config.workspacePath
      });
      return;
    }

    await this.start();
  }

  async start() {
    if (!this.config.enabled) {
      this.updateStatus({
        state: "disabled",
        botTag: "",
        botUserId: "",
        lastError: null,
        workspacePath: this.config.workspacePath
      });
      return;
    }

    if (!this.config.token) {
      this.updateStatus({
        state: "error",
        botTag: "",
        botUserId: "",
        lastError: "Discord bot token is missing.",
        workspacePath: this.config.workspacePath
      });
      this.log("[discord] bot disabled: token not configured");
      return;
    }

    if (this.client) {
      return;
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages
      ],
      partials: [Partials.Channel]
    });

    this.updateStatus({
      state: "connecting",
      botTag: "",
      botUserId: "",
      lastError: null,
      workspacePath: this.config.workspacePath
    });
    client.once("ready", () => {
      this.updateStatus({
        state: "connected",
        botTag: client.user?.tag ?? "",
        botUserId: client.user?.id ?? "",
        lastError: null,
        workspacePath: this.config.workspacePath
      });
      this.log(
        `[discord] connected as ${client.user?.tag ?? "unknown"} (${client.user?.id ?? "no-id"})`
      );
    });
    client.on("error", (error) => {
      this.updateStatus({
        state: "error",
        botTag: this.status.botTag,
        botUserId: this.status.botUserId,
        lastError: formatError(error),
        workspacePath: this.config.workspacePath
      });
      this.log(`[discord] client error: ${formatError(error)}`);
    });
    client.on("messageCreate", (message) => {
      void this.handleIncomingMessage(message);
    });

    try {
      await client.login(this.config.token);
      this.client = client;
    } catch (error) {
      client.removeAllListeners();
      client.destroy();
      this.updateStatus({
        state: "error",
        botTag: "",
        botUserId: "",
        lastError: formatError(error),
        workspacePath: this.config.workspacePath
      });
      this.log(`[discord] login failed: ${formatError(error)}`);
      throw error;
    }
  }

  async stop(reason: "disabled" | "reconfigure" | "shutdown" = "disabled") {
    const activeClient = this.client;
    this.client = null;

    if (!activeClient) {
      return;
    }

    activeClient.removeAllListeners();
    activeClient.destroy();

    if (reason !== "shutdown") {
      this.updateStatus({
        state: "disabled",
        botTag: "",
        botUserId: "",
        lastError: null,
        workspacePath: this.config.workspacePath
      });
    }

    this.log(reason === "reconfigure" ? "[discord] reconfiguring" : "[discord] stopped");
  }

  private async handleIncomingMessage(message: Message<boolean>) {
    if (!this.client?.user || message.author.bot) {
      return;
    }

    const request = this.normalizeConversationRequest(message, this.client.user.id);

    if (!request) {
      return;
    }

    const wasQueued = this.conversationQueue.has(request.key);

    if (wasQueued) {
      await this.reply(message, "Previous request is still running. Queued this one.");
    }

    const previous = this.conversationQueue.get(request.key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.processConversationMessage(message, request);
        } catch (error) {
          this.log(`[discord] request failed: ${formatError(error)}`);
          await this.reply(
            message,
            `Lithium failed to handle that request.\n\n${formatError(error)}`
          ).catch(() => undefined);
        }
      })
      .finally(() => {
        if (this.conversationQueue.get(request.key) === next) {
          this.conversationQueue.delete(request.key);
        }
      });

    this.conversationQueue.set(request.key, next);
  }

  private normalizeConversationRequest(
    message: Message<boolean>,
    botUserId: string
  ): DiscordConversationRequest | null {
    if (!this.isAllowedUser(message.author.id)) {
      return null;
    }

    if (!message.inGuild()) {
      const prompt = message.content.trim();

      if (!prompt) {
        return null;
      }

      return {
        key: `dm:${message.author.id}`,
        prompt,
        threadTitle: truncateThreadTitle(`Discord DM - ${message.author.username}`)
      };
    }

    if (!this.config.allowedChannelIds.includes(message.channelId)) {
      return null;
    }

    if (!message.mentions.has(botUserId)) {
      return null;
    }

    const prompt = stripBotMention(message.content, botUserId).trim();

    if (!prompt) {
      return {
        key: `guild:${message.guildId}:${message.channelId}`,
        prompt: "",
        threadTitle: truncateThreadTitle(
          `Discord - ${message.guild?.name ?? "server"} #${resolveChannelLabel(message)}`
        )
      };
    }

    return {
      key: `guild:${message.guildId}:${message.channelId}`,
      prompt,
      threadTitle: truncateThreadTitle(
        `Discord - ${message.guild?.name ?? "server"} #${resolveChannelLabel(message)}`
      )
    };
  }

  private async processConversationMessage(
    message: Message<boolean>,
    request: DiscordConversationRequest
  ) {
    if (!request.prompt) {
      await this.reply(message, "Mention the bot with a text prompt after the mention.");
      return;
    }

    const workspacePath = (await this.bridge.resolveWorkspacePath()).trim();

    if (!workspacePath) {
      await this.reply(
        message,
        "No workspace is configured for Discord yet. Set LITHIUM_DISCORD_WORKSPACE or pick a workspace in the desktop app first."
      );
      return;
    }

    if ("sendTyping" in message.channel && typeof message.channel.sendTyping === "function") {
      await message.channel.sendTyping().catch(() => undefined);
    }

    const threadId = await this.ensureConversationThread(workspacePath, request);
    const requestStartedAtMs = Date.now();
    const snapshot = await this.bridge.sendChatMessage({
      workspacePath,
      threadId,
      prompt: request.prompt
    });
    const derivedReply = deriveReply(snapshot, threadId, requestStartedAtMs);

    if (derivedReply.initialReply) {
      await this.reply(message, derivedReply.initialReply);
    }

    if (!derivedReply.followUpRunId) {
      return;
    }

    const finalizedRun = await this.waitForRunCompletion(workspacePath, derivedReply.followUpRunId);
    const followUp =
      finalizedRun === null
        ? "Builder is still running in Lithium. Check the desktop app for the latest state."
        : formatRunCompletion(finalizedRun);

    await this.reply(message, followUp);
  }

  private async ensureConversationThread(
    workspacePath: string,
    request: DiscordConversationRequest
  ) {
    const snapshot = await this.bridge.getSnapshot(workspacePath);
    const state = await this.readState(workspacePath);
    const existingThreadId = state.conversations[request.key]?.threadId ?? "";
    const existingThread = snapshot.threads.find((thread) => thread.id === existingThreadId) ?? null;

    if (existingThread) {
      state.conversations[request.key] = {
        threadId: existingThread.id,
        title: existingThread.title,
        updatedAt: new Date().toISOString()
      };
      await this.writeState(workspacePath, state);
      return existingThread.id;
    }

    const created = await this.bridge.createThread({
      workspacePath,
      title: request.threadTitle
    });
    const nextThreadId = created.activeThread?.id ?? created.activeThreadId ?? "";

    if (!nextThreadId) {
      throw new Error("Discord bridge could not allocate an Lithium thread.");
    }

    state.conversations[request.key] = {
      threadId: nextThreadId,
      title: request.threadTitle,
      updatedAt: new Date().toISOString()
    };
    await this.writeState(workspacePath, state);

    return nextThreadId;
  }

  private async waitForRunCompletion(workspacePath: string, runId: string) {
    while (true) {
      const inspection = await this.bridge.inspectBuilderRun({
        workspacePath,
        runId
      });
      const run = inspection?.run;

      if (!run) {
        return null;
      }

      if (run.status !== "running") {
        return run;
      }

      await delay(RUN_POLL_INTERVAL_MS);
    }
  }

  private async readState(workspacePath: string): Promise<DiscordConversationState> {
    try {
      const raw = await readFile(resolveStateFilePath(workspacePath), "utf8");
      return normalizeState(JSON.parse(raw));
    } catch {
      return createEmptyState();
    }
  }

  private async writeState(workspacePath: string, state: DiscordConversationState) {
    const filePath = resolveStateFilePath(workspacePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  }

  private isAllowedUser(userId: string) {
    return this.config.allowedUserIds.length === 0 || this.config.allowedUserIds.includes(userId);
  }

  private updateStatus(status: DiscordBotRuntimeStatus) {
    this.status = status;
  }

  private async reply(message: Message<boolean>, content: string) {
    await message.reply({
      content: truncateDiscordMessage(content),
      allowedMentions: {
        repliedUser: false
      }
    });
  }
}

export function parseDiscordBotConfig(env: NodeJS.ProcessEnv): DiscordBotConfig {
  const token =
    env.LITHIUM_DISCORD_BOT_TOKEN?.trim() || env.DISCORD_BOT_TOKEN?.trim() || "";

  return {
    enabled: Boolean(token),
    token,
    workspacePath:
      env.LITHIUM_DISCORD_WORKSPACE?.trim() || env.LITHIUM_WORKSPACE?.trim() || "",
    allowedUserIds: parseCsvEnv(env.LITHIUM_DISCORD_ALLOWED_USER_IDS),
    allowedChannelIds: parseCsvEnv(env.LITHIUM_DISCORD_ALLOWED_CHANNEL_IDS)
  };
}

export function resolveDiscordBotConfig(
  settings: DiscordBotSettings | undefined,
  env: NodeJS.ProcessEnv = process.env
): DiscordBotConfig {
  if (!settings || !hasExplicitDiscordBotSettings(settings)) {
    return parseDiscordBotConfig(env);
  }

  return normalizeDiscordBotConfig({
    enabled: settings.enabled,
    token: settings.token,
    workspacePath: settings.workspacePath,
    allowedUserIds: settings.allowedUserIds,
    allowedChannelIds: settings.allowedChannelIds
  });
}

export function stripBotMention(content: string, botUserId: string) {
  return content
    .replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateDiscordMessage(content: string, maxLength = DISCORD_MESSAGE_LIMIT) {
  const normalized = content.replace(/\r\n/g, "\n").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function deriveReply(
  snapshot: ProjectSnapshot,
  threadId: string,
  requestStartedAtMs: number
): DerivedReply {
  const latestDecision =
    snapshot.latestDecision &&
    snapshot.latestDecision.threadId === threadId &&
    new Date(snapshot.latestDecision.createdAt).getTime() >= requestStartedAtMs - 1_000
      ? snapshot.latestDecision
      : null;
  const latestRun =
    snapshot.latestRun &&
    snapshot.latestRun.threadId === threadId &&
    new Date(snapshot.latestRun.startedAt).getTime() >= requestStartedAtMs - 1_000
      ? snapshot.latestRun
      : null;

  if (latestRun?.status === "running") {
    return {
      initialReply: latestDecision
        ? `${latestDecision.summary}\n\nBuilder started for the follow-up task. I'll send another message when it finishes.`
        : "Builder started for this request. I'll send another message when it finishes.",
      followUpRunId: latestRun.id
    };
  }

  if (latestRun) {
    return {
      initialReply: latestDecision
        ? `${latestDecision.summary}\n\n${formatRunCompletion(latestRun)}`
        : formatRunCompletion(latestRun),
      followUpRunId: null
    };
  }

  if (latestDecision) {
    return {
      initialReply: latestDecision.summary.trim() || "Request completed.",
      followUpRunId: null
    };
  }

  return {
    initialReply: "Lithium finished the request, but no reply summary was recorded.",
    followUpRunId: null
  };
}

function formatRunCompletion(run: RunRecord) {
  const summary =
    run.handoff?.summary?.trim() ||
    summarizeBuilderFinalMessage(run.finalMessage) ||
    `Builder finished with status ${run.status}.`;

  if (run.status === "completed") {
    return summary;
  }

  if (run.status === "failed") {
    return `Builder failed.\n\n${summary}`;
  }

  if (run.status === "cancelled") {
    return `Builder stopped.\n\n${summary}`;
  }

  return `Builder finished with status ${run.status}.\n\n${summary}`;
}

function summarizeBuilderFinalMessage(finalMessage: string) {
  const beforeMarker = finalMessage.split(STATUS_MARKER)[0]?.trim() ?? "";

  if (!beforeMarker) {
    return "";
  }

  return beforeMarker.replace(/\s+/g, " ").trim();
}

function resolveChannelLabel(message: Message<boolean>) {
  if ("name" in message.channel && typeof message.channel.name === "string" && message.channel.name.trim()) {
    return message.channel.name.trim();
  }

  return "dm";
}

function truncateThreadTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();

  if (normalized.length <= THREAD_TITLE_LIMIT) {
    return normalized;
  }

  return normalized.slice(0, THREAD_TITLE_LIMIT).trimEnd();
}

function parseCsvEnv(value: string | undefined) {
  if (!value) {
    return [];
  }

  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function hasExplicitDiscordBotSettings(settings: DiscordBotSettings) {
  return Boolean(
    settings.enabled ||
      settings.token.trim() ||
      settings.workspacePath.trim() ||
      settings.allowedUserIds.length ||
      settings.allowedChannelIds.length
  );
}

function normalizeDiscordBotConfig(config: DiscordBotConfig): DiscordBotConfig {
  return {
    enabled: Boolean(config.enabled && config.token.trim()),
    token: config.token.trim(),
    workspacePath: config.workspacePath.trim(),
    allowedUserIds: normalizeIdList(config.allowedUserIds),
    allowedChannelIds: normalizeIdList(config.allowedChannelIds)
  };
}

function normalizeIdList(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function serializeConfig(config: DiscordBotConfig) {
  return JSON.stringify(normalizeDiscordBotConfig(config));
}

function resolveStateFilePath(workspacePath: string) {
  return path.join(workspacePath, STATE_FILE_DIR, STATE_FILE_NAME);
}

function normalizeState(value: unknown): DiscordConversationState {
  if (!value || typeof value !== "object") {
    return createEmptyState();
  }

  const candidate = value as Record<string, unknown>;
  const conversationsValue = candidate.conversations;

  if (!conversationsValue || typeof conversationsValue !== "object") {
    return createEmptyState();
  }

  const normalizedConversations = Object.fromEntries(
    Object.entries(conversationsValue as Record<string, unknown>)
      .map(([key, entry]) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const record = entry as Record<string, unknown>;
        const threadId = typeof record.threadId === "string" ? record.threadId.trim() : "";
        const title = typeof record.title === "string" ? record.title.trim() : "";
        const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt.trim() : "";

        if (!threadId || !title || !updatedAt) {
          return null;
        }

        return [key, { threadId, title, updatedAt }] as const;
      })
      .filter((entry): entry is readonly [string, DiscordConversationState["conversations"][string]] => Boolean(entry))
  );

  return {
    version: 1,
    conversations: normalizedConversations
  };
}

function createEmptyState(): DiscordConversationState {
  return {
    version: 1,
    conversations: {}
  };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
