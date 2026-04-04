import path from "node:path";
import type { AppSettingsStore } from "../main/services/app-settings-store";
import type { ResearchService } from "../main/services/research-service";
import type {
  ActiveWorkerProgressRecord,
  AppSettings,
  ResearchRunRecord,
  WorkspaceSnapshot
} from "../shared/types";
import { resolveWorkspacePath, splitShellLikeArguments } from "./command-parser";

type CliService = Pick<
  ResearchService,
  | "setSelectedWorkspacePath"
  | "initWorkspace"
  | "getWorkspaceSnapshot"
  | "createObjective"
  | "selectObjective"
  | "listObjectives"
  | "startRun"
  | "pauseRun"
  | "resumeRun"
  | "stopRun"
  | "importAttachments"
  | "prepareOracleSignIn"
  | "getQueueView"
  | "getEvidenceView"
>;

type CliSettingsStore = Pick<AppSettingsStore, "read" | "update">;

export type CliControllerOptions = {
  service: CliService;
  settingsStore: CliSettingsStore;
  writeLine: (line?: string) => void;
  cwd?: () => string;
};

export type HandleLineResult = "continue" | "exit";

export type CliStatusSnapshot = {
  workspacePath: string;
  objectiveTitle: string;
  runStatus: string;
  projectionStatus: string;
  projectionSummary: string;
  queueDepth: number;
  activeWorkers: ActiveWorkerProgressRecord[];
};

export class LithiumCliController {
  private readonly service: CliService;
  private readonly settingsStore: CliSettingsStore;
  private readonly writeLine: (line?: string) => void;
  private readonly cwd: () => string;
  private currentWorkspacePath = "";
  private currentSnapshot: WorkspaceSnapshot | null = null;
  private lastProgressSignature = "";

  constructor(options: CliControllerOptions) {
    this.service = options.service;
    this.settingsStore = options.settingsStore;
    this.writeLine = options.writeLine;
    this.cwd = options.cwd ?? (() => process.cwd());
  }

  async initialize(workspacePath: string) {
    const resolvedWorkspacePath = resolveWorkspacePath(workspacePath, this.cwd);
    this.writeLine("Lithium CLI");
    this.writeLine("Objective-first research controller. Type :help for commands.");
    await this.activateWorkspace(resolvedWorkspacePath);
  }

  buildPrompt() {
    const workspaceLabel = this.currentSnapshot?.project?.name?.trim() || path.basename(this.currentWorkspacePath) || "lithium";
    const objectiveLabel = this.currentSnapshot?.activeObjective?.title?.trim() || "no-objective";
    return `${workspaceLabel}:${objectiveLabel}> `;
  }

  async handleLine(rawLine: string): Promise<HandleLineResult> {
    const line = rawLine.trim();

    if (!line) {
      return "continue";
    }

    if (!line.startsWith(":")) {
      this.writeLine("Free-form chat is disabled in research mode. Use :objective, :run, :queue, :evidence, or :status.");
      return "continue";
    }

    return await this.handleCommand(line);
  }

  async pollOnce() {
    if (!this.currentWorkspacePath) {
      return;
    }

    const snapshot = await this.service.getWorkspaceSnapshot(this.currentWorkspacePath);
    this.refreshSnapshot(snapshot);
    this.emitProgress(snapshot.activeWorkerProgress);
  }

  async readStatus(): Promise<CliStatusSnapshot> {
    const snapshot = await this.service.getWorkspaceSnapshot(this.requireWorkspacePath());
    this.currentSnapshot = snapshot;

    return {
      workspacePath: this.currentWorkspacePath,
      objectiveTitle: snapshot.activeObjective?.title || "none",
      runStatus: snapshot.activeRun?.status || "none",
      projectionStatus: snapshot.latestProjection?.status || "none",
      projectionSummary: snapshot.latestProjection?.summary || "none",
      queueDepth: snapshot.queue.length,
      activeWorkers: snapshot.activeWorkerProgress
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
      case "objective":
        await this.handleObjectiveCommand(tokens.slice(1));
        return "continue";
      case "run":
        await this.handleRunCommand(tokens.slice(1));
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
      case "queue":
        await this.handleQueueCommand();
        return "continue";
      case "evidence":
        await this.handleEvidenceCommand();
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
    await this.activateWorkspace(nextWorkspacePath);
  }

  private async handleObjectiveCommand(args: string[]) {
    const subcommand = args[0]?.toLowerCase();

    if (!subcommand) {
      throw new Error("Usage: :objective list | :objective new <goal> | :objective use <id>");
    }

    if (subcommand === "list") {
      const objectives = await this.service.listObjectives(this.requireWorkspacePath());
      if (objectives.length === 0) {
        this.writeLine("[objective] none");
        return;
      }

      objectives.forEach((entry, index) => {
        this.writeLine(`${index + 1}. ${entry.id} [${entry.status}] ${entry.title}`);
      });
      return;
    }

    if (subcommand === "new") {
      const goal = args.slice(1).join(" ").trim();
      if (!goal) {
        throw new Error("Usage: :objective new <goal>");
      }

      const snapshot = await this.service.createObjective({
        workspacePath: this.requireWorkspacePath(),
        objective: goal
      });
      this.refreshSnapshot(snapshot);
      this.writeLine(`[objective] Created ${snapshot.activeObjective?.id}: ${snapshot.activeObjective?.title}`);
      return;
    }

    if (subcommand === "use") {
      const objectiveId = args.slice(1).join(" ").trim();
      if (!objectiveId) {
        throw new Error("Usage: :objective use <id>");
      }

      const snapshot = await this.service.selectObjective({
        workspacePath: this.requireWorkspacePath(),
        objectiveId
      });
      this.refreshSnapshot(snapshot);
      this.writeLine(`[objective] Using ${snapshot.activeObjective?.id}: ${snapshot.activeObjective?.title}`);
      return;
    }

    throw new Error("Usage: :objective list | :objective new <goal> | :objective use <id>");
  }

  private async handleRunCommand(args: string[]) {
    const subcommand = args[0]?.toLowerCase();

    if (!subcommand) {
      throw new Error("Usage: :run start | :run pause | :run resume | :run stop");
    }

    const workspacePath = this.requireWorkspacePath();
    let snapshot: WorkspaceSnapshot;

    switch (subcommand) {
      case "start":
        snapshot = await this.service.startRun({ workspacePath });
        break;
      case "pause":
        snapshot = await this.service.pauseRun({ workspacePath });
        break;
      case "resume":
        snapshot = await this.service.resumeRun({ workspacePath });
        break;
      case "stop":
        snapshot = await this.service.stopRun({ workspacePath });
        break;
      default:
        throw new Error("Usage: :run start | :run pause | :run resume | :run stop");
    }

    this.refreshSnapshot(snapshot);
    this.writeLine(`[run] ${snapshot.activeRun?.status || "none"}`);
  }

  private async handleAttachCommand(args: string[]) {
    if (!args.length) {
      throw new Error("Usage: :attach <path...>");
    }

    const filePaths = args.map((value) => resolveWorkspacePath(value, this.cwd));
    const snapshot = await this.service.importAttachments({
      workspacePath: this.requireWorkspacePath(),
      objectiveId: this.requireSnapshot().activeObjectiveId ?? undefined,
      filePaths
    });
    this.refreshSnapshot(snapshot);
    this.writeLine(`[attach] Imported ${filePaths.length} file(s).`);
  }

  private async handleSignInCommand() {
    await this.service.prepareOracleSignIn();
    await this.settingsStore.update({
      oracleSessionReady: true
    } satisfies Partial<AppSettings>);
    this.writeLine("[signin] Oracle/ChatGPT session is ready.");
  }

  private async handleStatusCommand() {
    const status = await this.readStatus();
    this.writeLine(`[workspace] ${status.workspacePath}`);
    this.writeLine(`[objective] ${status.objectiveTitle}`);
    this.writeLine(`[run] ${status.runStatus}`);
    this.writeLine(`[projection] ${status.projectionStatus}: ${status.projectionSummary}`);
    this.writeLine(`[queue] ${status.queueDepth}`);
    if (status.activeWorkers.length > 0) {
      this.writeLine(`[workers] ${status.activeWorkers.map((entry) => `${entry.executor}:${entry.title}`).join(" | ")}`);
    }
  }

  private async handleQueueCommand() {
    const queue = await this.service.getQueueView(this.requireWorkspacePath());

    if (queue.length === 0) {
      this.writeLine("[queue] empty");
      return;
    }

    queue.forEach((entry, index) => {
      this.writeLine(`${index + 1}. [${entry.status}] ${entry.executor ?? entry.kind} :: ${entry.title}`);
    });
  }

  private async handleEvidenceCommand() {
    const evidence = await this.service.getEvidenceView(this.requireWorkspacePath());
    this.writeLine(`[evaluation] ${evidence.evaluation?.summary || "none"}`);

    if (evidence.findings.length === 0) {
      this.writeLine("[findings] none");
      return;
    }

    evidence.findings.slice(0, 5).forEach((entry, index) => {
      this.writeLine(`${index + 1}. ${entry.summary}`);
    });
  }

  private async activateWorkspace(workspacePath: string) {
    this.currentWorkspacePath = workspacePath;
    this.service.setSelectedWorkspacePath(workspacePath);
    const snapshot = await this.service.initWorkspace(workspacePath);
    this.refreshSnapshot(snapshot);
    await this.settingsStore.update({
      lastWorkspacePath: workspacePath
    } satisfies Partial<AppSettings>);
    this.writeLine(`[workspace] ${workspacePath}`);
  }

  private emitProgress(progressEntries: ActiveWorkerProgressRecord[]) {
    const signature = progressEntries
      .map((entry) => `${entry.runId}:${entry.workItemId}:${entry.status}:${entry.summary}`)
      .join("|");

    if (!signature || signature === this.lastProgressSignature) {
      return;
    }

    this.lastProgressSignature = signature;
    this.writeLine(`[progress] ${progressEntries.map((entry) => `${entry.executor}:${entry.title}`).join(" | ")}`);
  }

  private refreshSnapshot(snapshot: WorkspaceSnapshot) {
    this.currentSnapshot = snapshot;
  }

  private printHelp() {
    this.writeLine("Commands:");
    this.writeLine(":workspace [path]");
    this.writeLine(":objective list");
    this.writeLine(":objective new <goal>");
    this.writeLine(":objective use <id>");
    this.writeLine(":run start");
    this.writeLine(":run pause");
    this.writeLine(":run resume");
    this.writeLine(":run stop");
    this.writeLine(":status");
    this.writeLine(":queue");
    this.writeLine(":evidence");
    this.writeLine(":attach <path...>");
    this.writeLine(":signin");
    this.writeLine(":exit");
  }

  private requireWorkspacePath() {
    if (!this.currentWorkspacePath) {
      throw new Error("No workspace is selected.");
    }

    return this.currentWorkspacePath;
  }

  private requireSnapshot() {
    if (!this.currentSnapshot) {
      throw new Error("No workspace snapshot is available.");
    }

    return this.currentSnapshot;
  }
}
