import path from "node:path";
import type { AppSettingsStore } from "../main/services/app-settings-store";
import type { AppService } from "../main/services/app-service";
import type {
  AppSettings,
  ChatProgressInspection,
  ConversationEntryRecord,
  ProjectSnapshot,
  ThreadRecord
} from "../shared/types";
import {
  resolveConversationAttachmentLabels,
  resolveThreadSelection,
  resolveWorkspacePath,
  splitShellLikeArguments,
  summarizeRun
} from "./command-parser";

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

export type CliControllerOptions = {
  service: CliService;
  settingsStore: CliSettingsStore;
  writeLine: (line?: string) => void;
  cwd?: () => string;
  historyLimit?: number;
  maxTrackedConversationEntries?: number;
};

export type HandleLineResult = "continue" | "exit";

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
  private readonly maxTrackedConversationEntries: number;
  private currentWorkspacePath = "";
  private currentSnapshot: ProjectSnapshot | null = null;
  private readonly printedConversationEntries = new Set<string>();
  private readonly printedConversationEntryOrder: string[] = [];
  private lastProgressSignature = "";

  constructor(options: CliControllerOptions) {
    this.service = options.service;
    this.settingsStore = options.settingsStore;
    this.writeLine = options.writeLine;
    this.cwd = options.cwd ?? (() => process.cwd());
    this.historyLimit = options.historyLimit ?? 8;
    this.maxTrackedConversationEntries = options.maxTrackedConversationEntries ?? Math.max(128, this.historyLimit * 16);
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
    const snapshot = await this.service.initProject(workspacePath);
    const persistedWorkspacePath = snapshot.project?.workspacePath || workspacePath;
    this.service.setSelectedWorkspacePath(persistedWorkspacePath);
    await this.settingsStore.update({
      lastWorkspacePath: persistedWorkspacePath
    });
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
    const key = this.conversationEntryKey(entryId);

    if (this.printedConversationEntries.has(key)) {
      return;
    }

    this.printedConversationEntries.add(key);
    this.printedConversationEntryOrder.push(key);

    while (this.printedConversationEntryOrder.length > this.maxTrackedConversationEntries) {
      const oldestKey = this.printedConversationEntryOrder.shift();

      if (!oldestKey) {
        break;
      }

      this.printedConversationEntries.delete(oldestKey);
    }
  }

  private wasConversationEntryPrinted(entryId: string) {
    return this.printedConversationEntries.has(this.conversationEntryKey(entryId));
  }

  private clearPrintedConversationEntries() {
    this.printedConversationEntries.clear();
    this.printedConversationEntryOrder.length = 0;
  }

  private conversationEntryKey(entryId: string) {
    return `${this.currentWorkspacePath}::${entryId}`;
  }
}
