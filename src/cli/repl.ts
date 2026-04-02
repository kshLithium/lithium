import path from "node:path";
import readline from "node:readline";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AppSettingsStore } from "../main/services/app-settings-store";
import type { AppService } from "../main/services/app-service";
import type {
  AppSettings,
  ChatProgressInspection,
  ConversationEntryRecord,
  ProjectSnapshot,
  ThreadRecord
} from "../shared/types";

type CliService = Pick<
  AppService,
  | "setSelectedWorkspacePath"
  | "initProject"
  | "getSnapshot"
  | "createThread"
  | "selectThread"
  | "sendChatMessage"
  | "inspectChatProgress"
  | "importAttachments"
  | "beginStrategistSignIn"
>;

type CliSettingsStore = Pick<AppSettingsStore, "read" | "update">;

type CliControllerOptions = {
  service: CliService;
  settingsStore: CliSettingsStore;
  writeLine: (line?: string) => void;
  cwd?: () => string;
  historyLimit?: number;
};

type HandleLineResult = "continue" | "exit";

type StartCliReplOptions = {
  controller: LithiumCliController;
  input: Readable;
  output: Writable & { isTTY?: boolean };
  pollIntervalMs?: number;
};

export type CliStatusSnapshot = {
  workspacePath: string;
  activeThread: ThreadRecord | null;
  threadCount: number;
  attachmentCount: number;
  latestDecisionSummary: string;
  latestRunStatus: string;
  latestRunSummary: string;
  automationStatus: string;
  automationSummary: string;
  progress: ChatProgressInspection | null;
};

export class LithiumCliController {
  private readonly service: CliService;
  private readonly settingsStore: CliSettingsStore;
  private readonly writeLine: (line?: string) => void;
  private readonly cwd: () => string;
  private readonly historyLimit: number;
  private currentWorkspacePath = "";
  private currentSnapshot: ProjectSnapshot | null = null;
  private readonly printedConversationEntries = new Set<string>();
  private lastProgressSignature = "";

  constructor(options: CliControllerOptions) {
    this.service = options.service;
    this.settingsStore = options.settingsStore;
    this.writeLine = options.writeLine;
    this.cwd = options.cwd ?? (() => process.cwd());
    this.historyLimit = options.historyLimit ?? 8;
  }

  async initialize(workspacePath: string) {
    const resolvedWorkspacePath = resolveWorkspacePath(workspacePath, this.cwd);
    this.writeLine("Lithium CLI");
    this.writeLine("Type :help for commands.");
    await this.activateWorkspace(resolvedWorkspacePath, "startup");
  }

  buildPrompt() {
    const workspaceLabel = this.currentSnapshot?.project?.name?.trim() || path.basename(this.currentWorkspacePath) || "lithium";
    const threadLabel = this.currentSnapshot?.activeThread?.title?.trim() || "main";
    return `${workspaceLabel}:${threadLabel}> `;
  }

  async handleLine(rawLine: string): Promise<HandleLineResult> {
    const line = rawLine.trim();

    if (!line) {
      return "continue";
    }

    if (line.startsWith(":")) {
      return await this.handleCommand(line);
    }

    await this.runChatTurn(line);
    return "continue";
  }

  async pollOnce() {
    if (!this.currentWorkspacePath) {
      return;
    }

    const [progress, snapshot] = await Promise.all([
      this.service.inspectChatProgress({
        workspacePath: this.currentWorkspacePath
      }),
      this.service.getSnapshot(this.currentWorkspacePath)
    ]);

    this.emitProgress(progress);
    this.refreshSnapshot(snapshot);
  }

  async readStatus(): Promise<CliStatusSnapshot> {
    if (!this.currentWorkspacePath) {
      throw new Error("No workspace is selected.");
    }

    const [progress, snapshot] = await Promise.all([
      this.service.inspectChatProgress({
        workspacePath: this.currentWorkspacePath
      }),
      this.service.getSnapshot(this.currentWorkspacePath)
    ]);

    this.currentSnapshot = snapshot;

    return {
      workspacePath: this.currentWorkspacePath,
      activeThread: snapshot.activeThread,
      threadCount: snapshot.threads.length,
      attachmentCount: snapshot.activeThreadAttachments.length,
      latestDecisionSummary: snapshot.latestDecision?.summary?.trim() || "none",
      latestRunStatus: snapshot.latestRun?.status || "none",
      latestRunSummary: summarizeRun(snapshot.latestRun?.finalMessage || ""),
      automationStatus: snapshot.latestAutomationSession?.status || "none",
      automationSummary: snapshot.latestAutomationSession?.currentStepSummary || "none",
      progress
    };
  }

  private async handleCommand(rawLine: string): Promise<HandleLineResult> {
    const body = rawLine.slice(1).trim();
    const tokens = splitShellLikeArguments(body);
    const command = tokens[0]?.toLowerCase() || "";

    switch (command) {
      case "help":
        this.printHelp();
        return "continue";
      case "workspace":
        await this.handleWorkspaceCommand(tokens.slice(1));
        return "continue";
      case "threads":
        this.printThreads();
        return "continue";
      case "thread":
        await this.handleThreadCommand(tokens.slice(1));
        return "continue";
      case "attach":
        await this.handleAttachCommand(tokens.slice(1));
        return "continue";
      case "signin":
        await this.handleSignInCommand();
        return "continue";
      case "status":
        await this.handleStatusCommand();
        return "continue";
      case "exit":
      case "quit":
        this.writeLine("Bye.");
        return "exit";
      default:
        this.writeLine(`Unknown command: ${rawLine}`);
        this.writeLine("Type :help for the supported commands.");
        return "continue";
    }
  }

  private async handleWorkspaceCommand(args: string[]) {
    if (!args.length) {
      this.writeLine(`[workspace] ${this.currentWorkspacePath || "none"}`);
      return;
    }

    const nextWorkspacePath = resolveWorkspacePath(args.join(" "), this.cwd);
    await this.activateWorkspace(nextWorkspacePath, "switch");
  }

  private async handleThreadCommand(args: string[]) {
    const subcommand = args[0]?.toLowerCase();

    if (!subcommand) {
      throw new Error("Usage: :thread new [title] | :thread use <id|index>");
    }

    if (subcommand === "new") {
      const title = args.slice(1).join(" ").trim() || undefined;
      const snapshot = await this.service.createThread({
        workspacePath: this.requireWorkspacePath(),
        title
      });
      this.refreshSnapshot(snapshot, {
        clearPrintedHistory: true,
        emitEntries: false
      });
      this.writeLine(`[thread] Switched to ${snapshot.activeThread?.title || "new thread"}`);
      this.printRecentConversation(snapshot);
      return;
    }

    if (subcommand === "use") {
      const target = args.slice(1).join(" ").trim();

      if (!target) {
        throw new Error("Usage: :thread use <id|index>");
      }

      const snapshot = this.requireSnapshot();
      const threadId = resolveThreadSelection(target, snapshot.threads);
      const nextSnapshot = await this.service.selectThread({
        workspacePath: this.requireWorkspacePath(),
        threadId
      });
      this.refreshSnapshot(nextSnapshot, {
        clearPrintedHistory: true,
        emitEntries: false
      });
      this.writeLine(`[thread] Switched to ${nextSnapshot.activeThread?.title || threadId}`);
      this.printRecentConversation(nextSnapshot);
      return;
    }

    throw new Error("Usage: :thread new [title] | :thread use <id|index>");
  }

  private async handleAttachCommand(args: string[]) {
    if (!args.length) {
      throw new Error("Usage: :attach <path...>");
    }

    const snapshot = this.requireSnapshot();
    if (!snapshot.activeThreadId) {
      throw new Error("No active thread is available.");
    }

    const filePaths = args.map((value) => resolveWorkspacePath(value, this.cwd));
    const nextSnapshot = await this.service.importAttachments({
      workspacePath: this.requireWorkspacePath(),
      threadId: snapshot.activeThreadId,
      filePaths
    });
    this.refreshSnapshot(nextSnapshot);
    this.writeLine(`[attach] Imported ${filePaths.length} file${filePaths.length === 1 ? "" : "s"}.`);
  }

  private async handleSignInCommand() {
    this.writeLine("[signin] Opening Chrome for strategist sign-in...");
    await this.service.beginStrategistSignIn();
    await this.settingsStore.update({
      strategistSessionReady: true
    });
    this.writeLine("[signin] Strategist session is ready.");
  }

  private async handleStatusCommand() {
    const status = await this.readStatus();
    const lines = [
      `Workspace: ${status.workspacePath}`,
      `Active Thread: ${status.activeThread?.title || "none"}${status.activeThread ? ` (${status.activeThread.id})` : ""}`,
      `Threads: ${status.threadCount}`,
      `Active Attachments: ${status.attachmentCount}`,
      `Latest Decision: ${status.latestDecisionSummary}`,
      `Latest Run: ${status.latestRunStatus} — ${status.latestRunSummary}`,
      `Automation: ${status.automationStatus} — ${status.automationSummary}`,
      status.progress?.active
        ? `Progress: ${status.progress.lane} — ${status.progress.progressSummary || "working"}`
        : "Progress: idle"
    ];

    for (const line of lines) {
      this.writeLine(line);
    }
  }

  private async runChatTurn(prompt: string) {
    const workspacePath = this.requireWorkspacePath();
    const snapshot = this.requireSnapshot();
    const settings = await this.settingsStore.read();
    const nextSnapshot = await this.service.sendChatMessage(
      {
        workspacePath,
        threadId: snapshot.activeThreadId || undefined,
        prompt
      },
      {
        strategistSessionReady: settings.strategistSessionReady
      }
    );

    if (!settings.strategistSessionReady && nextSnapshot.latestDecision) {
      await this.settingsStore.update({
        strategistSessionReady: true
      });
    }

    this.refreshSnapshot(nextSnapshot);
  }

  private async activateWorkspace(workspacePath: string, reason: "startup" | "switch") {
    this.service.setSelectedWorkspacePath(workspacePath);
    await this.settingsStore.update({
      lastWorkspacePath: workspacePath
    });
    const snapshot = await this.service.initProject(workspacePath);
    this.refreshSnapshot(snapshot, {
      clearPrintedHistory: true,
      emitEntries: false
    });
    this.writeLine(`[workspace] ${workspacePath}`);
    this.writeLine(`[thread] ${snapshot.activeThread?.title || "Main thread"}`);
    if (reason === "switch") {
      this.writeLine("Switched workspace.");
    }
    this.printRecentConversation(snapshot);
  }

  private printHelp() {
    const lines = [
      "Commands:",
      ":help",
      ":workspace <path>",
      ":threads",
      ":thread new [title]",
      ":thread use <id|index>",
      ":attach <path...>",
      ":signin",
      ":status",
      ":exit",
      "Chat directly with natural language, or use /research, /build, /mixed, /plan."
    ];

    for (const line of lines) {
      this.writeLine(line);
    }
  }

  private printThreads() {
    const snapshot = this.requireSnapshot();

    if (!snapshot.threads.length) {
      this.writeLine("No threads yet.");
      return;
    }

    snapshot.threads.forEach((thread, index) => {
      const activeMark = thread.id === snapshot.activeThreadId ? "*" : " ";
      const summary = thread.summary?.trim() ? ` — ${thread.summary.trim()}` : "";
      this.writeLine(`${activeMark} ${index + 1}. ${thread.title} (${thread.id})${summary}`);
    });
  }

  private printRecentConversation(snapshot: ProjectSnapshot) {
    const recentEntries = (snapshot.conversationEntries ?? []).slice(-this.historyLimit);

    if (!recentEntries.length) {
      return;
    }

    this.writeLine("Recent conversation:");
    for (const entry of recentEntries) {
      this.printConversationEntry(entry, snapshot);
      this.markConversationEntryPrinted(entry.id);
    }
  }

  private refreshSnapshot(
    snapshot: ProjectSnapshot,
    options: {
      clearPrintedHistory?: boolean;
      emitEntries?: boolean;
    } = {}
  ) {
    this.currentSnapshot = snapshot;

    if (snapshot.project?.workspacePath) {
      this.currentWorkspacePath = snapshot.project.workspacePath;
    }

    if (options.clearPrintedHistory) {
      this.clearPrintedConversationEntries();
      this.lastProgressSignature = "";
    }

    if (options.emitEntries === false) {
      return;
    }

    for (const entry of snapshot.conversationEntries ?? []) {
      if (this.wasConversationEntryPrinted(entry.id)) {
        continue;
      }

      this.printConversationEntry(entry, snapshot);
      this.markConversationEntryPrinted(entry.id);
    }
  }

  private printConversationEntry(entry: ConversationEntryRecord, snapshot: ProjectSnapshot) {
    const label =
      entry.role === "assistant" ? "Assistant" : entry.role === "system" ? "System" : "User";
    const lines = entry.body.trim() ? entry.body.trimEnd().split("\n") : [""];
    const attachments = resolveConversationAttachmentLabels(entry, snapshot);

    lines.forEach((line, index) => {
      this.writeLine(index === 0 ? `${label}: ${line}` : `  ${line}`);
    });

    if (attachments.length) {
      this.writeLine(`  Attachments: ${attachments.join(", ")}`);
    }
  }

  private emitProgress(progress: ChatProgressInspection | null) {
    if (!progress?.active) {
      this.lastProgressSignature = "";
      return;
    }

    const signature = JSON.stringify({
      lane: progress.lane,
      progressSummary: progress.progressSummary.trim(),
      progressDetails: progress.progressDetails.map((detail) => detail.trim()),
      activeCommand: progress.activeCommand?.trim() || ""
    });

    if (signature === this.lastProgressSignature) {
      return;
    }

    this.lastProgressSignature = signature;
    this.writeLine(
      `[progress:${progress.lane}] ${progress.progressSummary.trim() || progress.activeCommand?.trim() || "Working..."}`
    );

    for (const detail of progress.progressDetails) {
      const normalized = detail.trim();
      if (!normalized || normalized === progress.progressSummary.trim()) {
        continue;
      }
      this.writeLine(`  - ${normalized}`);
    }
  }

  private requireWorkspacePath() {
    if (!this.currentWorkspacePath) {
      throw new Error("No workspace is selected.");
    }

    return this.currentWorkspacePath;
  }

  private requireSnapshot() {
    if (!this.currentSnapshot) {
      throw new Error("Workspace is not initialized yet.");
    }

    return this.currentSnapshot;
  }

  private markConversationEntryPrinted(entryId: string) {
    this.printedConversationEntries.add(this.conversationEntryKey(entryId));
  }

  private wasConversationEntryPrinted(entryId: string) {
    return this.printedConversationEntries.has(this.conversationEntryKey(entryId));
  }

  private clearPrintedConversationEntries() {
    this.printedConversationEntries.clear();
  }

  private conversationEntryKey(entryId: string) {
    return `${this.currentWorkspacePath}::${entryId}`;
  }
}

export async function startCliRepl(options: StartCliReplOptions) {
  const rl = createInterface({
    input: options.input,
    output: options.output,
    terminal: options.output.isTTY ?? true
  });
  const terminal = new CliTerminal(rl, options.output);
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const queue: string[] = [];
  let draining = false;
  let pollInFlight = false;
  let closed = false;
  let resolveFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const cleanup = () => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(pollTimer);
    rl.close();
  };

  const drainQueue = async () => {
    if (draining || closed) {
      return;
    }

    draining = true;

    try {
      while (queue.length && !closed) {
        const nextLine = queue.shift() ?? "";

        try {
          const result = await options.controller.handleLine(nextLine);
          if (result === "exit") {
            cleanup();
            return;
          }
        } catch (error) {
          terminal.writeLine(formatError(error));
        }

        if (closed) {
          return;
        }

        rl.setPrompt(options.controller.buildPrompt());
        rl.prompt();
      }
    } finally {
      draining = false;
    }
  };

  const pollTimer = setInterval(() => {
    if (pollInFlight || closed) {
      return;
    }

    pollInFlight = true;
    void options.controller
      .pollOnce()
      .catch((error) => {
        terminal.writeLine(formatError(error));
      })
      .finally(() => {
        pollInFlight = false;
      });
  }, pollIntervalMs);

  rl.on("line", (line) => {
    queue.push(line);
    void drainQueue();
  });

  rl.on("SIGINT", () => {
    terminal.writeLine("Use :exit to leave Lithium CLI.");
    rl.prompt();
  });

  rl.on("close", () => {
    if (!closed) {
      closed = true;
      clearInterval(pollTimer);
    }
    resolveFinished();
  });

  rl.setPrompt(options.controller.buildPrompt());
  rl.prompt();
  await finished;
}

export function resolveInitialWorkspacePath(
  argv: string[],
  lastWorkspacePath: string,
  cwd: string
) {
  const candidate = argv.find((value) => value.trim() && !value.startsWith("-"))?.trim() || "";

  if (candidate) {
    return path.resolve(cwd, candidate);
  }

  if (lastWorkspacePath.trim()) {
    return path.resolve(cwd, lastWorkspacePath.trim());
  }

  return path.resolve(cwd);
}

export function splitShellLikeArguments(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function resolveThreadSelection(target: string, threads: ThreadRecord[]) {
  const normalizedTarget = target.trim();
  const numericIndex = Number.parseInt(normalizedTarget, 10);

  if (Number.isFinite(numericIndex) && `${numericIndex}` === normalizedTarget) {
    const selectedThread = threads[numericIndex - 1];

    if (!selectedThread) {
      throw new Error(`Thread index out of range: ${normalizedTarget}`);
    }

    return selectedThread.id;
  }

  const thread = threads.find((candidate) => candidate.id === normalizedTarget);

  if (!thread) {
    throw new Error(`Thread not found: ${normalizedTarget}`);
  }

  return thread.id;
}

function resolveConversationAttachmentLabels(entry: ConversationEntryRecord, snapshot: ProjectSnapshot) {
  const attachmentIds = new Set(entry.attachmentIds ?? []);
  return snapshot.attachments
    .filter((attachment) => attachmentIds.has(attachment.id))
    .map((attachment) => attachment.relativePath);
}

function summarizeRun(value: string) {
  const normalized = value
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized ? normalized.slice(0, 160) : "none";
}

function resolveWorkspacePath(value: string, cwd: () => string) {
  return path.resolve(cwd(), value.trim());
}

function formatError(error: unknown) {
  return `[error] ${error instanceof Error ? error.message : String(error)}`;
}

class CliTerminal {
  constructor(
    private readonly rl: Interface,
    private readonly output: Writable & { isTTY?: boolean }
  ) {}

  writeLine(line = "") {
    if (this.output.isTTY) {
      readline.clearLine(this.output, 0);
      readline.cursorTo(this.output, 0);
      this.output.write(`${line}\n`);
      const refreshable = this.rl as Interface & { _refreshLine?: () => void };
      refreshable._refreshLine?.();
      return;
    }

    this.output.write(`${line}\n`);
  }
}
