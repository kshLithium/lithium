import path, { basename } from "node:path";
import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import {
  coerceStrategistThinkingTime,
  isBuilderModel,
  isBuilderReasoningEffort
} from "../../shared/model-config";
import type {
  AppSettings,
  AttachmentDeleteRequest,
  AttachmentImportRequest,
  AutomationCheckpointApprovalRequest,
  AutomationCheckpointRecord,
  AutomationInterruptRequest,
  AutomationSessionControlRequest,
  AutomationSessionCreateRequest,
  AutomationSessionRecord,
  AutomationStatus,
  AutomationStepKind,
  AutomationStepRecord,
  ChatRequest,
  ChatProgressInspection,
  ChatProgressRequest,
  ChatRoute,
  BuilderModel,
  BuilderRunControlRequest,
  BuilderRequest,
  BuilderRunInspection,
  BuilderReasoningEffort,
  ContextPackLane,
  DecisionRecord,
  LithiumHandoff,
  PaperSourceTarget,
  PaperSourceTargetRequest,
  PaperSyncTarget,
  PaperSyncTargetRequest,
  ProjectMemoryRecord,
  ProjectMemoryUpdate,
  ProjectSnapshot,
  RecordStatus,
  RemoteWorkspaceProfile,
  RouterTraceRecord,
  RuntimeAppState,
  StrategistBrowserProbeRequest,
  StrategistBrowserProbeResponse,
  StrategistRequest,
  ThreadDeleteRequest,
  ThreadCreateRequest,
  ThreadMemoryUpdateRequest,
  ThreadRecord,
  ThreadRenameRequest,
  ThreadSelectionRequest,
  TerminalSessionCreateRequest,
  TerminalEvent,
  TerminalSessionInputRequest,
  TerminalSessionResizeRequest,
  TerminalSessionRequest,
  TerminalSessionState,
  TaskRecord,
  TerminalSessionRecord,
  RunRecord,
  WorkspaceFileContent,
  WorkspaceDiffRequest,
  WorkspaceFileRecord,
  WorkspaceFileDiff,
  WorkspaceFileRequest,
  WorkspaceSelectionResult
} from "../../shared/types";
import { DEFAULT_APP_SETTINGS } from "../../shared/types";
import {
  handoffMachineSummary,
  handoffUserMessage,
  isOperationalAutomationMessage
} from "../../shared/handoff-utils";
import { ProjectStore } from "./project-store";
import { OracleRunner, normalizeOracleSessionId, resolveOracleLaunchOptions } from "./oracle-runner";
import { CodexRunner } from "./codex-runner";
import { parseCodexProgressLog } from "./codex-progress";
import { RouterRunner } from "./router-runner";
import { ManuscriptEngine } from "./manuscript-engine";
import { ChatgptAuthRunner } from "./chatgpt-auth-runner";
import {
  describeIncompleteStrategistOutput,
  parseBuilderOutput,
  parseOracleOutput
} from "./protocol";
import { runCommand } from "./process-runner";
import {
  collectGitChangedFiles,
  inferFinalRunStatus,
  inferRunStatus,
  mergeChangedFiles,
  parseChangedFilesFromFinalMessage,
  readWorkspaceFileDiff,
  readTailText,
  readTextFile
} from "./run-artifacts";
import { getLiveProcess, inspectLiveProcessFiles, startLiveProcess, stopLiveProcess } from "./live-process-registry";
import {
  getLiveTerminal,
  onLiveTerminalEvent,
  resizeLiveTerminal,
  startLiveTerminal,
  stopLiveTerminal,
  writeToLiveTerminal
} from "./terminal-pty-registry";
import { resolveSyncTeXSourceLocation, resolveSyncTeXTarget } from "./synctex";
import { resolveWorkspaceCommandContext } from "./workspace-execution";
import {
  RemoteWorkspaceService,
  type RemoteWorkspaceServiceLike
} from "./remote-workspace-service";
import { startStrategistBrowserProbeMonitor } from "./strategist-browser-probe";
import { resolveWorkspaceMemberPath } from "./workspace-paths";
import {
  buildStrategistContextFingerprint,
  buildStrategistOracleSessionId,
  isSupportedStrategistUploadPath,
  resolveExplicitStrategistWorkspaceFiles,
  shouldAttachStrategistRuntimeContext
} from "./strategist-context";
import {
  extractOracleSessionProgress,
  mergeStrategistLiveProgress,
  readLiveOracleSessionProgress
} from "./strategist-progress";
import { isProcessAlive, readProcessCommand, terminateProcessTree } from "./process-tree";

type AppServiceDependencies = {
  store?: ProjectStore;
  routerRunner?: Pick<RouterRunner, "route">;
  oracleRunner?: Pick<OracleRunner, "consult"> & Partial<Pick<OracleRunner, "terminateSession">>;
  chatgptAuthRunner?: Pick<ChatgptAuthRunner, "signIn" | "prepareReusableSession">;
  codexRunner?: Pick<CodexRunner, "runTask"> & Partial<Pick<CodexRunner, "buildTaskCommand">>;
  manuscriptEngine?: Pick<ManuscriptEngine, "updateResults">;
  untitledWorkspaceRoot?: string;
  remoteWorkspaceRoot?: string;
  remoteWorkspaceService?: RemoteWorkspaceServiceLike;
  onSelectedWorkspacePathChange?: (workspacePath: string) => void;
  getAppSettings?: () => Promise<AppSettings>;
};

type ActiveChatProgress = {
  lane: "router" | "strategist" | "builder";
  progressSummary: string;
  progressDetails: string[];
  activeCommand: string | null;
  oracleSessionSlug?: string;
  stdoutPath?: string;
  stderrPath?: string;
  updatedAt: string;
};

type AutomationControllerState = {
  running: boolean;
  pauseRequested: boolean;
  stopRequested: boolean;
  redirectInstruction: string;
  activeRunId: string | null;
  activeStrategistSlug: string | null;
};

export class AppService {
  private static terminalEventUnsubscribe: (() => void) | null = null;
  private selectedWorkspacePath: string;
  private readonly terminatingRunIds = new Set<string>();
  private readonly activeChatProgressByWorkspace = new Map<string, ActiveChatProgress>();
  private readonly automationControllers = new Map<string, AutomationControllerState>();
  private readonly store: ProjectStore;
  private readonly routerRunner: Pick<RouterRunner, "route">;
  private readonly oracleRunner: Pick<OracleRunner, "consult"> & Partial<Pick<OracleRunner, "terminateSession">>;
  private readonly chatgptAuthRunner: Pick<ChatgptAuthRunner, "signIn" | "prepareReusableSession">;
  private readonly codexRunner: Pick<CodexRunner, "runTask"> & Partial<Pick<CodexRunner, "buildTaskCommand">>;
  private readonly manuscriptEngine: Pick<ManuscriptEngine, "updateResults">;
  private readonly untitledWorkspaceRoot: string;
  private readonly remoteWorkspaceService: RemoteWorkspaceServiceLike;
  private readonly onSelectedWorkspacePathChange?: (workspacePath: string) => void;
  private readonly getAppSettings: () => Promise<AppSettings>;

  constructor(workspacePath: string, dependencies: AppServiceDependencies = {}) {
    this.selectedWorkspacePath = workspacePath.trim();
    this.store = dependencies.store ?? new ProjectStore();
    this.routerRunner = dependencies.routerRunner ?? new RouterRunner();
    this.oracleRunner = dependencies.oracleRunner ?? new OracleRunner();
    this.chatgptAuthRunner = dependencies.chatgptAuthRunner ?? new ChatgptAuthRunner();
    this.codexRunner = dependencies.codexRunner ?? new CodexRunner();
    this.manuscriptEngine = dependencies.manuscriptEngine ?? new ManuscriptEngine();
    this.untitledWorkspaceRoot =
      dependencies.untitledWorkspaceRoot ?? path.join(os.homedir(), "Documents", "Lithium");
    this.remoteWorkspaceService =
      dependencies.remoteWorkspaceService ??
      new RemoteWorkspaceService(
        dependencies.remoteWorkspaceRoot ??
          path.join(os.homedir(), ".lithium", "remote-workspaces")
      );
    this.onSelectedWorkspacePathChange = dependencies.onSelectedWorkspacePathChange;
    this.getAppSettings = dependencies.getAppSettings ?? (async () => DEFAULT_APP_SETTINGS);
    AppService.terminalEventUnsubscribe?.();
    AppService.terminalEventUnsubscribe = onLiveTerminalEvent((event) => {
      void this.handleLiveTerminalEvent(event);
    });
  }

  setSelectedWorkspacePath(workspacePath: string): WorkspaceSelectionResult {
    const nextWorkspacePath = workspacePath.trim();
    this.updateSelectedWorkspacePath(nextWorkspacePath);
    return { selectedWorkspacePath: nextWorkspacePath };
  }

  async getAppState(input: {
    platform: string;
    electronVersion: string;
    chromeVersion: string;
    nodeVersion: string;
    cwd: string;
    oracleReady: boolean;
    codexReady: boolean;
    oracleChromePath: string | null;
    discordBotStatus: RuntimeAppState["discordBotStatus"];
    settings: AppSettings;
  }): Promise<RuntimeAppState> {
    const selectedWorkspacePath = this.selectedWorkspacePath;
    const remoteWorkspace = selectedWorkspacePath
      ? await this.remoteWorkspaceService.describe(selectedWorkspacePath).catch(() => null)
      : null;

    return {
      ...input,
      selectedWorkspacePath,
      selectedWorkspaceLabel:
        remoteWorkspace?.label ?? (selectedWorkspacePath ? basename(selectedWorkspacePath) : ""),
      selectedWorkspaceKind: remoteWorkspace?.kind ?? "local",
      selectedWorkspaceRemoteHost: remoteWorkspace?.remoteHost ?? null,
      selectedWorkspaceRemotePath: remoteWorkspace?.remotePath ?? null
    };
  }

  async connectRemoteWorkspace(profile: RemoteWorkspaceProfile): Promise<WorkspaceSelectionResult> {
    const connected = await this.remoteWorkspaceService.connect(profile);
    this.updateSelectedWorkspacePath(connected.workspacePath);
    return { selectedWorkspacePath: connected.workspacePath };
  }

  async syncRemoteWorkspace(workspacePath?: string): Promise<WorkspaceSelectionResult> {
    const resolvedWorkspacePath = this.requireWorkspacePath(workspacePath);
    const remoteWorkspace = await this.remoteWorkspaceService.describe(resolvedWorkspacePath);

    if (remoteWorkspace) {
      await this.remoteWorkspaceService.syncWorkspace(resolvedWorkspacePath);
    }

    this.updateSelectedWorkspacePath(resolvedWorkspacePath);
    return { selectedWorkspacePath: resolvedWorkspacePath };
  }

  async initProject(workspacePath?: string) {
    const resolvedWorkspacePath = await this.resolveResearchWorkspacePath(workspacePath);
    await this.store.initProject(resolvedWorkspacePath, {
      name: await this.resolveProjectName(resolvedWorkspacePath)
    });
    await this.store.buildContextBundle(
      resolvedWorkspacePath,
      "Initialize the Lithium context bundle for this workspace."
    );
    return await this.store.getSnapshot(resolvedWorkspacePath);
  }

  async getSnapshot(workspacePath?: string) {
    const resolvedWorkspacePath = this.resolveWorkspacePath(workspacePath);

    if (!resolvedWorkspacePath) {
      return createEmptyProjectSnapshot();
    }

    await this.reconcileStaleBuilderRuns(resolvedWorkspacePath);
    await this.reconcileStaleAutomationSession(resolvedWorkspacePath);
    return await this.store.getSnapshot(resolvedWorkspacePath);
  }

  async createThread(request: ThreadCreateRequest = {}): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.store.createThread(workspacePath, request.title);
    await this.store.updateSessionSummary(workspacePath);
    await this.store.buildContextBundle(
      workspacePath,
      "Refresh the Lithium context bundle after creating a new thread."
    );
    return await this.store.getSnapshot(workspacePath);
  }

  async selectThread(request: ThreadSelectionRequest): Promise<ProjectSnapshot> {
    const workspacePath = this.requireWorkspacePath(request.workspacePath);
    await this.store.selectThread(workspacePath, request.threadId);
    await this.store.updateSessionSummary(workspacePath);
    await this.store.buildContextBundle(
      workspacePath,
      "Refresh the Lithium context bundle after switching threads."
    );
    return await this.store.getSnapshot(workspacePath);
  }

  async renameThread(request: ThreadRenameRequest): Promise<ProjectSnapshot> {
    const workspacePath = this.requireWorkspacePath(request.workspacePath);
    await this.store.renameThread(workspacePath, request.threadId, request.title);
    await this.store.updateSessionSummary(workspacePath);
    await this.store.buildContextBundle(
      workspacePath,
      "Refresh the Lithium context bundle after renaming a thread."
    );
    return await this.store.getSnapshot(workspacePath);
  }

  async updateThreadMemory(request: ThreadMemoryUpdateRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.store.initProject(workspacePath, {
      name: await this.resolveProjectName(workspacePath)
    });
    const snapshot = await this.store.getSnapshot(workspacePath);
    const threadId = request.threadId ?? snapshot.activeThreadId ?? snapshot.threads[0]?.id ?? null;

    if (!threadId) {
      throw new Error("No active thread is available.");
    }

    const updatedThread = await this.store.updateThread(workspacePath, threadId, {
      memory: request.memory.trim()
    });

    if (!updatedThread) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    await this.store.appendActivity(workspacePath, `${threadId} memory updated`);
    await this.store.updateSessionSummary(workspacePath);
    await this.store.buildContextBundle(
      workspacePath,
      "Refresh the Lithium context bundle after updating thread memory."
    );
    return await this.store.getSnapshot(workspacePath);
  }

  async deleteThread(request: ThreadDeleteRequest): Promise<ProjectSnapshot> {
    const workspacePath = this.requireWorkspacePath(request.workspacePath);
    await this.stopLiveProcessesForThread(workspacePath, request.threadId);
    await this.store.deleteThread(workspacePath, request.threadId);
    return await this.store.getSnapshot(workspacePath);
  }

  async getProjectMemory(workspacePath?: string): Promise<ProjectMemoryRecord | null> {
    const resolvedWorkspacePath = this.resolveWorkspacePath(workspacePath);

    if (!resolvedWorkspacePath) {
      return null;
    }

    return await this.store.readProjectMemory(resolvedWorkspacePath);
  }

  async updateProjectMemory(request: ProjectMemoryUpdate): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.store.initProject(workspacePath, {
      name: await this.resolveProjectName(workspacePath)
    });
    await this.store.writeProjectMemory(workspacePath, {
      projectBrief: request.projectBrief,
      researchGoal: request.researchGoal,
      constraints: request.constraints,
      openQuestions: request.openQuestions,
      activeHypotheses: request.activeHypotheses,
      sessionSummary: request.sessionSummary,
      preferences: request.preferences
    });
    await this.store.appendActivity(workspacePath, "project memory updated");
    await this.store.buildContextBundle(
      workspacePath,
      "Refresh the Lithium context bundle after updating project memory."
    );
    return await this.store.getSnapshot(workspacePath);
  }

  async createAutomationSession(request: AutomationSessionCreateRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.store.initProject(workspacePath, {
      name: await this.resolveProjectName(workspacePath)
    });
    if (request.threadId) {
      await this.store.selectThread(workspacePath, request.threadId);
    }

    const snapshot = await this.store.getSnapshot(workspacePath);
    const activeThread = snapshot.activeThread;

    if (!activeThread) {
      throw new Error("No active thread is available.");
    }

    const objective =
      request.objective.trim() ||
      snapshot.memory?.researchGoal?.trim() ||
      "Advance the active research workspace with the highest-value next step.";
    const displayObjective =
      request.displayObjective?.trim() ||
      request.objective.trim() ||
      objective;

    if (request.objective.trim()) {
      await this.store.appendPromptLog(workspacePath, {
        kind: "chat.user",
        lane: "automation",
        threadId: activeThread.id,
        prompt: request.objective.trim(),
        source: "automation-session-create"
      });
    }

    const allocation = await this.store.allocateAutomationSession(workspacePath);
    const now = new Date().toISOString();
    const session: AutomationSessionRecord = {
      id: allocation.id,
      threadId: activeThread.id,
      objective,
      displayObjective,
      mode: request.mode ?? "continuous",
      status: "idle",
      allowedActions: [
        "strategize",
        "literature-search",
        "code-edit",
        "experiment-run",
        "result-analysis",
        "paper-sync",
        "checkpoint"
      ],
      paperWriteEnabled: request.paperWriteEnabled ?? false,
      evidenceMode: "strict",
      budget: {
        maxSteps: Math.max(1, request.maxSteps ?? 24),
        maxRuntimeMinutes: Math.max(15, request.maxRuntimeMinutes ?? 24 * 60),
        maxRetries: Math.max(0, request.maxRetries ?? 3),
        usedSteps: 0,
        usedRetries: 0
      },
      currentStepSummary: "Automation is ready to begin.",
      lastUserInstruction: request.objective.trim() || undefined,
      queuedUserInstruction: undefined,
      createdAt: now,
      updatedAt: now
    };

    await this.store.writeAutomationSession(workspacePath, session);
    await this.store.appendPromptLog(workspacePath, {
      kind: "automation.session.created",
      threadId: activeThread.id,
      sessionId: session.id,
      objective: session.objective,
      mode: session.mode,
      paperWriteEnabled: session.paperWriteEnabled
    });
    await this.store.appendActivity(workspacePath, `${session.id} automation session created`);
    await this.store.updateSessionSummary(workspacePath);
    await this.store.buildContextBundle(
      workspacePath,
      "Refresh the Lithium context bundle after creating an automation session."
    );

    return await this.store.getSnapshot(workspacePath);
  }

  async startAutomationSession(request: AutomationSessionControlRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.reconcileStaleBuilderRuns(workspacePath);
    const session = await this.requireAutomationSession(workspacePath, request.sessionId);
    const controller = this.getAutomationController(workspacePath, session.id);
    controller.pauseRequested = false;
    controller.stopRequested = false;
    controller.redirectInstruction = "";

    await this.writeRunningAutomationSession(workspacePath, session, {
      currentStepSummary:
        session.status === "idle" ? "Automation started. Planning the next bounded step." : session.currentStepSummary,
      startedAt: session.startedAt ?? new Date().toISOString()
    });
    await this.store.appendPromptLog(workspacePath, {
      kind: "automation.session.started",
      threadId: session.threadId,
      sessionId: session.id,
      objective: session.objective
    });
    await this.store.appendActivity(workspacePath, `${session.id} automation started`);
    await this.store.updateSessionSummary(workspacePath);
    void this.runAutomationLoop(workspacePath, session.id);
    return await this.store.getSnapshot(workspacePath);
  }

  async pauseAutomationSession(request: AutomationSessionControlRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    const session = await this.requireAutomationSession(workspacePath, request.sessionId);
    const controller = this.getAutomationController(workspacePath, session.id);
    controller.pauseRequested = true;
    await this.store.writeAutomationSession(workspacePath, {
      ...session,
      currentStepSummary: "Pause requested. Finishing the current bounded step before stopping.",
      updatedAt: new Date().toISOString()
    });
    await this.store.appendActivity(workspacePath, `${session.id} automation pause requested`);
    await this.store.updateSessionSummary(workspacePath);
    return await this.store.getSnapshot(workspacePath);
  }

  async resumeAutomationSession(request: AutomationSessionControlRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.reconcileStaleBuilderRuns(workspacePath);
    const session = await this.requireAutomationSession(workspacePath, request.sessionId);
    const controller = this.getAutomationController(workspacePath, session.id);
    controller.pauseRequested = false;
    controller.stopRequested = false;
    await this.writeRunningAutomationSession(workspacePath, session, {
      currentStepSummary: "Automation resumed."
    });
    await this.store.appendActivity(workspacePath, `${session.id} automation resumed`);
    await this.store.updateSessionSummary(workspacePath);
    void this.runAutomationLoop(workspacePath, session.id);
    return await this.store.getSnapshot(workspacePath);
  }

  async interruptAutomationSession(request: AutomationInterruptRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    const session = await this.requireAutomationSession(workspacePath, request.sessionId);
    const controller = this.getAutomationController(workspacePath, session.id);
    const instruction = request.instruction.trim();
    const stoppedAt = new Date().toISOString();

    if (request.stopNow && controller.activeStrategistSlug) {
      await this.oracleRunner
        .terminateSession?.(controller.activeStrategistSlug)
        .catch(() => undefined);
      controller.activeStrategistSlug = null;
    }

    if (request.stopNow) {
      controller.stopRequested = true;
      controller.pauseRequested = false;
      const visibleStopInstruction =
        instruction && !isOperationalAutomationMessage(instruction) ? instruction : "";

      if (controller.activeRunId) {
        await this.terminateBuilderRun({
          workspacePath,
          runId: controller.activeRunId
        });
      }

      const stopCheckpoint = await this.createAutomationCheckpoint(workspacePath, session, {
        title: "Automation interrupted",
        summary: visibleStopInstruction || "Automation stopped by the user.",
        whatChanged: [],
        evidence: [],
        risks: [],
        nextActions: [],
        status: "approved",
        userResponse: visibleStopInstruction || undefined,
        approvedAt: stoppedAt,
        activityMessage: `${session.id} automation stop recorded`
      });

      await this.store.writeAutomationSession(workspacePath, {
        ...session,
        status: "idle",
        latestCheckpointId: stopCheckpoint.id,
        currentStepSummary: "Automation stopped by the user.",
        stopReason: visibleStopInstruction || instruction || "Stopped by the user.",
        updatedAt: stoppedAt,
        endedAt: stoppedAt
      });
      await this.store.appendPromptLog(workspacePath, {
        kind: "automation.interrupt",
        threadId: session.threadId,
        sessionId: session.id,
        instruction,
        stopNow: true
      });
      await this.store.appendActivity(workspacePath, `${session.id} automation stopped`);
      await this.store.updateSessionSummary(workspacePath);
      return await this.store.getSnapshot(workspacePath);
    }

    const snapshot = await this.store.getSnapshot(workspacePath);
    const activeRunInspection = controller.activeRunId
      ? await this.inspectBuilderRun({
          workspacePath,
          runId: controller.activeRunId
        })
      : null;
    const activeChatProgress = await this.inspectChatProgress({
      workspacePath
    });
    const automationIntent = classifyAutomationChatIntent(instruction);
    const shouldQueueRedirect = Boolean(instruction) && automationIntent === "redirect";
    const responseSummary = summarizeAutomationInterrupt({
      instruction,
      session,
      snapshot,
      builderInspection: activeRunInspection,
      chatProgress: activeChatProgress,
      queueRedirect: shouldQueueRedirect
    });

    if (shouldQueueRedirect) {
      controller.redirectInstruction = instruction;
    }

    await this.createAutomationCheckpoint(workspacePath, session, {
      title: "Automation update",
      summary: responseSummary,
      whatChanged: snapshot.latestRun?.changedFiles ?? [],
      evidence: buildAutomationEvidence(snapshot.latestRun),
      risks: [],
      nextActions: shouldQueueRedirect
        ? ["Finish the current bounded step, then incorporate the latest user instruction."]
        : [],
      status: "approved",
      userResponse: instruction,
      approvedAt: new Date().toISOString(),
      activityMessage: `${session.id} automation update recorded`
    });

    await this.writeRunningAutomationSession(workspacePath, session, {
      currentStepSummary: shouldQueueRedirect
        ? buildQueuedAutomationStepSummary(
            resolveAutomationUiLanguage([instruction, session.displayObjective ?? "", session.objective])
          )
        : session.currentStepSummary,
      lastUserInstruction: shouldQueueRedirect ? instruction : session.lastUserInstruction,
      queuedUserInstruction: shouldQueueRedirect ? instruction : session.queuedUserInstruction
    });
    await this.store.appendPromptLog(workspacePath, {
      kind: "automation.interrupt",
      threadId: session.threadId,
      sessionId: session.id,
      instruction,
      stopNow: false,
      continuesRunning: true,
      redirectQueued: shouldQueueRedirect,
      response: responseSummary
    });
    await this.store.appendActivity(
      workspacePath,
      shouldQueueRedirect ? `${session.id} automation redirect queued` : `${session.id} automation status update sent`
    );
    await this.store.updateSessionSummary(workspacePath);
    return await this.store.getSnapshot(workspacePath);
  }

  async approveAutomationCheckpoint(
    request: AutomationCheckpointApprovalRequest
  ): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    const session = await this.requireAutomationSession(workspacePath, request.sessionId);
    const checkpoints = await this.store.listAutomationCheckpoints(workspacePath);
    const checkpoint =
      checkpoints.find((record) => record.id === (request.checkpointId ?? session.latestCheckpointId)) ?? null;

    if (!checkpoint) {
      throw new Error("Automation checkpoint not found.");
    }

    const response = request.response?.trim() || "";
    if (response && classifyAutomationChatIntent(response) === "question") {
      return await this.answerAutomationCheckpointQuestion(
        {
          workspacePath,
          session,
          checkpoint,
          question: response
        },
        request.response ?? response
      );
    }

    await this.store.writeAutomationCheckpoint(workspacePath, {
      ...checkpoint,
      status: "approved",
      userResponse: response || checkpoint.userResponse,
      approvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const controller = this.getAutomationController(workspacePath, session.id);
    controller.pauseRequested = false;
    controller.stopRequested = false;
    if (response) {
      controller.redirectInstruction = response;
    }

    await this.writeRunningAutomationSession(workspacePath, session, {
      latestCheckpointId: checkpoint.id,
      currentStepSummary: "Checkpoint approved. Continuing automation.",
      lastUserInstruction: response || session.lastUserInstruction,
      queuedUserInstruction: response || session.queuedUserInstruction
    });
    await this.store.appendPromptLog(workspacePath, {
      kind: "automation.checkpoint.approved",
      threadId: session.threadId,
      sessionId: session.id,
      checkpointId: checkpoint.id,
      response
    });
    await this.store.appendActivity(workspacePath, `${session.id} automation checkpoint approved`);
    await this.store.updateSessionSummary(workspacePath);
    void this.runAutomationLoop(workspacePath, session.id);
    return await this.store.getSnapshot(workspacePath);
  }

  private async handleAutomationChatMessage(
    input: {
      workspacePath: string;
      threadId: string;
      rawPrompt: string;
      normalizedPrompt: string;
    },
    _options: {
      strategistSessionReady?: boolean;
    } = {}
  ): Promise<ProjectSnapshot | null> {
    const snapshot = await this.store.getSnapshot(input.workspacePath);
    const session =
      snapshot.latestAutomationSession?.threadId === input.threadId
        ? snapshot.latestAutomationSession
        : null;

    if (!session) {
      return null;
    }

    const pendingCheckpoint = resolveActivePendingAutomationCheckpoint(snapshot, session);
    const interactive = session.status === "running" || Boolean(pendingCheckpoint);

    if (!interactive) {
      return null;
    }

    const intent = classifyAutomationChatIntent(input.normalizedPrompt);

    if (intent === "stop") {
      return await this.interruptAutomationSession({
        workspacePath: input.workspacePath,
        sessionId: session.id,
        instruction: input.rawPrompt,
        stopNow: true
      });
    }

    if (session.status === "running") {
      return await this.interruptAutomationSession({
        workspacePath: input.workspacePath,
        sessionId: session.id,
        instruction: input.rawPrompt,
        stopNow: false
      });
    }

    if (pendingCheckpoint && intent !== "question") {
      return await this.approveAutomationCheckpoint({
        workspacePath: input.workspacePath,
        sessionId: session.id,
        checkpointId: pendingCheckpoint.id,
        response: input.rawPrompt
      });
    }

    if (pendingCheckpoint) {
      return await this.answerAutomationCheckpointQuestion(
        {
          workspacePath: input.workspacePath,
          session,
          checkpoint: pendingCheckpoint,
          question: input.normalizedPrompt
        },
        input.rawPrompt
      );
    }

    return null;
  }

  private async answerAutomationCheckpointQuestion(
    input: {
      workspacePath: string;
      session: AutomationSessionRecord;
      checkpoint: AutomationCheckpointRecord;
      question: string;
    },
    displayPrompt: string
  ) {
    await this.store.appendPromptLog(input.workspacePath, {
      kind: "chat.user",
      lane: "automation",
      threadId: input.session.threadId,
      prompt: displayPrompt,
      normalizedPrompt: input.question,
      source: "automation-checkpoint-question"
    });

    await this.store.appendActivity(
      input.workspacePath,
      `${input.session.id} answered an automation checkpoint question in chat`
    );

    return await this.startBuilderTask({
      workspacePath: input.workspacePath,
      threadId: input.session.threadId,
      prompt: buildAutomationChatFollowupPrompt(
        input.session,
        input.question,
        input.checkpoint
      ),
      displayPrompt
    });
  }

  async importAttachments(request: AttachmentImportRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.store.initProject(workspacePath, {
      name: await this.resolveProjectName(workspacePath)
    });
    if (request.threadId) {
      await this.store.selectThread(workspacePath, request.threadId);
    }
    const snapshot = await this.store.getSnapshot(workspacePath);
    const activeThread = snapshot.activeThread;

    if (!activeThread) {
      throw new Error("No active thread is available.");
    }

    const imported = await this.store.importAttachments(workspacePath, activeThread.id, request.filePaths);

    if (imported.length) {
      await this.store.appendActivity(
        workspacePath,
        `attachments imported for ${activeThread.id}: ${imported.map((record) => record.relativePath).join(", ")}`
      );
      await this.store.updateSessionSummary(workspacePath);
      await this.store.buildContextBundle(
        workspacePath,
        "Refresh the Lithium context bundle after importing attachments."
      );
    }

    return await this.store.getSnapshot(workspacePath);
  }

  async removeAttachment(request: AttachmentDeleteRequest): Promise<ProjectSnapshot> {
    const workspacePath = this.requireWorkspacePath(request.workspacePath);
    const removed = await this.store.removeAttachment(workspacePath, request.attachmentId);

    if (removed) {
      await this.store.appendActivity(workspacePath, `attachment removed: ${removed.relativePath}`);
      await this.store.updateSessionSummary(workspacePath);
      await this.store.buildContextBundle(
        workspacePath,
        "Refresh the Lithium context bundle after removing an attachment."
      );
    }

    return await this.store.getSnapshot(workspacePath);
  }

  async beginStrategistSignIn(): Promise<void> {
    await this.chatgptAuthRunner.signIn();
    await this.chatgptAuthRunner.prepareReusableSession?.();
  }

  async runStrategistBrowserProbe(
    request: StrategistBrowserProbeRequest,
    options: {
      strategistSessionReady?: boolean;
    } = {}
  ): Promise<StrategistBrowserProbeResponse> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    const prompt =
      request.prompt?.trim() ||
      "Reply with one short sentence confirming that the strategist browser visibility probe is live.";
    const reasoningIntensity = coerceStrategistThinkingTime(request.model, request.reasoningIntensity);
    const monitor = await startStrategistBrowserProbeMonitor({
      workspacePath,
      prompt,
      model: request.model,
      reasoningIntensity,
      strategistSessionReady: Boolean(options.strategistSessionReady)
    });

    let snapshot: ProjectSnapshot;
    let errorMessage: string | undefined;

    try {
      snapshot = await this.consultStrategist(
        {
          workspacePath,
          threadId: request.threadId,
          prompt,
          displayPrompt: prompt,
          model: request.model,
          reasoningIntensity
        },
        options
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      snapshot = await this.getSnapshot(workspacePath);
    }

    const probe = await monitor.stop({
      error: errorMessage
    });

    return {
      ok: !errorMessage,
      error: errorMessage,
      snapshot,
      probe
    };
  }

  async sendChatMessage(
    request: ChatRequest,
    options: {
      strategistSessionReady?: boolean;
    } = {}
  ): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.store.initProject(workspacePath, {
      name: await this.resolveProjectName(workspacePath)
    });

    if (request.threadId) {
      await this.store.selectThread(workspacePath, request.threadId);
    }

    const snapshot = await this.store.getSnapshot(workspacePath);
    const activeThread = snapshot.activeThread;

    if (!activeThread) {
      throw new Error("No active thread is available.");
    }

    const override = extractChatRouteOverride(request.prompt);
    const normalizedPrompt =
      override.prompt || (override.route === "builder" ? snapshot.latestTask?.prompt?.trim() || "" : "");

    if (!normalizedPrompt) {
      throw new Error("No chat prompt is available after applying the route override.");
    }

    if (!override.route) {
      const automationSnapshot = await this.handleAutomationChatMessage(
        {
          workspacePath,
          threadId: activeThread.id,
          rawPrompt: request.prompt,
          normalizedPrompt
        },
        options
      );

      if (automationSnapshot) {
        return automationSnapshot;
      }
    }

    const routePaths = await this.store.allocateRouteTrace(workspacePath);

    await this.store.appendPromptLog(workspacePath, {
      kind: "chat.user",
      lane: "chat",
      threadId: activeThread.id,
      prompt: request.prompt,
      normalizedPrompt,
      requestedRoute: override.route
    });

    try {
      this.setChatProgress(workspacePath, {
        lane: "router",
        progressSummary: "Routing your message.",
        progressDetails: ["Choosing whether this should go to the strategist or the builder."],
        activeCommand: null
      });
      const route = await this.routerRunner.route({
        workspacePath,
        prompt: normalizedPrompt,
        activeThreadSummary: activeThread.summary,
        threadMemory: activeThread.memory,
        latestDecisionSummary: snapshot.latestDecision?.summary,
        latestTaskPrompt: snapshot.latestTask?.prompt,
        latestRunSummary:
          handoffMachineSummary(snapshot.latestRun?.handoff) ||
          extractRunSummary(snapshot.latestRun?.finalMessage ?? ""),
        latestRunStatus: snapshot.latestRun?.status,
        automationStatus: snapshot.latestAutomationSession?.status,
        automationStepSummary: snapshot.latestAutomationSession?.currentStepSummary,
        automationCheckpointSummary: snapshot.latestAutomationCheckpoint?.summary,
        stdoutPath: routePaths.stdoutPath,
        stderrPath: routePaths.stderrPath,
        outputPath: routePaths.outputPath,
        attachments: snapshot.activeThreadAttachments.map((attachment) => ({
          name: attachment.name,
          kind: attachment.kind,
          excerpt: attachment.excerpt
        }))
      });

      const modelRoute = route.decision.route;
      const finalRoute = override.route ?? modelRoute;
      const downstreamPrompt = route.decision.rewrittenPrompt.trim() || normalizedPrompt;
      const builderDisplayPrompt =
        override.route === "builder" && !override.prompt ? normalizedPrompt : request.prompt;

      await this.store.appendPromptLog(workspacePath, {
        kind: "chat.router",
        threadId: activeThread.id,
        prompt: request.prompt,
        normalizedPrompt,
        rewrittenPrompt: downstreamPrompt,
        modelRoute,
        finalRoute,
        requestedRoute: override.route,
        reasonShort: route.decision.reasonShort
      });

      let downstreamSnapshot: ProjectSnapshot | null = null;
      let downstreamError: string | undefined;
      const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);

      try {
        if (finalRoute === "builder") {
          this.setChatProgress(workspacePath, {
            lane: "builder",
            progressSummary: "Starting the builder task.",
            progressDetails: [route.decision.reasonShort || "The router chose the builder lane."],
            activeCommand: null
          });
          downstreamSnapshot = await this.startBuilderTask({
            workspacePath,
            threadId: activeThread.id,
            prompt: downstreamPrompt,
            displayPrompt: builderDisplayPrompt
          });
        } else if (finalRoute === "mixed") {
          const strategistSnapshot = await this.consultStrategist(
            {
              workspacePath,
              threadId: activeThread.id,
              prompt: downstreamPrompt,
              displayPrompt: request.prompt
            },
            options
          );

          this.setChatProgress(workspacePath, {
            lane: "builder",
            progressSummary: "Starting the builder follow-up from the strategist context.",
            progressDetails: [
              route.decision.reasonShort || "The router chose strategist first, then builder."
            ],
            activeCommand: null
          });
          downstreamSnapshot = await this.startBuilderTask({
            workspacePath,
            threadId: activeThread.id,
            prompt: buildContextDrivenBuilderPrompt(
              downstreamPrompt,
              strategistSnapshot.latestDecision,
              appSettings.autopilotPromptLanguage
            ),
            displayPrompt: builderDisplayPrompt
          });
        } else {
          downstreamSnapshot = await this.consultStrategist(
            {
              workspacePath,
              threadId: activeThread.id,
              prompt: downstreamPrompt,
              displayPrompt: request.prompt
            },
            options
          );
        }
      } catch (error) {
        downstreamError = error instanceof Error ? error.message : String(error);
      }

      const trace: RouterTraceRecord = {
        id: routePaths.id,
        threadId: activeThread.id,
        prompt: request.prompt,
        normalizedPrompt,
        rewrittenPrompt: downstreamPrompt,
        requestedRoute: override.route,
        route: modelRoute,
        finalRoute,
        reasonShort: route.decision.reasonShort,
        rawOutput: route.rawOutput,
        command: route.command,
        stdoutPath: routePaths.stdoutPath,
        stderrPath: routePaths.stderrPath,
        outputPath: routePaths.outputPath,
        downstreamDecisionId: downstreamSnapshot?.latestDecision?.id,
        downstreamRunId: downstreamSnapshot?.latestRun?.id,
        downstreamTaskId: downstreamSnapshot?.latestTask?.id,
        downstreamError,
        createdAt: route.startedAt,
        decidedAt: route.endedAt,
        completedAt: new Date().toISOString()
      };

      await this.store.writeRouterTrace(workspacePath, trace);
      await this.store.appendActivity(
        workspacePath,
        formatRouterActivityLine(trace)
      );

      if (downstreamError) {
        throw new Error(downstreamError);
      }

      return await this.store.getSnapshot(workspacePath);
    } finally {
      this.clearChatProgress(workspacePath);
    }
  }

  async consultStrategist(
    request: StrategistRequest,
    options: {
      strategistSessionReady?: boolean;
      manageProgress?: boolean;
    } = {}
  ): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    const manageProgress = options.manageProgress ?? true;
    const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);

    if (manageProgress) {
      this.setChatProgress(workspacePath, {
        lane: "strategist",
        progressSummary: "Thinking…",
        progressDetails: [],
        activeCommand: null
      });
    }

    try {
      await this.prepareReusableStrategistSession(options.strategistSessionReady);
      if (manageProgress) {
        this.setChatProgress(workspacePath, {
          lane: "strategist",
          progressSummary: "Thinking…",
          progressDetails: [],
          activeCommand: null
        });
      }

      const project = await this.store.initProject(workspacePath, {
        name: await this.resolveProjectName(workspacePath)
      });
      if (request.threadId) {
        await this.store.selectThread(workspacePath, request.threadId);
      }
      const currentSnapshot = await this.store.getSnapshot(workspacePath);
      const activeThread = currentSnapshot.activeThread;
      if (!activeThread) {
        throw new Error("No active thread is available.");
      }
      const decisionPaths = await this.store.allocateDecision(workspacePath);
      const strategistSessionSlug = buildStrategistOracleSessionId(
        workspacePath,
        activeThread.id
      );
      const activeProgressSlug = this.activeChatProgressByWorkspace.get(workspacePath)?.oracleSessionSlug;
      const strategistSlugsToTerminate = Array.from(
        new Set([activeProgressSlug, strategistSessionSlug].filter((value): value is string => Boolean(value)))
      );

      for (const slug of strategistSlugsToTerminate) {
        await this.oracleRunner.terminateSession?.(slug).catch(() => undefined);
      }

      const strategistContextFingerprint = buildStrategistContextFingerprint(currentSnapshot);
      const strategistContext = await this.prepareModelContext({
        workspacePath,
        prompt: request.prompt,
        lane: "strategist",
        snapshot: currentSnapshot,
        artifactId: decisionPaths.id
      });
      const attachStrategistRuntimeContext = shouldAttachStrategistRuntimeContext(
        currentSnapshot,
        strategistContextFingerprint
      );
      const workspaceFiles = await this.store.listWorkspaceFiles(workspacePath);
      const explicitlyMentionedWorkspaceFiles =
        request.attachExplicitWorkspaceFiles === false
          ? []
          : resolveExplicitStrategistWorkspaceFiles(request.prompt, workspacePath, workspaceFiles);
      const strategistAttachments = currentSnapshot.activeThreadAttachments
        .filter((record) => record.sizeBytes <= 10 * 1024 * 1024)
        .slice(0, 8)
        .map((record) => path.join(workspacePath, record.relativePath));
      const strategistFiles = Array.from(
        new Set([
          attachStrategistRuntimeContext ? strategistContext.runtimeContextPath : undefined,
          ...explicitlyMentionedWorkspaceFiles,
          ...strategistAttachments
        ].filter((value): value is string => Boolean(value)))
      ).filter((filePath) => isSupportedStrategistUploadPath(filePath));
      const strategistOraclePrompt = request.prompt;
      const strategistModel = request.model ?? project.oracleModel;
      const strategistReasoningIntensity =
        request.reasoningIntensity === undefined
          ? appSettings.strategistReasoningIntensity
          : coerceStrategistThinkingTime(strategistModel, request.reasoningIntensity);

      await this.store.appendPromptLog(workspacePath, {
        kind: "strategist.request",
        threadId: activeThread.id,
        prompt: request.prompt,
        displayPrompt: request.displayPrompt,
        model: strategistModel,
        reasoningIntensity: strategistReasoningIntensity,
        oracleSessionSlug: strategistSessionSlug,
        files: strategistFiles,
        runtimeContext: strategistContext.runtimeContext,
        contextPackPath: strategistContext.contextPackPath
      });
      if (manageProgress) {
        this.setChatProgress(workspacePath, {
          lane: "strategist",
          progressSummary: "Thinking…",
          progressDetails: [],
          activeCommand: null,
          oracleSessionSlug: strategistSessionSlug,
          stdoutPath: decisionPaths.stdoutPath,
          stderrPath: decisionPaths.stderrPath
        });
      }
      const result = await this.oracleRunner.consult({
        workspacePath,
        prompt: strategistOraclePrompt,
        model: strategistModel,
        browserThinkingTime: strategistReasoningIntensity,
        files: strategistFiles,
        stdoutPath: decisionPaths.stdoutPath,
        stderrPath: decisionPaths.stderrPath,
        outputPath: decisionPaths.outputPath,
        slug: strategistSessionSlug,
        strategistSessionReady: options.strategistSessionReady
      });

      if (manageProgress) {
        this.setChatProgress(workspacePath, {
          lane: "strategist",
          progressSummary: "Finishing…",
          progressDetails: [],
          activeCommand: null,
          oracleSessionSlug: result.sessionId ?? strategistSessionSlug,
          stdoutPath: decisionPaths.stdoutPath,
          stderrPath: decisionPaths.stderrPath
        });
      }

      if (result.chromePath) {
        await this.store.initProject(workspacePath, {
          name: await this.resolveProjectName(workspacePath),
          oracleChromePath: result.chromePath
        });
      }

      const strategistOutput = result.outputText || result.stdout || result.stderr;
      const strategistOutputIssue = describeIncompleteStrategistOutput(strategistOutput);

      if (strategistOutputIssue) {
        throw new Error(strategistOutputIssue);
      }

      const decision = this.buildDecisionRecord({
        id: decisionPaths.id,
        threadId: activeThread.id,
        prompt: request.prompt,
        displayPrompt: request.displayPrompt,
        inputFiles: strategistFiles,
        model: strategistModel,
        rawOutput: strategistOutput,
        command: result.command,
        stdoutPath: decisionPaths.stdoutPath,
        stderrPath: decisionPaths.stderrPath,
        outputPath: decisionPaths.outputPath,
        contextPackPath: strategistContext.contextPackPath,
        startedAt: result.startedAt,
        exitCode: result.exitCode
      });

      await this.store.writeDecision(workspacePath, decision);
      await this.store.appendPromptLog(workspacePath, {
        kind: "strategist.response",
        threadId: activeThread.id,
        decisionId: decision.id,
        model: strategistModel,
        oracleSessionSlug: strategistSessionSlug,
        oracleSessionId: result.sessionId,
        summary: decision.summary,
        rationale: decision.rationale,
        rawOutput: decision.rawOutput
      });

      await this.syncThreadFromArtifacts(workspacePath, activeThread, {
        prompt: request.displayPrompt ?? request.prompt,
        summary: handoffUserMessage(decision.handoff) || decision.summary,
        strategistContextFingerprint: attachStrategistRuntimeContext
          ? strategistContextFingerprint
          : undefined,
        strategistContextAttachedAt: attachStrategistRuntimeContext ? new Date().toISOString() : undefined
      });
      await this.store.appendActivity(
        workspacePath,
        `${decision.id} saved as research context`
      );
      await this.store.updateSessionSummary(workspacePath);

      return await this.store.getSnapshot(workspacePath);
    } finally {
      if (manageProgress) {
        this.clearChatProgress(workspacePath);
      }
    }
  }

  async runBuilderTask(request: BuilderRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.reconcileStaleBuilderRuns(workspacePath);
    const project = await this.store.initProject(workspacePath, {
      name: await this.resolveProjectName(workspacePath)
    });
    if (request.threadId) {
      await this.store.selectThread(workspacePath, request.threadId);
    }
    const snapshot = await this.store.getSnapshot(workspacePath);
    const activeThread = snapshot.activeThread;
    if (!activeThread) {
      throw new Error("No active thread is available.");
    }
    const prompt = request.prompt.trim() || snapshot.latestTask?.prompt || "";
    const displayPrompt = request.displayPrompt?.trim() || prompt;

    if (!prompt) {
      throw new Error("No builder task is available yet. Enter a task prompt or create one from the latest context.");
    }

    const existingTask =
      snapshot.tasks.find((task) => task.prompt.trim() === prompt && task.status === "pending") ??
      null;
    const task =
      existingTask ??
      ({
        id: (await this.store.allocateTask(workspacePath)).id,
        threadId: activeThread.id,
        sourceDecisionId: snapshot.latestDecision?.id,
        title: prompt.slice(0, 80) || "Lithium builder task",
        prompt,
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      } satisfies TaskRecord);

    if (!existingTask) {
      await this.store.writeTask(workspacePath, task);
    }

    const runPaths = await this.store.allocateRun(workspacePath);
    const builderContext = await this.prepareModelContext({
      workspacePath,
      prompt,
      lane: "builder",
      snapshot,
      artifactId: runPaths.id
    });
    const executionContext = await resolveWorkspaceCommandContext(workspacePath);
    const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
    const builderModel = resolveBuilderModel(request.model, project.codexModel);
    const builderReasoningEffort = resolveBuilderReasoningEffort(
      request.reasoningEffort,
      appSettings.builderReasoningEffort
    );
    await this.store.appendPromptLog(workspacePath, {
      kind: "builder.request",
      threadId: activeThread.id,
      prompt,
      displayPrompt,
      model: builderModel,
      reasoningEffort: builderReasoningEffort,
      runtimeContext: builderContext.runtimeContext,
      artifactContext: builderContext.artifactContext
    });
    const result = await this.codexRunner.runTask({
      workspacePath,
      commandCwd: executionContext.commandCwd,
      prompt,
      runtimeContext: builderContext.runtimeContext,
      artifactContext: builderContext.artifactContext,
      model: builderModel,
      reasoningEffort: builderReasoningEffort,
      promptLanguage: appSettings.autopilotPromptLanguage,
      stdoutPath: runPaths.stdoutPath,
      stderrPath: runPaths.stderrPath,
      outputPath: runPaths.outputPath,
      env: executionContext.env
    });
    const changedFiles = mergeChangedFiles(
      parseChangedFilesFromFinalMessage(result.finalMessage),
      await collectGitChangedFiles(workspacePath)
    );
    const handoff = parseBuilderOutput(result.finalMessage);
    const status = inferFinalRunStatus({
      exitCode: result.exitCode,
      finalMessage: result.finalMessage,
      timedOut: result.timedOut
    });

    await this.store.writeRun(workspacePath, {
      id: runPaths.id,
      threadId: activeThread.id,
      taskId: task.id,
      prompt,
      displayPrompt,
      model: builderModel,
      status,
      exitCode: result.exitCode,
      pid: null,
      command: result.command,
      stdoutPath: runPaths.stdoutPath,
      stderrPath: runPaths.stderrPath,
      finalMessagePath: runPaths.outputPath,
      finalMessage: result.finalMessage,
      handoff,
      changedFiles,
      contextPackPath: builderContext.contextPackPath,
      finalization: "auto",
      createdAt: result.startedAt,
      startedAt: result.startedAt,
      endedAt: result.endedAt
    });

    await this.store.writeTask(workspacePath, {
      ...task,
      status,
      updatedAt: new Date().toISOString()
    });
    await this.syncThreadFromArtifacts(workspacePath, activeThread, {
      prompt: displayPrompt,
      summary: extractRunSummary(result.finalMessage)
    });
    await this.store.appendPromptLog(workspacePath, {
      kind: "builder.response",
      threadId: activeThread.id,
      runId: runPaths.id,
      model: builderModel,
      status,
      finalMessage: result.finalMessage,
      changedFiles,
      summary: handoffMachineSummary(handoff) || handoff.summary
    });
    await this.store.appendActivity(workspacePath, `${runPaths.id} finished with status ${status}`);
    await this.store.updateSessionSummary(workspacePath);
    await this.syncRemoteChangedFiles(workspacePath, changedFiles);

    return await this.store.getSnapshot(workspacePath);
  }

  async startBuilderTask(request: BuilderRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.reconcileStaleBuilderRuns(workspacePath);
    const project = await this.store.initProject(workspacePath, {
      name: await this.resolveProjectName(workspacePath)
    });
    if (request.threadId) {
      await this.store.selectThread(workspacePath, request.threadId);
    }
    let snapshot = await this.store.getSnapshot(workspacePath);
    const activeThread = snapshot.activeThread;
    if (!activeThread) {
      throw new Error("No active thread is available.");
    }
    const prompt = request.prompt.trim() || snapshot.latestTask?.prompt || "";
    const displayPrompt = request.displayPrompt?.trim() || prompt;

    if (!prompt) {
      throw new Error("No builder task is available yet. Enter a task prompt or create one from the latest context.");
    }

    let activeRun =
      snapshot.runs.find((run) => run.status === "running" && getLiveProcess(workspacePath, run.id)) ?? null;

    if (!activeRun) {
      for (const candidate of snapshot.runs) {
        if (candidate.status !== "running") {
          continue;
        }

        if (await this.isRecoverableDetachedBuilderRun(candidate)) {
          activeRun = candidate;
          break;
        }
      }
    }

    if (activeRun) {
      if (activeRun.prompt.trim() === prompt) {
        return snapshot;
      }

      await this.terminateBuilderRun({
        workspacePath,
        runId: activeRun.id
      });
      snapshot = await this.store.getSnapshot(workspacePath);
    }

    const existingTask =
      snapshot.tasks.find((task) => task.prompt.trim() === prompt && task.status === "pending") ??
      null;
    const task =
      existingTask ??
      ({
        id: (await this.store.allocateTask(workspacePath)).id,
        threadId: activeThread.id,
        sourceDecisionId: snapshot.latestDecision?.id,
        title: prompt.slice(0, 80) || "Lithium builder task",
        prompt,
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      } satisfies TaskRecord);

    if (!existingTask) {
      await this.store.writeTask(workspacePath, task);
    } else {
      await this.store.writeTask(workspacePath, {
        ...task,
        status: "running",
        updatedAt: new Date().toISOString()
      });
    }

    const runPaths = await this.store.allocateRun(workspacePath);
    const builderContext = await this.prepareModelContext({
      workspacePath,
      prompt,
      lane: "builder",
      snapshot,
      artifactId: runPaths.id
    });
    const executionContext = await resolveWorkspaceCommandContext(workspacePath);
    const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
    const builderModel = resolveBuilderModel(request.model, project.codexModel);
    const builderReasoningEffort = resolveBuilderReasoningEffort(
      request.reasoningEffort,
      appSettings.builderReasoningEffort
    );
    await this.store.appendPromptLog(workspacePath, {
      kind: "builder.request",
      threadId: activeThread.id,
      prompt,
      displayPrompt,
      model: builderModel,
      reasoningEffort: builderReasoningEffort,
      runtimeContext: builderContext.runtimeContext,
      artifactContext: builderContext.artifactContext,
      live: true
    });
    const command =
      this.codexRunner.buildTaskCommand
        ? this.codexRunner.buildTaskCommand(
            executionContext.commandCwd,
            prompt,
            runPaths.outputPath,
            builderContext.runtimeContext,
            builderContext.artifactContext,
            builderModel,
            builderReasoningEffort,
            appSettings.autopilotPromptLanguage
          )
        : new CodexRunner().buildTaskCommand(
            executionContext.commandCwd,
            prompt,
            runPaths.outputPath,
            builderContext.runtimeContext,
            builderContext.artifactContext,
            builderModel,
            builderReasoningEffort,
            appSettings.autopilotPromptLanguage
          );
    const liveHandle = startLiveProcess({
      id: runPaths.id,
      workspacePath,
      spec: command,
      stdoutPath: runPaths.stdoutPath,
      stderrPath: runPaths.stderrPath,
      outputPath: runPaths.outputPath,
      env: executionContext.env
    });

    await this.store.writeRun(workspacePath, {
      id: runPaths.id,
      threadId: activeThread.id,
      taskId: task.id,
      prompt,
      displayPrompt,
      model: builderModel,
      status: "running",
      exitCode: null,
      pid: liveHandle.pid,
      command,
      stdoutPath: runPaths.stdoutPath,
      stderrPath: runPaths.stderrPath,
      finalMessagePath: runPaths.outputPath,
      finalMessage: "",
      handoff: null,
      changedFiles: [],
      contextPackPath: builderContext.contextPackPath,
      finalization: null,
      createdAt: liveHandle.startedAt,
      startedAt: liveHandle.startedAt,
      endedAt: undefined
    });
    await this.syncThreadFromArtifacts(workspacePath, activeThread, {
      prompt: displayPrompt
    });
    await this.store.appendActivity(workspacePath, `${runPaths.id} started`);

    void liveHandle.done
      .then(async (result) => {
        if (this.terminatingRunIds.has(runPaths.id)) {
          return;
        }

        await this.finalizeBuilderRun(
          { workspacePath, runId: runPaths.id },
          {
            exitCode: result.exitCode,
            finalMessage: await this.readRunFinalMessage(
              runPaths.outputPath,
              runPaths.stdoutPath,
              runPaths.stderrPath
            ),
            finalization: "auto",
            endedAt: result.endedAt,
            timedOut: result.timedOut
          }
        );
      })
      .catch(async (error: unknown) => {
        if (this.terminatingRunIds.has(runPaths.id)) {
          return;
        }

        const failedRun = await this.store.readRun(workspacePath, runPaths.id);
        if (!failedRun || (failedRun.finalization !== null && failedRun.status !== "running")) {
          return;
        }

        await this.store.writeRun(workspacePath, {
          ...failedRun,
          status: "failed",
          exitCode: failedRun.exitCode,
          finalMessage: `${failedRun.finalMessage}\n${String(error)}`.trim(),
          finalization: "auto",
          endedAt: new Date().toISOString()
        });
        await this.store.writeTask(workspacePath, {
          ...task,
          status: "failed",
          updatedAt: new Date().toISOString()
        });
      });

    return await this.store.getSnapshot(workspacePath);
  }

  async inspectBuilderRun(request: BuilderRunControlRequest): Promise<BuilderRunInspection | null> {
    const workspacePath = this.resolveWorkspacePath(request.workspacePath);

    if (!workspacePath) {
      return null;
    }

    const run = request.runId
      ? await this.store.readRun(workspacePath, request.runId)
      : (await this.store.getSnapshot(workspacePath)).latestRun;

    if (!run) {
      return null;
    }

    const activeHandle = getLiveProcess(workspacePath, run.id);
    const detachedProcessActive = !activeHandle && (await this.isRecoverableDetachedBuilderRun(run));
    const runActive = Boolean(activeHandle) || detachedProcessActive;
    const fileState = await inspectLiveProcessFiles({
      stdoutPath: run.stdoutPath,
      stderrPath: run.stderrPath,
      outputPath: run.finalMessagePath,
      stdoutTailBytes: 96 * 1024,
      stderrTailBytes: 32 * 1024
    });
    const quietForMs = fileState.lastTouched
      ? Math.max(0, Date.now() - fileState.lastTouched)
      : Math.max(0, Date.now() - new Date(run.startedAt).getTime());
    const parsedChangedFiles = parseChangedFilesFromFinalMessage(fileState.outputText);
    const shouldCollectGitChangedFiles =
      !runActive && (run.finalization !== null || parsedChangedFiles.length > 0);
    const gitChangedFiles = shouldCollectGitChangedFiles ? await collectGitChangedFiles(workspacePath) : [];
    const changedFiles = mergeChangedFiles(run.changedFiles ?? [], parsedChangedFiles, gitChangedFiles);
    const progress = parseCodexProgressLog(fileState.stdout);

    return {
      run: changedFiles.length === (run.changedFiles ?? []).length ? run : { ...run, changedFiles },
      active: runActive,
      pid: activeHandle?.pid ?? run.pid,
      stdoutTail: fileState.stdout,
      stderrTail: fileState.stderr,
      outputText: fileState.outputText,
      changedFiles,
      progressSummary: progress.progressSummary,
      progressDetails: progress.progressDetails,
      activeCommand: progress.activeCommand,
      suggestedStatus: inferRunStatus({
        run,
        active: runActive,
        quietForMs,
        outputText: fileState.outputText,
        activeCommand: progress.activeCommand
      }),
      quietForMs
    };
  }

  async inspectChatProgress(request: ChatProgressRequest = {}): Promise<ChatProgressInspection | null> {
    const workspacePath = this.resolveWorkspacePath(request.workspacePath);

    if (!workspacePath) {
      return null;
    }

    const progress = this.activeChatProgressByWorkspace.get(workspacePath);

    if (!progress) {
      return null;
    }

    const [stdoutTail, stderrTail, oracleLogTail, liveOracleProgress] = await Promise.all([
      progress.stdoutPath ? readTailText(progress.stdoutPath) : Promise.resolve(""),
      progress.stderrPath ? readTailText(progress.stderrPath) : Promise.resolve(""),
      progress.oracleSessionSlug ? readOracleSessionTail(progress.oracleSessionSlug) : Promise.resolve(""),
      progress.oracleSessionSlug ? readLiveOracleSessionProgress(progress.oracleSessionSlug) : Promise.resolve(null)
    ]);
    const oracleProgress = extractOracleSessionProgress(oracleLogTail);
    const strategistProgress = progress.lane === "strategist";
    const strategistLiveProgress = mergeStrategistLiveProgress(liveOracleProgress, oracleProgress);

    return {
      active: true,
      lane: progress.lane,
      progressSummary: strategistProgress
        ? strategistLiveProgress.progressSummary || progress.progressSummary
        : progress.progressSummary,
      progressDetails: strategistProgress
        ? strategistLiveProgress.progressDetails
        : mergeProgressDetails(progress.progressDetails, extractProgressTailDetails(stdoutTail, stderrTail)),
      activeCommand: progress.activeCommand,
      stdoutTail,
      stderrTail,
      updatedAt: progress.updatedAt
    };
  }

  async terminateBuilderRun(request: BuilderRunControlRequest): Promise<ProjectSnapshot> {
    const workspacePath = this.resolveWorkspacePath(request.workspacePath);

    if (!workspacePath) {
      return createEmptyProjectSnapshot();
    }

    const snapshot = await this.store.getSnapshot(workspacePath);
    const run = request.runId
      ? await this.store.readRun(workspacePath, request.runId)
      : snapshot.latestRun;

    if (!run) {
      return snapshot;
    }

    if (run.finalization !== null && run.status !== "running") {
      return snapshot;
    }

    this.terminatingRunIds.add(run.id);
    const activeHandle = getLiveProcess(workspacePath, run.id);
    const terminatedDetachedProcess =
      !activeHandle && (await this.terminateRecordedBuilderProcess(run));
    stopLiveProcess(workspacePath, run.id);

    const cancellingRun: RunRecord = {
      ...run,
      status: "cancelled",
      pid: null,
      endedAt: new Date().toISOString()
    };
    await this.store.writeRun(workspacePath, cancellingRun);

    const cancellingTask = snapshot.tasks.find((item) => item.id === run.taskId);
    if (cancellingTask) {
      await this.store.writeTask(workspacePath, {
        ...cancellingTask,
        status: "cancelled",
        updatedAt: new Date().toISOString()
      });
    }

    const activeDone = activeHandle
      ? activeHandle.done.catch(() => null)
      : null;

    if (activeDone) {
      await Promise.race([
        activeDone,
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }

    try {
      const finalMessage = await this.readRunFinalMessage(run.finalMessagePath, run.stdoutPath, run.stderrPath);
      const recoveredOutput = (await readTextFile(run.finalMessagePath)).trim();
      const shouldUseCancelledMessage =
        (!recoveredOutput && terminatedDetachedProcess) ||
        !finalMessage.trim() ||
        !this.isUsableBuilderFallback(finalMessage) ||
        /without writing a final answer/i.test(finalMessage);
      await this.finalizeBuilderRun(
        { workspacePath, runId: run.id },
        {
          exitCode: run.exitCode,
          finalMessage: shouldUseCancelledMessage
            ? createSyntheticBuilderFinalMessage(
                terminatedDetachedProcess
                  ? "Lithium cancelled this task while recovering a detached builder process."
                  : "Lithium cancelled this task before it finished.",
                "partial"
              )
            : finalMessage,
          finalization: "terminated",
          endedAt: new Date().toISOString(),
          timedOut: false,
          forcedStatus: "cancelled"
        }
      );
    } finally {
      this.terminatingRunIds.delete(run.id);
    }

    return await this.store.getSnapshot(workspacePath);
  }

  async finalizeBuilderRun(
    request: BuilderRunControlRequest,
    override?: {
      exitCode: number | null;
      finalMessage: string;
      finalization: "auto" | "manual" | "terminated";
      endedAt: string;
      timedOut: boolean;
      forcedStatus?: RecordStatus;
    }
  ): Promise<ProjectSnapshot> {
    const workspacePath = this.resolveWorkspacePath(request.workspacePath);

    if (!workspacePath) {
      return createEmptyProjectSnapshot();
    }

    const snapshot = await this.store.getSnapshot(workspacePath);
    const run = request.runId
      ? await this.store.readRun(workspacePath, request.runId)
      : snapshot.latestRun;

    if (!run) {
      return snapshot;
    }

    if (run.finalization !== null && run.status !== "running" && !override?.forcedStatus) {
      return snapshot;
    }

    const finalMessage =
      override?.finalMessage ||
      (await this.readRunFinalMessage(run.finalMessagePath, run.stdoutPath, run.stderrPath));
    const parsedChangedFiles = parseChangedFilesFromFinalMessage(finalMessage);
    const gitChangedFiles = await collectGitChangedFiles(workspacePath);
    const changedFiles = mergeChangedFiles(run.changedFiles ?? [], parsedChangedFiles, gitChangedFiles);
    const handoff = parseBuilderOutput(finalMessage);
    const status =
      override?.forcedStatus ??
      inferFinalRunStatus({
        exitCode: override?.exitCode ?? run.exitCode,
        finalMessage,
        timedOut: override?.timedOut ?? false
      });
    const finalizedRun: RunRecord = {
      ...run,
      status,
      exitCode: override?.exitCode ?? run.exitCode,
      pid: null,
      finalMessage,
      handoff,
      changedFiles,
      finalization: override?.finalization ?? "manual",
      endedAt: override?.endedAt ?? new Date().toISOString()
    };

    await this.store.writeRun(workspacePath, finalizedRun);
    await this.store.appendPromptLog(workspacePath, {
      kind: "builder.response",
      threadId: finalizedRun.threadId,
      runId: finalizedRun.id,
      model: finalizedRun.model,
      status: finalizedRun.status,
      finalMessage: finalizedRun.finalMessage,
      changedFiles,
      summary: handoffMachineSummary(handoff) || handoff.summary
    });

    const task = snapshot.tasks.find((item) => item.id === run.taskId);
    if (task) {
      await this.store.writeTask(workspacePath, {
        ...task,
        status,
        updatedAt: new Date().toISOString()
      });
    }

    const thread = snapshot.threads.find((item) => item.id === finalizedRun.threadId) ?? null;
    const threadSummary = extractRunSummary(finalMessage);
    if (thread) {
      await this.syncThreadFromArtifacts(workspacePath, thread, {
        summary: shouldPersistThreadSummary(threadSummary) ? threadSummary : thread.summary
      });
    }

    await this.store.appendActivity(workspacePath, `${run.id} finalized as ${status}`);
    await this.store.updateSessionSummary(workspacePath);
    await this.syncRemoteChangedFiles(workspacePath, changedFiles);

    return await this.store.getSnapshot(workspacePath);
  }

  async updateManuscript(workspacePath?: string): Promise<ProjectSnapshot> {
    const resolvedWorkspacePath = await this.resolveResearchWorkspacePath(workspacePath);
    await this.store.initProject(resolvedWorkspacePath, {
      name: await this.resolveProjectName(resolvedWorkspacePath)
    });
    const snapshot = await this.store.getSnapshot(resolvedWorkspacePath);
    const content = this.manuscriptEngine.updateResults({
      decision: snapshot.latestDecision ?? undefined,
      run: snapshot.latestRun ?? undefined
    });
    await this.store.writeManuscriptSection(resolvedWorkspacePath, content);
    await this.store.appendActivity(resolvedWorkspacePath, "manuscript updated from latest artifacts");
    await this.store.updateSessionSummary(resolvedWorkspacePath);

    return await this.store.getSnapshot(resolvedWorkspacePath);
  }

  async compilePaper(workspacePath?: string): Promise<ProjectSnapshot> {
    const resolvedWorkspacePath = await this.resolveResearchWorkspacePath(workspacePath);
    await this.store.initProject(resolvedWorkspacePath, {
      name: await this.resolveProjectName(resolvedWorkspacePath)
    });

    const texPath = path.join(resolvedWorkspacePath, "paper", "main.tex");

    try {
      await access(texPath);
    } catch {
      throw new Error("paper/main.tex is missing.");
    }

    const runPaths = await this.store.allocateRun(resolvedWorkspacePath);
    const remoteWorkspace = await this.remoteWorkspaceService.describe(resolvedWorkspacePath);
    const result = remoteWorkspace
      ? await this.remoteWorkspaceService.runWorkspaceCommand(
          resolvedWorkspacePath,
          {
            command: "tectonic",
            args: ["-X", "compile", "--synctex", "paper/main.tex"],
            cwd: resolvedWorkspacePath
          },
          {
            stdoutPath: runPaths.stdoutPath,
            stderrPath: runPaths.stderrPath
          }
        )
      : await runCommand({
          spec: {
            command: "tectonic",
            args: ["-X", "compile", "--synctex", "paper/main.tex"],
            cwd: resolvedWorkspacePath
          },
          stdoutPath: runPaths.stdoutPath,
          stderrPath: runPaths.stderrPath
        });

    const finalMessage = [
      result.stdout.trim(),
      result.stderr.trim()
    ]
      .filter(Boolean)
      .join("\n");
    await writeFile(runPaths.outputPath, finalMessage, "utf8");

    if (remoteWorkspace) {
      await this.remoteWorkspaceService.pullWorkspaceFiles(resolvedWorkspacePath, [
        "paper/main.pdf",
        "paper/main.synctex.gz",
        "paper/main.log"
      ]);
    }

    if (result.exitCode === 0) {
      await this.store.appendActivity(
        resolvedWorkspacePath,
        remoteWorkspace
          ? "paper compiled remotely with tectonic: completed"
          : "paper compiled locally with tectonic: completed"
      );
      return await this.store.getSnapshot(resolvedWorkspacePath);
    }

    await this.store.appendActivity(
      resolvedWorkspacePath,
      remoteWorkspace
        ? "paper compiled remotely with tectonic: failed"
        : "paper compiled locally with tectonic: failed"
    );
    throw new Error(finalMessage || "Paper compilation failed.");
  }

  async listWorkspaceFiles(workspacePath?: string): Promise<WorkspaceFileRecord[]> {
    const resolvedWorkspacePath = this.resolveWorkspacePath(workspacePath);

    if (!resolvedWorkspacePath) {
      return [];
    }

    return await this.store.listWorkspaceFiles(resolvedWorkspacePath);
  }

  async readWorkspaceFile(request: WorkspaceFileRequest): Promise<WorkspaceFileContent> {
    const resolvedWorkspacePath = this.requireWorkspacePath(request.workspacePath);
    return await this.store.readWorkspaceFile(
      resolvedWorkspacePath,
      await resolveWorkspaceMemberPath(resolvedWorkspacePath, request.path)
    );
  }

  async readWorkspaceDiff(request: WorkspaceDiffRequest): Promise<WorkspaceFileDiff | null> {
    const resolvedWorkspacePath = this.requireWorkspacePath(request.workspacePath);
    return await readWorkspaceFileDiff(
      resolvedWorkspacePath,
      await resolveWorkspaceMemberPath(resolvedWorkspacePath, request.path),
      request.contextLines ?? 3
    );
  }

  async readWorkspaceFileBytes(request: WorkspaceFileRequest): Promise<Uint8Array> {
    const resolvedWorkspacePath = this.requireWorkspacePath(request.workspacePath);
    return await this.store.readWorkspaceFileBytes(
      resolvedWorkspacePath,
      await resolveWorkspaceMemberPath(resolvedWorkspacePath, request.path)
    );
  }

  async saveWorkspaceFile(request: {
    workspacePath?: string;
    path: string;
    content: string;
  }): Promise<WorkspaceFileContent> {
    const resolvedWorkspacePath = this.requireWorkspacePath(request.workspacePath);
    const nextFile = await this.store.writeWorkspaceFile(
      resolvedWorkspacePath,
      await resolveWorkspaceMemberPath(resolvedWorkspacePath, request.path),
      request.content
    );

    if (!nextFile.relativePath.startsWith(".lithium/")) {
      const remoteWorkspace = await this.remoteWorkspaceService.describe(resolvedWorkspacePath);
      if (remoteWorkspace) {
        await this.remoteWorkspaceService.pushWorkspaceFile(resolvedWorkspacePath, nextFile.relativePath);
      }
    }

    return nextFile;
  }

  async resolvePaperSyncTarget(request: PaperSyncTargetRequest): Promise<PaperSyncTarget | null> {
    const resolvedWorkspacePath = this.requireWorkspacePath(request.workspacePath);
    const pdfPath = await resolveWorkspaceMemberPath(resolvedWorkspacePath, request.pdfPath);
    const sourcePath = await resolveWorkspaceMemberPath(resolvedWorkspacePath, request.sourcePath);
    const synctexPath = this.resolveSyncTeXPath(pdfPath);

    try {
      await access(synctexPath);
    } catch {
      return null;
    }

    return await resolveSyncTeXTarget({
      synctexPath,
      sourcePath,
      lineNumber: request.lineNumber
    });
  }

  async resolvePaperSourceTarget(request: PaperSourceTargetRequest): Promise<PaperSourceTarget | null> {
    const resolvedWorkspacePath = this.requireWorkspacePath(request.workspacePath);
    const pdfPath = await resolveWorkspaceMemberPath(resolvedWorkspacePath, request.pdfPath);
    const synctexPath = this.resolveSyncTeXPath(pdfPath);

    try {
      await access(synctexPath);
    } catch {
      return null;
    }

    return await resolveSyncTeXSourceLocation({
      synctexPath,
      pageNumber: request.pageNumber,
      yRatio: request.yRatio
    });
  }

  async createTerminalSession(request: TerminalSessionCreateRequest): Promise<TerminalSessionState> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.store.initProject(workspacePath, {
      name: await this.resolveProjectName(workspacePath)
    });
    if (request.threadId) {
      await this.store.selectThread(workspacePath, request.threadId);
    }
    const snapshot = await this.store.getSnapshot(workspacePath);
    const activeThread = snapshot.activeThread;
    if (!activeThread) {
      throw new Error("No active thread is available.");
    }
    const cwd = request.cwd
      ? path.isAbsolute(request.cwd)
        ? request.cwd
        : path.join(workspacePath, request.cwd)
      : workspacePath;
    const bootstrapCommand =
      request.bootstrapCommand?.trim() ||
      (await this.remoteWorkspaceService.buildTerminalBootstrapCommand(workspacePath).catch(() => null)) ||
      undefined;
    const cols = clampTerminalSize(request.cols, 120, 40, 240);
    const rows = clampTerminalSize(request.rows, 32, 12, 120);
    const liveSession = await this.findActiveTerminalSession(workspacePath, activeThread.id);

    if (liveSession && !request.forceNew) {
      const resized = request.cols || request.rows
        ? resizeLiveTerminal(workspacePath, liveSession.id, cols, rows)
        : getLiveTerminal(workspacePath, liveSession.id);

      if (resized) {
        await this.store.writeTerminalSession(workspacePath, {
          ...liveSession,
          pid: resized.pid,
          cwd: resized.cwd,
          cols: resized.cols,
          rows: resized.rows
        });
      }

      const existingSession = await this.getTerminalSession({
        workspacePath,
        sessionId: liveSession.id
      });

      if (!existingSession) {
        throw new Error("Failed to restore the active terminal session.");
      }

      return existingSession;
    }

    await this.stopLiveTerminalSessionsForThread(workspacePath, activeThread.id);
    const sessionPaths = await this.store.allocateTerminalSession(workspacePath);
    const liveHandle = await startLiveTerminal({
      id: sessionPaths.id,
      workspacePath,
      cwd,
      transcriptPath: sessionPaths.transcriptPath,
      cols,
      rows,
      shell: request.shell,
      bootstrapCommand
    });
    const record: TerminalSessionRecord = {
      id: sessionPaths.id,
      threadId: activeThread.id,
      workspacePath,
      shell: liveHandle.shell,
      cwd,
      status: "running",
      exitCode: null,
      pid: liveHandle.pid,
      transcriptPath: sessionPaths.transcriptPath,
      stdoutPath: sessionPaths.stdoutPath,
      stderrPath: sessionPaths.stderrPath,
      cols,
      rows,
      startedAt: liveHandle.startedAt,
      endedAt: undefined
    };

    await this.store.writeTerminalSession(workspacePath, record);
    await Promise.all([
      writeFile(sessionPaths.stdoutPath, "", "utf8"),
      writeFile(sessionPaths.stderrPath, "", "utf8")
    ]);

    return (await this.getTerminalSession({
      workspacePath,
      sessionId: record.id
    })) as TerminalSessionState;
  }

  async getTerminalSession(request: TerminalSessionRequest): Promise<TerminalSessionState | null> {
    const workspacePath = this.resolveWorkspacePath(request.workspacePath);

    if (!workspacePath) {
      return null;
    }

    const session = await this.store.readTerminalSession(workspacePath, request.sessionId);

    if (!session) {
      return null;
    }

    const liveTerminal = getLiveTerminal(workspacePath, session.id);

    return {
      ...session,
      shell: session.shell || liveTerminal?.shell || "shell",
      cwd: liveTerminal?.cwd || session.cwd,
      pid: liveTerminal?.pid ?? session.pid,
      cols: liveTerminal?.cols ?? session.cols ?? 120,
      rows: liveTerminal?.rows ?? session.rows ?? 32,
      active: Boolean(liveTerminal),
      output: await this.readTerminalTranscript(session)
    };
  }

  async writeTerminalInput(request: TerminalSessionInputRequest): Promise<boolean> {
    if (!request.data) {
      return false;
    }

    const workspacePath = this.resolveWorkspacePath(request.workspacePath);

    if (!workspacePath) {
      return false;
    }

    return writeToLiveTerminal(workspacePath, request.sessionId, request.data);
  }

  async resizeTerminalSession(request: TerminalSessionResizeRequest): Promise<TerminalSessionState | null> {
    const workspacePath = this.resolveWorkspacePath(request.workspacePath);

    if (!workspacePath) {
      return null;
    }

    const session = await this.store.readTerminalSession(workspacePath, request.sessionId);

    if (!session) {
      return null;
    }

    const liveTerminal = resizeLiveTerminal(
      workspacePath,
      session.id,
      clampTerminalSize(request.cols, session.cols || 120, 40, 240),
      clampTerminalSize(request.rows, session.rows || 32, 12, 120)
    );

    if (!liveTerminal) {
      return await this.getTerminalSession({
        workspacePath,
        sessionId: session.id
      });
    }

    await this.store.writeTerminalSession(workspacePath, {
      ...session,
      pid: liveTerminal.pid,
      cwd: liveTerminal.cwd,
      cols: liveTerminal.cols,
      rows: liveTerminal.rows
    });

    return await this.getTerminalSession({
      workspacePath,
      sessionId: session.id
    });
  }

  async closeTerminalSession(request: TerminalSessionRequest): Promise<TerminalSessionState | null> {
    const workspacePath = this.resolveWorkspacePath(request.workspacePath);

    if (!workspacePath) {
      return null;
    }

    const session = await this.store.readTerminalSession(workspacePath, request.sessionId);

    if (!session) {
      return null;
    }

    if (!getLiveTerminal(workspacePath, session.id)) {
      return await this.getTerminalSession({
        workspacePath,
        sessionId: session.id
      });
    }

    stopLiveTerminal(workspacePath, session.id);
    const nextSession: TerminalSessionRecord = {
      ...session,
      status: "cancelled",
      pid: null,
      endedAt: new Date().toISOString()
    };
    await this.store.writeTerminalSession(workspacePath, nextSession);

    return {
      ...nextSession,
      shell: nextSession.shell || "shell",
      cols: nextSession.cols || 120,
      rows: nextSession.rows || 32,
      active: false,
      output: await this.readTerminalTranscript(nextSession)
    };
  }

  private async syncRemoteChangedFiles(workspacePath: string, changedFiles: string[]) {
    const syncedFiles = changedFiles.filter((relativePath) => !relativePath.startsWith(".lithium/"));

    if (!syncedFiles.length) {
      return;
    }

    const remoteWorkspace = await this.remoteWorkspaceService.describe(workspacePath);

    if (!remoteWorkspace) {
      return;
    }

    await this.remoteWorkspaceService.pushWorkspaceFiles(workspacePath, syncedFiles);
  }

  private async prepareReusableStrategistSession(strategistSessionReady?: boolean) {
    if (!strategistSessionReady) {
      return;
    }

    const launch = resolveOracleLaunchOptions(process.env, {
      strategistSessionReady
    });

    if (launch.manualLogin) {
      return;
    }

    await this.chatgptAuthRunner.prepareReusableSession?.();
  }

  private async resolveProjectName(workspacePath: string) {
    const remoteWorkspace = await this.remoteWorkspaceService.describe(workspacePath);
    return remoteWorkspace?.profile.name || basename(workspacePath);
  }

  private resolveWorkspacePath(workspacePath?: string) {
    const resolved = workspacePath?.trim() || this.selectedWorkspacePath.trim();

    if (resolved) {
      this.updateSelectedWorkspacePath(resolved);
    }

    return resolved;
  }

  private requireWorkspacePath(workspacePath?: string) {
    const resolved = this.resolveWorkspacePath(workspacePath);

    if (!resolved) {
      throw new Error("No workspace is selected.");
    }

    return resolved;
  }

  private async resolveResearchWorkspacePath(workspacePath?: string) {
    const resolved = this.resolveWorkspacePath(workspacePath);

    if (resolved) {
      return resolved;
    }

    const createdWorkspacePath = await this.createUntitledWorkspace();
    this.updateSelectedWorkspacePath(createdWorkspacePath);
    return createdWorkspacePath;
  }

  private updateSelectedWorkspacePath(workspacePath: string) {
    const normalizedWorkspacePath = workspacePath.trim();

    if (!normalizedWorkspacePath) {
      this.selectedWorkspacePath = "";
      return;
    }

    if (this.selectedWorkspacePath === normalizedWorkspacePath) {
      return;
    }

    this.selectedWorkspacePath = normalizedWorkspacePath;
    this.onSelectedWorkspacePathChange?.(normalizedWorkspacePath);
  }

  private async createUntitledWorkspace() {
    await mkdir(this.untitledWorkspaceRoot, { recursive: true });

    for (let index = 1; index <= 999; index += 1) {
      const candidate = path.join(this.untitledWorkspaceRoot, `Untitled-${index}`);

      try {
        await access(candidate);
        continue;
      } catch {
        await mkdir(candidate, { recursive: true });
        return candidate;
      }
    }

    throw new Error("Could not allocate an untitled workspace.");
  }

  private resolveSyncTeXPath(pdfPath: string) {
    return pdfPath.replace(/\.pdf$/i, ".synctex.gz");
  }

  private async readRunFinalMessage(outputPath: string, stdoutPath: string, stderrPath: string) {
    const outputText = (await readTextFile(outputPath)).trim();

    if (outputText) {
      return outputText;
    }

    const stdout = (await readTextFile(stdoutPath)).trim();
    const stderr = (await readTextFile(stderrPath)).trim();

    for (const candidate of [stdout, stderr]) {
      if (this.isUsableBuilderFallback(candidate)) {
        return candidate.trim();
      }
    }

    const structuredFailure = extractBuilderFailureSummary(stdout, stderr);

    if (structuredFailure) {
      return createSyntheticBuilderFinalMessage(
        `Builder run ended without writing a final answer. Latest issue: ${structuredFailure}`,
        "failed"
      );
    }

    return createSyntheticBuilderFinalMessage(
      "Builder run ended without writing a final answer.",
      "failed"
    );
  }

  private isUsableBuilderFallback(value: string) {
    const trimmed = value.trim();

    if (!trimmed || looksLikeCodexTranscript(trimmed) || isIgnorableBuilderWarning(trimmed)) {
      return false;
    }

    const handoff = parseBuilderOutput(trimmed);
    return !looksLikeBuilderPromptTemplate(handoff);
  }

  private async reconcileStaleAutomationSession(workspacePath: string) {
    const snapshot = await this.store.getSnapshot(workspacePath);
    const session = snapshot.latestAutomationSession;

    if (!session || session.status !== "running") {
      return;
    }

    const controller = this.automationControllers.get(`${workspacePath}::${session.id}`);

    if (controller?.running) {
      return;
    }

    const latestStep =
      snapshot.automationSteps?.find((step) => step.id === session.latestStepId) ??
      snapshot.automationSteps?.find((step) => step.sessionId === session.id) ??
      null;
    const latestRun =
      latestStep?.runId
        ? snapshot.runs.find((run) => run.id === latestStep.runId) ??
          (await this.store.readRun(workspacePath, latestStep.runId).catch(() => null))
        : null;

    const refreshedSnapshot = await this.store.getSnapshot(workspacePath);
    const refreshedSession = await this.store.readAutomationSession(workspacePath, session.id);

    if (!refreshedSession || refreshedSession.status !== "running") {
      return;
    }

    const refreshedStep =
      refreshedSnapshot.automationSteps?.find((step) => step.id === refreshedSession.latestStepId) ??
      refreshedSnapshot.automationSteps?.find((step) => step.sessionId === refreshedSession.id) ??
      null;
    const refreshedRun = refreshedStep?.runId
      ? refreshedSnapshot.runs.find((run) => run.id === refreshedStep.runId) ?? null
      : null;

    if (
      refreshedStep?.status === "running" &&
      refreshedStep.lane === "builder" &&
      refreshedStep.runId &&
      refreshedRun
    ) {
      await this.writeRunningAutomationSession(workspacePath, refreshedSession, {
        currentStepSummary: "Resuming the in-flight builder step after Lithium restarted."
      });
      void this.runAutomationLoop(workspacePath, refreshedSession.id);
      return;
    }

    const interruptedSummary = summarizeInterruptedAutomationSession(refreshedStep, refreshedRun);

    if (refreshedStep?.status === "running") {
      await this.failActiveAutomationStep(workspacePath, refreshedSession, interruptedSummary);
    }

    const checkpoint = await this.createAutomationCheckpoint(workspacePath, refreshedSession, {
      title: "Automation interrupted after app restart",
      summary: interruptedSummary,
      whatChanged: refreshedRun?.changedFiles ?? [],
      evidence: [refreshedStep?.id, refreshedRun?.id].filter(Boolean) as string[],
      risks: [interruptedSummary],
      nextActions: ["Resume automation to continue from the latest saved state."]
    });

    await this.store.writeAutomationSession(workspacePath, {
      ...refreshedSession,
      status: "idle",
      latestCheckpointId: checkpoint.id,
      currentStepSummary: "Automation was interrupted when Lithium restarted. Waiting for your direction.",
      stopReason: interruptedSummary,
      endedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  private async reconcileStaleBuilderRuns(workspacePath: string) {
    const snapshot = await this.store.getSnapshot(workspacePath);
    const staleRuns = snapshot.runs.filter(
      (run) =>
        (run.status === "running" || run.finalization === null) &&
        !getLiveProcess(workspacePath, run.id)
    );

    for (const run of staleRuns) {
      await this.reconcileStaleBuilderRun(workspacePath, run);
    }
  }

  private async reconcileStaleBuilderRun(workspacePath: string, run: RunRecord) {
    if (await this.isRecoverableDetachedBuilderRun(run)) {
      return;
    }

    const terminatedDetachedProcess = await this.terminateRecordedBuilderProcess(run);
    const recoveredOutput = (await readTextFile(run.finalMessagePath)).trim();
    const finalMessage = recoveredOutput
      ? recoveredOutput
      : terminatedDetachedProcess
      ? createSyntheticBuilderFinalMessage(
          "Lithium terminated a detached builder process after an app restart left it running without an active session.",
          "partial"
        )
      : await this.readRunFinalMessage(run.finalMessagePath, run.stdoutPath, run.stderrPath);

    await this.finalizeBuilderRun(
      { workspacePath, runId: run.id },
      {
        exitCode: run.exitCode,
        finalMessage,
        finalization: "auto",
        endedAt: new Date().toISOString(),
        timedOut: false,
        forcedStatus: terminatedDetachedProcess ? "cancelled" : undefined
      }
    );
  }

  private async terminateRecordedBuilderProcess(run: RunRecord) {
    if (!Number.isFinite(run.pid) || (run.pid ?? 0) <= 0) {
      return false;
    }

    const termination = await terminateProcessTree(run.pid as number, {
      expectedCommandIncludes: [run.finalMessagePath, run.stdoutPath],
      graceMs: 750
    }).catch(() => null);

    return Boolean(termination?.matched && termination.terminated);
  }

  private async stopTrackedBuilderRunProcess(workspacePath: string, run: RunRecord) {
    if (stopLiveProcess(workspacePath, run.id)) {
      return true;
    }

    return await this.terminateRecordedBuilderProcess(run);
  }

  private async isRecoverableDetachedBuilderRun(run: RunRecord) {
    if (
      run.finalization !== null &&
      run.status !== "running"
    ) {
      return false;
    }

    const pid = Number.isFinite(run.pid) && (run.pid ?? 0) > 0 ? (run.pid as number) : null;

    if (!pid || !(await isProcessAlive(pid))) {
      return false;
    }

    const commandLine = await readProcessCommand(pid);

    return this.recordedBuilderProcessMatchesRun(run, commandLine);
  }

  private recordedBuilderProcessMatchesRun(run: RunRecord, commandLine: string) {
    const normalizedCommandLine = commandLine.trim();

    if (!normalizedCommandLine) {
      return false;
    }

    const expectedSnippets = [
      run.finalMessagePath,
      run.stdoutPath
    ]
      .map((entry) => entry.trim())
      .filter(Boolean);

    return expectedSnippets.some((snippet) => normalizedCommandLine.includes(snippet));
  }

  private async prepareModelContext(input: {
    workspacePath: string;
    prompt: string;
    lane: ContextPackLane;
    snapshot: ProjectSnapshot;
    artifactId?: string;
  }) {
    const runtimeContext = await this.store.buildRuntimeContext(input.workspacePath, input.prompt, {
      lane: input.lane,
      artifactId: input.artifactId
    });

    if (!input.artifactId || !this.shouldAttachArtifactContext(input.snapshot, input.lane, input.prompt)) {
      return {
        runtimeContext: runtimeContext.content,
        runtimeContextPath: runtimeContext.path,
        contextPackPath: undefined,
        artifactContext: undefined
      };
    }

    const [contextPackPath] = await this.store.buildContextBundle(input.workspacePath, input.prompt, {
      lane: input.lane,
      artifactId: input.artifactId
    });

    return {
      runtimeContext: runtimeContext.content,
      runtimeContextPath: runtimeContext.path,
      contextPackPath,
      artifactContext:
        input.lane === "builder" ? await readTextFile(contextPackPath) : undefined
    };
  }

  private shouldAttachArtifactContext(
    snapshot: ProjectSnapshot,
    lane: ContextPackLane,
    prompt: string
  ) {
    const normalized = prompt.trim().toLowerCase();
    const hasAttachments = snapshot.activeThreadAttachments.length > 0;
    const mentionsPaper = /\b(paper|manuscript|latex|tex|pdf)\b|논문|원고/.test(normalized);

    if (lane === "builder") {
      return hasAttachments || mentionsPaper || Boolean(snapshot.latestDecision || snapshot.latestAutomationSession);
    }

    if (lane === "paper") {
      return true;
    }

    return false;
  }

  private buildDecisionRecord(input: {
    id: string;
    threadId: string;
    prompt: string;
    displayPrompt?: string;
    inputFiles?: string[];
    model: string;
    rawOutput: string;
    command: DecisionRecord["command"];
    stdoutPath: string;
    stderrPath: string;
    outputPath: string;
    contextPackPath?: string;
    startedAt: string;
    exitCode: number | null;
  }): DecisionRecord {
    const structured = parseOracleOutput(input.rawOutput);
    const status: RecordStatus = input.exitCode === 0 ? "completed" : "failed";

    return {
      id: input.id,
      threadId: input.threadId,
      prompt: input.prompt,
      displayPrompt: input.displayPrompt,
      inputFiles: input.inputFiles,
      rawOutput: input.rawOutput,
      summary: structured.summary,
      nextTask: undefined,
      rationale: structured.rationale ?? "Oracle did not return a structured rationale.",
      handoff: stripLegacyNextTask(structured),
      model: input.model,
      engine: "browser",
      status,
      command: input.command,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      outputPath: input.outputPath,
      contextPackPath: input.contextPackPath,
      createdAt: input.startedAt
    };
  }

  private async syncThreadFromArtifacts(
    workspacePath: string,
    thread: ThreadRecord,
    input: {
      prompt?: string;
      summary?: string;
      strategistContextFingerprint?: string;
      strategistContextAttachedAt?: string;
    }
  ) {
    const nextTitle = shouldRetitleThread(thread.title) && input.prompt
      ? deriveThreadTitle(input.prompt)
      : undefined;

    await this.store.updateThread(workspacePath, thread.id, {
      title: nextTitle,
      summary: input.summary ?? thread.summary,
      strategistContextFingerprint:
        input.strategistContextFingerprint ?? thread.strategistContextFingerprint,
      strategistLastContextAttachedAt:
        input.strategistContextAttachedAt ?? thread.strategistLastContextAttachedAt
    });
  }

  private async stopLiveProcessesForThread(workspacePath: string, threadId: string) {
    const [runs, terminalSessions] = await Promise.all([
      this.store.listRuns(workspacePath),
      this.store.listTerminalSessions(workspacePath)
    ]);

    for (const run of runs.filter((record) => record.threadId === threadId)) {
      if (getLiveProcess(workspacePath, run.id)) {
        stopLiveProcess(workspacePath, run.id);
      }
    }

    for (const session of terminalSessions.filter((record) => record.threadId === threadId)) {
      if (getLiveTerminal(workspacePath, session.id)) {
        stopLiveTerminal(workspacePath, session.id);
      }
    }
  }

  private async stopLiveTerminalSessionsForThread(workspacePath: string, threadId: string) {
    const terminalSessions = await this.store.listTerminalSessions(workspacePath);

    for (const session of terminalSessions.filter((record) => record.threadId === threadId)) {
      if (getLiveTerminal(workspacePath, session.id)) {
        stopLiveTerminal(workspacePath, session.id);
        await this.store.writeTerminalSession(workspacePath, {
          ...session,
          status: "cancelled",
          pid: null,
          endedAt: new Date().toISOString()
        });
      }
    }
  }

  private async findActiveTerminalSession(workspacePath: string, threadId: string) {
    const terminalSessions = await this.store.listTerminalSessions(workspacePath);

    return (
      terminalSessions.find(
        (record) => record.threadId === threadId && Boolean(getLiveTerminal(workspacePath, record.id))
      ) ?? null
    );
  }

  private async handleLiveTerminalEvent(event: TerminalEvent) {
    const session = await this.store.readTerminalSession(event.workspacePath, event.sessionId);

    if (!session) {
      return;
    }

    if (event.type === "cwd") {
      if (event.cwd === session.cwd) {
        return;
      }

      await this.store.writeTerminalSession(event.workspacePath, {
        ...session,
        cwd: event.cwd
      });
      return;
    }

    if (event.type === "exit") {
      await this.store.writeTerminalSession(event.workspacePath, {
        ...session,
        status: event.status,
        exitCode: event.exitCode,
        pid: null,
        endedAt: event.endedAt
      });
    }
  }

  private async readTerminalTranscript(session: TerminalSessionRecord) {
    if (session.transcriptPath) {
      const output = await readTailText(session.transcriptPath);

      if (output) {
        return output.trimEnd();
      }
    }

    const [stdout, stderr] = await Promise.all([
      session.stdoutPath ? readTailText(session.stdoutPath) : Promise.resolve(""),
      session.stderrPath ? readTailText(session.stderrPath) : Promise.resolve("")
    ]);

    return [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n").trimEnd();
  }

  private async requireAutomationSession(workspacePath: string, sessionId: string) {
    const session = await this.store.readAutomationSession(workspacePath, sessionId);

    if (!session) {
      throw new Error(`Automation session not found: ${sessionId}`);
    }

    return session;
  }

  private buildRunningAutomationSession(
    session: AutomationSessionRecord,
    patch: Partial<AutomationSessionRecord> = {}
  ): AutomationSessionRecord {
    return {
      ...session,
      ...patch,
      status: "running",
      stopReason: undefined,
      endedAt: undefined,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
  }

  private async writeRunningAutomationSession(
    workspacePath: string,
    session: AutomationSessionRecord,
    patch: Partial<AutomationSessionRecord> = {}
  ) {
    const nextSession = this.buildRunningAutomationSession(session, patch);
    await this.store.writeAutomationSession(workspacePath, nextSession);
    return nextSession;
  }

  private getAutomationController(workspacePath: string, sessionId: string) {
    const key = `${workspacePath}::${sessionId}`;
    const existing = this.automationControllers.get(key);

    if (existing) {
      return existing;
    }

    const created: AutomationControllerState = {
      running: false,
      pauseRequested: false,
      stopRequested: false,
      redirectInstruction: "",
      activeRunId: null,
      activeStrategistSlug: null
    };
    this.automationControllers.set(key, created);
    return created;
  }

  private async resumeInFlightAutomationBuilderStep(
    workspacePath: string,
    session: AutomationSessionRecord,
    controller: AutomationControllerState
  ) {
    const stepId = session.latestStepId;

    if (!stepId) {
      return {
        handled: false,
        shouldStopLoop: false
      };
    }

    const steps = await this.store.listAutomationSteps(workspacePath);
    const builderStep = steps.find((record) => record.id === stepId);

    if (!builderStep || builderStep.status !== "running" || builderStep.lane !== "builder" || !builderStep.runId) {
      return {
        handled: false,
        shouldStopLoop: false
      };
    }

    const run = await this.store.readRun(workspacePath, builderStep.runId).catch(() => null);

    if (!run) {
      return {
        handled: false,
        shouldStopLoop: false
      };
    }

    if (!/resuming the in-flight builder step/i.test(session.currentStepSummary)) {
      await this.writeRunningAutomationSession(workspacePath, session, {
        currentStepSummary: "Resuming the in-flight builder step after Lithium restarted."
      });
    }

    let latestRun: RunRecord | null = null;
    let runStatus: RecordStatus = "failed";
    let runSummary = "";
    let runChangedFiles: string[] = [];
    let runEvidence: string[] = [];
    let runRisks: string[] = [];
    let runActions: string[] = [];

    try {
      const inspection = await this.inspectBuilderRun({
        workspacePath,
        runId: run.id
      });
      controller.activeRunId = run.id;
      const completedSnapshot =
        inspection?.run && inspection.run.finalization !== null && inspection.run.status !== "running"
          ? await this.store.getSnapshot(workspacePath)
          : await this.waitForAutomationRun(workspacePath, run.id, controller);
      controller.activeRunId = null;
      latestRun =
        completedSnapshot.runs.find((record) => record.id === run.id) ??
        (completedSnapshot.latestRun?.id === run.id ? completedSnapshot.latestRun : null);
      runStatus = latestRun?.status ?? "failed";
      runSummary = handoffMachineSummary(latestRun?.handoff) || extractRunSummary(latestRun?.finalMessage ?? "");
      runChangedFiles = latestRun?.changedFiles ?? [];
      runEvidence = buildAutomationEvidence(latestRun);
      runRisks = latestRun?.handoff?.risks ?? [];
      runActions = latestRun?.handoff?.runActions ?? [];
    } catch (error) {
      controller.activeRunId = null;
      runStatus = "failed";
      runSummary = error instanceof Error ? error.message : String(error);
      runEvidence = runSummary ? [runSummary] : [];
      runRisks = runSummary ? [runSummary] : [];
    }

    const snapshot = await this.store.getSnapshot(workspacePath);
    const activeSession = await this.requireAutomationSession(workspacePath, session.id);
    const shouldStopLoop = await this.applyAutomationBuilderOutcome(workspacePath, {
      session: activeSession,
      controller,
      builderStep,
      latestDecision: snapshot.latestDecision,
      latestRun,
      redirectInstruction: "",
      runStatus,
      runSummary,
      runChangedFiles,
      runEvidence,
      runRisks,
      runActions
    });

    return {
      handled: true,
      shouldStopLoop
    };
  }

  private async applyAutomationBuilderOutcome(
    workspacePath: string,
    input: {
      session: AutomationSessionRecord;
      controller: AutomationControllerState;
      builderStep: AutomationStepRecord;
      latestDecision: DecisionRecord | null;
      latestRun: RunRecord | null;
      redirectInstruction: string;
      runStatus: RecordStatus;
      runSummary: string;
      runChangedFiles: string[];
      runEvidence: string[];
      runRisks: string[];
      runActions: string[];
    }
  ) {
    const {
      session,
      controller,
      builderStep,
      latestDecision,
      latestRun,
      redirectInstruction,
      runStatus,
      runSummary,
      runChangedFiles,
      runEvidence,
      runRisks,
      runActions
    } = input;

    if (controller.stopRequested) {
      await this.completeAutomationStep(workspacePath, builderStep, {
        status: "cancelled",
        summary: "Stopped by the user.",
        runId: latestRun?.id,
        changedFiles: [],
        evidence: []
      });
      return true;
    }

    await this.completeAutomationStep(workspacePath, builderStep, {
      status:
        runStatus === "completed"
          ? "completed"
          : runStatus === "cancelled"
          ? "cancelled"
          : "failed",
      summary: runSummary || "Builder run finished without a usable summary.",
      runId: latestRun?.id,
      changedFiles: runChangedFiles,
      evidence: runEvidence
    });

    if (session.paperWriteEnabled && runStatus === "completed") {
      const paperStep = await this.createAutomationStep(workspacePath, session, {
        kind: "paper-sync",
        lane: "writer",
        title: "Sync manuscript state",
        prompt: "Update manuscript projections from the latest decision and run."
      });
      const manuscriptSnapshot = await this.updateManuscript(workspacePath);
      let paperSummary = manuscriptSnapshot.manuscript
        ? "Updated the internal manuscript projection from the latest artifacts."
        : "No manuscript projection was available to update.";

      if ((latestRun?.changedFiles ?? []).some(isPaperRelatedPath)) {
        try {
          await this.compilePaper(workspacePath);
          paperSummary = `${paperSummary} Recompiled the paper.`;
        } catch (error) {
          paperSummary = `${paperSummary} Paper compile failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      await this.completeAutomationStep(workspacePath, paperStep, {
        status: "completed",
        summary: paperSummary,
        changedFiles: manuscriptSnapshot.manuscript ? [manuscriptSnapshot.manuscript.path] : [],
        evidence: latestRun?.id ? [latestRun.id] : []
      });
    }

    const nextUsedSteps = session.budget.usedSteps + 1;
    const runFailed = runStatus === "failed" || runStatus === "cancelled";
    const nextUsedRetries = runFailed ? session.budget.usedRetries + 1 : session.budget.usedRetries;
    const retryBudgetExhausted = runFailed && nextUsedRetries >= session.budget.maxRetries;
    const requiresUserCheckpoint = shouldRequireAutomationCheckpoint({
      decision: latestDecision,
      run: latestRun
    });
    const needsCheckpoint =
      controller.pauseRequested ||
      session.mode === "checkpoint" ||
      (runFailed && (retryBudgetExhausted || requiresUserCheckpoint));

    if (runFailed && !needsCheckpoint) {
      await this.createAutomationCheckpoint(workspacePath, session, {
        title: "Automation update",
        summary: summarizeAutomationFailureRecovery({
          runStatus,
          runSummary,
          usedRetries: nextUsedRetries,
          maxRetries: session.budget.maxRetries,
          language: resolveAutomationUiLanguage([
            redirectInstruction,
            session.displayObjective ?? "",
            session.objective,
            runSummary
          ])
        }),
        whatChanged: runChangedFiles,
        evidence: runEvidence,
        risks: [
          ...(latestDecision?.handoff?.risks ?? []),
          ...runRisks
        ],
        nextActions:
          runActions.length > 0
            ? runActions
            : [
                "Diagnose the failure, gather any missing context, and attempt the next bounded fix."
              ],
        status: "approved",
        approvedAt: new Date().toISOString(),
        activityMessage: `${session.id} automation retry queued after failed run`
      });
    }

    if (needsCheckpoint) {
      const checkpoint = await this.createAutomationCheckpoint(workspacePath, session, {
        title:
          runFailed
            ? "Automation needs review after a failed run"
            : controller.pauseRequested
            ? "Automation paused after the latest step"
            : "Checkpoint ready",
        summary:
          runSummary || latestDecision?.summary || "The latest automation cycle finished.",
        whatChanged: runChangedFiles,
        evidence: runEvidence,
        risks: [
          ...(latestDecision?.handoff?.risks ?? []),
          ...runRisks
        ],
        nextActions:
          runActions.length || latestDecision?.handoff?.runActions.length
            ? [
                ...latestDecision?.handoff?.runActions ?? [],
                ...runActions
              ]
            : latestDecision?.handoff?.openQuestions?.length
            ? latestDecision.handoff.openQuestions
            : [latestDecision?.summary || "Review the latest research note and decide the next move."]
      });

      await this.store.writeAutomationSession(workspacePath, {
        ...session,
        status: "idle",
        latestCheckpointId: checkpoint.id,
        currentStepSummary:
          controller.pauseRequested
            ? "Stopped after finishing the current step."
            : "Waiting for your direction.",
        budget: {
          ...session.budget,
          usedSteps: nextUsedSteps,
          usedRetries: nextUsedRetries
        },
        updatedAt: new Date().toISOString()
      });
      controller.pauseRequested = false;
      controller.stopRequested = false;
      return true;
    }

    await this.writeRunningAutomationSession(workspacePath, session, {
      currentStepSummary: runFailed
        ? `Recovering after ${latestRun?.id ?? "the latest failed cycle"}.`
        : `Continuing after ${latestRun?.id ?? "the latest cycle"}.`,
      budget: {
        ...session.budget,
        usedSteps: nextUsedSteps,
        usedRetries: nextUsedRetries
      }
    });
    await this.store.updateSessionSummary(workspacePath);
    return false;
  }

  private async runAutomationLoop(workspacePath: string, sessionId: string) {
    const controller = this.getAutomationController(workspacePath, sessionId);

    if (controller.running) {
      return;
    }

    controller.running = true;

    try {
      while (true) {
        let session = await this.store.readAutomationSession(workspacePath, sessionId);

        if (!session || session.status !== "running") {
          return;
        }

        if (controller.stopRequested) {
          if (controller.activeStrategistSlug) {
            await this.oracleRunner
              .terminateSession?.(controller.activeStrategistSlug)
              .catch(() => undefined);
            controller.activeStrategistSlug = null;
          }
          await this.store.writeAutomationSession(workspacePath, {
            ...session,
            status: "idle",
            latestCheckpointId: undefined,
            currentStepSummary: "Automation stopped by the user.",
            stopReason: "Interrupted by the user.",
            endedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          return;
        }

        const resumedBuilderStep = await this.resumeInFlightAutomationBuilderStep(
          workspacePath,
          session,
          controller
        );

        if (resumedBuilderStep.handled) {
          if (resumedBuilderStep.shouldStopLoop) {
            return;
          }

          continue;
        }

        if (
          session.startedAt &&
          Date.now() - new Date(session.startedAt).getTime() >
            session.budget.maxRuntimeMinutes * 60 * 1000
        ) {
          const checkpoint = await this.createAutomationCheckpoint(workspacePath, session, {
            title: "Automation time budget reached",
            summary: "Automation paused because it hit the configured runtime limit.",
            whatChanged: [],
            evidence: [],
            risks: ["Runtime budget exhausted."],
            nextActions: ["Review progress and resume with a fresh budget if needed."]
          });

          await this.store.writeAutomationSession(workspacePath, {
            ...session,
            status: "idle",
            latestCheckpointId: checkpoint.id,
            currentStepSummary: "Runtime budget reached. Waiting for your direction.",
            stopReason: "Runtime budget reached.",
            updatedAt: new Date().toISOString()
          });
          return;
        }

        if (session.budget.usedSteps >= session.budget.maxSteps) {
          const checkpoint = await this.createAutomationCheckpoint(workspacePath, session, {
            title: "Automation step budget reached",
            summary: "Automation paused because it used the configured step budget.",
            whatChanged: [],
            evidence: [],
            risks: ["Step budget exhausted."],
            nextActions: ["Review progress and resume if you want a longer run."]
          });

          await this.store.writeAutomationSession(workspacePath, {
            ...session,
            status: "idle",
            latestCheckpointId: checkpoint.id,
            currentStepSummary: "Step budget reached. Waiting for your direction.",
            stopReason: "Step budget reached.",
            updatedAt: new Date().toISOString()
          });
          return;
        }

        const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
        const redirectInstruction =
          controller.redirectInstruction.trim() || session.queuedUserInstruction?.trim() || "";
        const snapshot = await this.store.getSnapshot(workspacePath);
        const shouldConsultStrategist =
          session.budget.usedSteps === 0 ||
          shouldReplanFromRedirectInstruction(redirectInstruction) ||
          !snapshot.latestDecision ||
          shouldReplanAfterFailedRun(snapshot.latestRun, snapshot.latestAutomationCheckpoint);
        let latestDecision = snapshot.latestDecision;

        if (shouldConsultStrategist) {
          const strategizePrompt = buildAutomationStrategistPrompt(
            session,
            redirectInstruction,
            appSettings.autopilotPromptLanguage,
            snapshot.latestRun,
            snapshot.latestAutomationCheckpoint
          );
          const strategistSessionSlug = buildStrategistOracleSessionId(
            workspacePath,
            session.threadId
          );
          const strategistDisplayPrompt =
            session.budget.usedSteps === 0
              ? session.displayObjective ?? session.objective
              : redirectInstruction
              ? `[Autopilot] ${redirectInstruction}`
              : `[Autopilot] ${session.displayObjective ?? session.objective}`;
          const strategizeStep = await this.createAutomationStep(workspacePath, session, {
            kind: "strategize",
            lane: "strategist",
            title: "Plan the next bounded research step",
            prompt: strategizePrompt
          });
          controller.activeStrategistSlug = strategistSessionSlug;
          let strategistSnapshot: ProjectSnapshot;

          try {
            strategistSnapshot = await this.consultStrategist(
              {
                workspacePath,
                threadId: session.threadId,
                prompt: strategizePrompt,
                displayPrompt: strategistDisplayPrompt,
                attachExplicitWorkspaceFiles: false
              },
              {
                strategistSessionReady: appSettings.strategistSessionReady
              }
            );
          } finally {
            controller.activeStrategistSlug = null;
          }
          latestDecision = strategistSnapshot.latestDecision;

          await this.completeAutomationStep(workspacePath, strategizeStep, {
            status: "completed",
            summary:
              latestDecision?.summary || "The strategist did not return a concrete summary.",
            decisionId: latestDecision?.id,
            changedFiles: [],
            evidence: latestDecision?.summary ? [latestDecision.summary] : []
          });

          session = await this.requireAutomationSession(workspacePath, sessionId);
        }

        if (controller.redirectInstruction.trim() === redirectInstruction) {
          controller.redirectInstruction = "";
        }

        if (redirectInstruction && session.queuedUserInstruction?.trim() === redirectInstruction) {
          session = {
            ...session,
            queuedUserInstruction: undefined
          };
          session = await this.writeRunningAutomationSession(workspacePath, session, {
            queuedUserInstruction: undefined
          });
        }

        const nextPaperWriteEnabled =
          session.paperWriteEnabled || shouldBeginPaperPhase(session, latestDecision);

        if (nextPaperWriteEnabled !== session.paperWriteEnabled) {
          session = {
            ...session,
            paperWriteEnabled: nextPaperWriteEnabled
          };
          session = await this.writeRunningAutomationSession(workspacePath, session, {
            currentStepSummary: nextPaperWriteEnabled
              ? "Paper phase activated after the latest strategist decision."
              : session.currentStepSummary
          });
        }

        const builderDisplayPrompt = redirectInstruction || session.objective;
        const builderPrompt = buildContextDrivenBuilderPrompt(
          builderDisplayPrompt,
          latestDecision,
          appSettings.autopilotPromptLanguage
        );
        const builderStep = await this.createAutomationStep(workspacePath, session, {
          kind: inferAutomationBuilderStepKind(builderPrompt),
          lane: "builder",
          title: "Let Codex choose and execute the next bounded step",
          prompt: builderPrompt
        });
        let latestRun: RunRecord | null = null;
        let runStatus: RecordStatus = "failed";
        let runSummary = "";
        let runChangedFiles: string[] = [];
        let runEvidence: string[] = [];
        let runRisks: string[] = [];
        let runActions: string[] = [];

        try {
          const builderSnapshot = await this.startBuilderTask({
            workspacePath,
            threadId: session.threadId,
            prompt: builderPrompt,
            displayPrompt: `[autopilot] ${builderDisplayPrompt}`
          });
          const runId = builderSnapshot.latestRun?.id ?? null;
          controller.activeRunId = runId;
          const completedSnapshot = runId
            ? await this.waitForAutomationRun(workspacePath, runId, controller)
            : await this.store.getSnapshot(workspacePath);
          controller.activeRunId = null;
          latestRun = completedSnapshot.latestRun;
          runStatus = latestRun?.status ?? "failed";
          runSummary = handoffMachineSummary(latestRun?.handoff) || extractRunSummary(latestRun?.finalMessage ?? "");
          runChangedFiles = latestRun?.changedFiles ?? [];
          runEvidence = buildAutomationEvidence(latestRun);
          runRisks = latestRun?.handoff?.risks ?? [];
          runActions = latestRun?.handoff?.runActions ?? [];
        } catch (error) {
          controller.activeRunId = null;
          runStatus = "failed";
          runSummary = error instanceof Error ? error.message : String(error);
          runChangedFiles = [];
          runEvidence = runSummary ? [runSummary] : [];
          runRisks = runSummary ? [runSummary] : [];
          runActions = [];
        }

        const shouldStopLoop = await this.applyAutomationBuilderOutcome(workspacePath, {
          session,
          controller,
          builderStep,
          latestDecision,
          latestRun,
          redirectInstruction,
          runStatus,
          runSummary,
          runChangedFiles,
          runEvidence,
          runRisks,
          runActions
        });

        if (shouldStopLoop) {
          return;
        }
      }
    } catch (error) {
      const session = await this.store.readAutomationSession(workspacePath, sessionId).catch(() => null);
      const failureMessage = error instanceof Error ? error.message : String(error);
      const failureDetails = describeAutomationControllerFailure(failureMessage);

      if (session) {
        await this.failActiveAutomationStep(workspacePath, session, failureMessage);
        const checkpoint = await this.createAutomationCheckpoint(workspacePath, session, {
          title: failureDetails.title,
          summary: failureDetails.summary,
          whatChanged: [],
          evidence: [],
          risks: [failureMessage],
          nextActions: failureDetails.nextActions
        });

        await this.store.writeAutomationSession(workspacePath, {
          ...session,
          status: "idle",
          latestCheckpointId: checkpoint.id,
          currentStepSummary: failureDetails.currentStepSummary,
          stopReason: failureMessage,
          endedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    } finally {
      controller.running = false;
      controller.activeRunId = null;
      controller.activeStrategistSlug = null;
    }
  }

  private async waitForAutomationRun(
    workspacePath: string,
    runId: string,
    controller: AutomationControllerState
  ) {
    while (true) {
      if (controller.stopRequested && controller.activeRunId) {
        await this.terminateBuilderRun({
          workspacePath,
          runId: controller.activeRunId
        });
      }

      const inspection = await this.inspectBuilderRun({
        workspacePath,
        runId
      });

      if (!inspection) {
        return await this.store.getSnapshot(workspacePath);
      }

      if (inspection.suggestedStatus === "awaiting-finalization" && inspection.run) {
        this.terminatingRunIds.add(runId);

        try {
          if (inspection.active) {
            await this.stopTrackedBuilderRunProcess(workspacePath, inspection.run);
          }

          return await this.finalizeBuilderRun(
            { workspacePath, runId },
            {
              exitCode: inspection.run.exitCode,
              finalMessage:
                inspection.outputText.trim() ||
                (await this.readRunFinalMessage(
                  inspection.run.finalMessagePath,
                  inspection.run.stdoutPath,
                  inspection.run.stderrPath
                )),
              finalization: "auto",
              endedAt: new Date().toISOString(),
              timedOut: false
            }
          );
        } finally {
          this.terminatingRunIds.delete(runId);
        }
      }

      if (inspection.suggestedStatus === "hung" && inspection.run) {
        this.terminatingRunIds.add(runId);

        try {
          if (inspection.active) {
            await this.stopTrackedBuilderRunProcess(workspacePath, inspection.run);
          }

          return await this.finalizeBuilderRun(
            { workspacePath, runId },
            {
              exitCode: inspection.run.exitCode,
              finalMessage: createSyntheticBuilderFinalMessage(
                "Builder run stalled without producing a final answer.",
                "failed"
              ),
              finalization: "auto",
              endedAt: new Date().toISOString(),
              timedOut: false,
              forcedStatus: "failed"
            }
          );
        } finally {
          this.terminatingRunIds.delete(runId);
        }
      }

      if (!inspection.active && inspection.run?.status !== "running") {
        return await this.store.getSnapshot(workspacePath);
      }

      await sleep(900);
    }
  }

  private async createAutomationStep(
    workspacePath: string,
    session: AutomationSessionRecord,
    input: {
      kind: AutomationStepKind;
      lane: AutomationStepRecord["lane"];
      title: string;
      prompt: string;
    }
  ) {
    const allocation = await this.store.allocateAutomationStep(workspacePath);
    const now = new Date().toISOString();
    const step: AutomationStepRecord = {
      id: allocation.id,
      sessionId: session.id,
      threadId: session.threadId,
      kind: input.kind,
      lane: input.lane,
      title: input.title,
      prompt: input.prompt,
      status: "running",
      summary: "Step started.",
      changedFiles: [],
      evidence: [],
      checkpointRequired: false,
      createdAt: now,
      updatedAt: now
    };

    await this.store.writeAutomationStep(workspacePath, step);
    await this.writeRunningAutomationSession(workspacePath, session, {
      latestStepId: step.id,
      currentStepSummary: input.title,
      updatedAt: now
    });

    return step;
  }

  private async completeAutomationStep(
    workspacePath: string,
    step: AutomationStepRecord,
    input: {
      status: RecordStatus;
      summary: string;
      decisionId?: string;
      runId?: string;
      changedFiles: string[];
      evidence: string[];
    }
  ) {
    await this.store.writeAutomationStep(workspacePath, {
      ...step,
      status: input.status,
      summary: input.summary,
      decisionId: input.decisionId,
      runId: input.runId,
      changedFiles: input.changedFiles,
      evidence: input.evidence,
      checkpointRequired: input.status !== "completed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    });
  }

  private async createAutomationCheckpoint(
    workspacePath: string,
    session: AutomationSessionRecord,
    input: {
      title: string;
      summary: string;
      whatChanged: string[];
      evidence: string[];
      risks: string[];
      nextActions: string[];
      status?: AutomationCheckpointRecord["status"];
      userResponse?: string;
      approvedAt?: string;
      activityMessage?: string;
    }
  ) {
    const allocation = await this.store.allocateAutomationCheckpoint(workspacePath);
    const now = new Date().toISOString();
    const checkpoint: AutomationCheckpointRecord = {
      id: allocation.id,
      sessionId: session.id,
      threadId: session.threadId,
      status: input.status ?? "pending",
      title: input.title,
      summary: input.summary,
      whatChanged: input.whatChanged,
      evidence: input.evidence,
      risks: input.risks,
      nextActions: input.nextActions,
      userResponse: input.userResponse,
      createdAt: now,
      updatedAt: now,
      approvedAt: input.approvedAt
    };

    await this.store.writeAutomationCheckpoint(workspacePath, checkpoint);
    await this.store.appendActivity(
      workspacePath,
      input.activityMessage ?? `${checkpoint.id} automation checkpoint created`
    );
    return checkpoint;
  }

  private async failActiveAutomationStep(
    workspacePath: string,
    session: AutomationSessionRecord,
    failureSummary: string
  ) {
    const stepId = session.latestStepId;

    if (!stepId) {
      return;
    }

    const steps = await this.store.listAutomationSteps(workspacePath);
    const step = steps.find((record) => record.id === stepId);

    if (!step || step.status !== "running") {
      return;
    }

    await this.completeAutomationStep(workspacePath, step, {
      status: "failed",
      summary: failureSummary || "The automation step failed.",
      changedFiles: [],
      evidence: failureSummary ? [failureSummary] : []
    });
  }

  private setChatProgress(
    workspacePath: string,
    input: Omit<ActiveChatProgress, "updatedAt">
  ) {
    this.activeChatProgressByWorkspace.set(workspacePath, {
      ...input,
      updatedAt: new Date().toISOString()
    });
  }

  private clearChatProgress(workspacePath: string) {
    this.activeChatProgressByWorkspace.delete(workspacePath);
  }
}

function deriveThreadTitle(prompt: string) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "New thread";
  }

  return compact.length > 34 ? `${compact.slice(0, 34).trimEnd()}…` : compact;
}

function shouldRetitleThread(title: string) {
  return /^main thread$/i.test(title) || /^new thread \d+$/i.test(title) || /^new thread$/i.test(title);
}

function looksLikeAutomationResumeInstruction(instruction: string) {
  const normalized = instruction.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return /^(?:continue|resume|go ahead|keep going|carry on|retry|proceed|이어|이어서|계속|재개|다시 시작|승인|계속 진행)/i.test(
    normalized
  );
}

function looksLikeAutomationStopInstruction(instruction: string) {
  const normalized = instruction.trim().toLowerCase().replace(/\s+/g, " ");

  if (!normalized) {
    return false;
  }

  return (
    /^(?:stop|pause|halt|hold|cancel|멈춰|중단|중지|정지|일단 멈춰|그만)(?:\b|$)/i.test(normalized) ||
    /^(?:autopilot|automation|auto(?:\s|-)?research|연구|자동\s*연구|자동연구)(?:를|을|은|는|만)?\s*(?:stop|pause|halt|cancel|멈춰|멈춰줘|중단|중단해|중단해줘|중지|중지해|정지|정지해|그만|꺼|꺼줘)(?:\b|$)/i.test(
      normalized
    ) ||
    /^(?:stop|pause|halt|cancel|멈춰|중단|중지|정지|그만|꺼|꺼줘)\s*(?:the\s+)?(?:autopilot|automation|auto(?:\s|-)?research|연구|자동\s*연구|자동연구)(?:\b|$)/i.test(
      normalized
    )
  );
}

function looksLikeAutomationQuestion(instruction: string) {
  const normalized = instruction.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  if (/[?？]$/.test(normalized) || normalized.includes("?")) {
    return true;
  }

  return /(?:progress|status|update|report|summary|what|why|how|which|where|when|did|does|is it|are we|so far|진행사항|현황|상태|보고|업데이트|요약|왜|어떻게|뭐야|뭐임|뭔가|맞아|맞음|좋아졌|기준삼아|기준으로|된 거|된거|어느 쪽|무슨 근거|무슨 기준|설명해|정리해|비교해)/i.test(
    normalized
  );
}

function classifyAutomationChatIntent(instruction: string): "resume" | "redirect" | "question" | "stop" {
  if (looksLikeAutomationStopInstruction(instruction)) {
    return "stop";
  }

  if (looksLikeAutomationQuestion(instruction)) {
    return "question";
  }

  if (looksLikeAutomationResumeInstruction(instruction)) {
    return "resume";
  }

  return "redirect";
}

function resolveActivePendingAutomationCheckpoint(
  snapshot: ProjectSnapshot,
  session: AutomationSessionRecord
) {
  const checkpoints = snapshot.automationCheckpoints ?? [];
  const byLatestId = checkpoints.find(
    (checkpoint) =>
      checkpoint.sessionId === session.id &&
      checkpoint.status === "pending" &&
      checkpoint.id === session.latestCheckpointId
  );

  if (byLatestId) {
    return byLatestId;
  }

  return (
    checkpoints.find(
      (checkpoint) => checkpoint.sessionId === session.id && checkpoint.status === "pending"
    ) ?? null
  );
}

function summarizeAutomationInterrupt(input: {
  instruction: string;
  session: AutomationSessionRecord;
  snapshot: ProjectSnapshot;
  builderInspection: BuilderRunInspection | null;
  chatProgress: ChatProgressInspection | null;
  queueRedirect: boolean;
}) {
  const latestDecisionSummary = input.snapshot.latestDecision?.summary?.trim() || "";
  const latestRunSummary =
    handoffMachineSummary(input.snapshot.latestRun?.handoff) ||
    extractRunSummary(input.snapshot.latestRun?.finalMessage ?? "");
  const language = resolveAutomationUiLanguage([
    input.instruction,
    input.session.displayObjective ?? "",
    input.session.objective,
    latestRunSummary,
    latestDecisionSummary
  ]);
  const liveStepSummary =
    input.builderInspection?.progressSummary?.trim() ||
    input.chatProgress?.progressSummary?.trim() ||
    input.session.currentStepSummary.trim();
  const liveFocus = humanizeAutomationUiStepSummary(liveStepSummary, language);
  const latestResult = latestRunSummary || latestDecisionSummary;

  if (!input.queueRedirect) {
    if (language === "ko") {
      return [
        "현재 단계 작업을 계속 진행하고 있습니다.",
        liveFocus ? `현재 포커스: ${liveFocus}` : "",
        latestResult ? `최근 결과: ${latestResult}` : ""
      ]
        .filter(Boolean)
        .join(" ");
    }

    return [
      "Lithium is still working on the current step.",
      liveFocus ? `Current focus: ${liveFocus}` : "",
      latestResult ? `Latest result: ${latestResult}` : ""
    ]
      .filter(Boolean)
      .join(". ");
  }

  if (language === "ko") {
    return ["방금 지시를 기록했습니다.", "현재 단계는 마저 끝내고 다음 단계부터 반영하겠습니다."]
      .filter(Boolean)
      .join(" ");
  }

  return ["I recorded your latest instruction.", "I’ll finish the current step first, then switch to it."]
    .filter(Boolean)
    .join(" ");
}

function extractRunSummary(finalMessage: string) {
  const handoff = parseBuilderOutput(finalMessage);
  const machineSummary = handoffMachineSummary(handoff);
  if (machineSummary) {
    return machineSummary;
  }

  return finalMessage
    .replace(/\n*LITHIUM_STATUS\s*\n[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function buildAutomationChatFollowupPrompt(
  session: AutomationSessionRecord,
  question: string,
  checkpoint: AutomationCheckpointRecord
) {
  const language = resolveAutomationUiLanguage([
    question,
    session.displayObjective ?? "",
    session.objective,
    checkpoint.summary
  ]);

  if (language === "ko") {
    return [
      `사용자 질문: ${question.trim()}`,
      `자동 연구 목표: ${(session.displayObjective ?? session.objective).trim()}`,
      `현재 자동 연구 상태: 일시 정지. 최신 체크포인트는 "${checkpoint.title}"이며 요약은 "${checkpoint.summary.trim()}" 입니다.`,
      "이 질문은 새 strategist 재계획으로 보내지 말고, 현재 workspace의 최신 실험 산출물, 로그, 메모, runtime context를 바탕으로 바로 답하세요.",
      "이미 확인된 수치와 파일이 있으면 그 근거를 우선해서 설명하고, 아직 확정되지 않은 내용은 무엇이 비어 있는지만 짧게 밝히세요.",
      "답변 끝에 별도의 시스템 문구나 '잠시 멈춘 상태입니다' 같은 운영 문장을 덧붙이지 마세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    `User question: ${question.trim()}`,
    `Automation objective: ${(session.displayObjective ?? session.objective).trim()}`,
    `Automation state: paused. Latest checkpoint: "${checkpoint.title}" — ${checkpoint.summary.trim()}.`,
    "Answer directly from the current workspace artifacts, logs, notes, and runtime context instead of starting a new strategist replanning step.",
    "Prefer concrete measured results and file-backed evidence. If something is still unverified, say exactly what is missing.",
    "Do not append a separate operational status footer after the answer."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildAutomationStrategistPrompt(
  session: AutomationSessionRecord,
  redirectInstruction: string,
  languagePreference: AppSettings["autopilotPromptLanguage"],
  latestRun?: RunRecord | null,
  latestCheckpoint?: AutomationCheckpointRecord | null
) {
  const latestInstruction =
    redirectInstruction.trim() ||
    session.objective;

  if (!shouldReplanAfterFailedRun(latestRun, latestCheckpoint)) {
    return latestInstruction.trim();
  }

  const failureSummary = handoffMachineSummary(latestRun?.handoff) || extractRunSummary(latestRun?.finalMessage ?? "");
  const failureRisks = latestRun?.handoff?.risks ?? [];
  const promptLanguage = resolveAutomationPromptLanguage(languagePreference, [
    latestInstruction,
    failureSummary,
    ...failureRisks
  ]);

  if (promptLanguage === "ko") {
    return [
      latestInstruction.trim(),
      `직전 builder step이 ${latestRun?.status === "cancelled" ? "취소" : "실패"}되었습니다.`,
      failureSummary ? `직전 실패 요약: ${failureSummary}` : "",
      failureRisks.length ? formatPromptList("Failure risks", failureRisks) : "",
      "지금은 사용자에게 멈춰서 물어볼 단계가 아니라, 이 실패를 해결 대상으로 보고 원인을 진단한 뒤 다음 bounded recovery step을 하나 정해 진행해야 합니다.",
      "추가 리서치가 필요하면 먼저 하고, 그 다음 가장 가능성 높은 복구 step을 제안하세요.",
      "다만 다음 단계가 사용자 선택에 크게 의존하거나 여러 방향 중 하나를 골라야 한다면, 짧은 질문 하나를 하고 needs_user_checkpoint=true로 표시하세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    latestInstruction.trim(),
    `The latest builder step ${latestRun?.status === "cancelled" ? "was cancelled" : "failed"}.`,
    failureSummary ? `Latest failure summary: ${failureSummary}` : "",
    failureRisks.length ? formatPromptList("Failure risks", failureRisks) : "",
    "Do not stop for user review yet. Treat this failure as the next problem to solve, diagnose the cause, and choose the single highest-value bounded recovery step.",
    "If you need more research before editing code, do that first and then propose the most plausible recovery step.",
    "If the next move depends on a real user choice or multiple materially different directions, ask one concise question and set needs_user_checkpoint=true."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function shouldReplanAfterFailedRun(
  run?: RunRecord | null,
  latestCheckpoint?: AutomationCheckpointRecord | null
) {
  if (!run || (run.status !== "failed" && run.status !== "cancelled")) {
    return false;
  }

  return !isRestartInterruptedAutomationState(run, latestCheckpoint);
}

function shouldReplanFromRedirectInstruction(redirectInstruction: string) {
  return redirectInstruction.trim().length > 0 && classifyAutomationChatIntent(redirectInstruction) === "redirect";
}

function isRestartInterruptedAutomationState(
  run?: RunRecord | null,
  latestCheckpoint?: AutomationCheckpointRecord | null
) {
  if (!run) {
    return false;
  }

  const runTimestamp = run.endedAt || run.startedAt || run.createdAt;
  const checkpointMatches = Boolean(
    latestCheckpoint &&
      /^automation interrupted after app restart$/i.test(latestCheckpoint.title) &&
      latestCheckpoint.createdAt >= runTimestamp
  );
  const runSummary = handoffMachineSummary(run.handoff) || extractRunSummary(run.finalMessage || "");

  return checkpointMatches || /detached builder process after an app restart left it running without an active session/i.test(runSummary);
}

function shouldRequireAutomationCheckpoint(input: {
  decision: DecisionRecord | null | undefined;
  run: RunRecord | null;
}) {
  const automationMode = input.run?.handoff?.automationMode || input.decision?.handoff?.automationMode;
  const needsUserCheckpoint =
    input.run?.handoff?.needsUserCheckpoint || input.decision?.handoff?.needsUserCheckpoint;

  return automationMode === "checkpoint" || automationMode === "blocked" || needsUserCheckpoint === true;
}

function summarizeAutomationFailureRecovery(input: {
  runStatus: RecordStatus;
  runSummary: string;
  usedRetries: number;
  maxRetries: number;
  language: "ko" | "en";
}) {
  if (input.language === "ko") {
    const base =
      input.runStatus === "cancelled"
        ? "직전 단계가 끝나기 전에 중단되었습니다."
        : "직전 단계가 깔끔하게 끝나지 않았습니다.";
    return [base, input.runSummary.trim(), "자동으로 다음 복구 경로를 정리하고 있습니다."]
      .filter(Boolean)
      .join(" ");
  }

  const base =
    input.runStatus === "cancelled"
      ? "The latest step was cancelled before it finished."
      : "The latest step did not finish cleanly.";
  return [base, input.runSummary.trim(), "Lithium is already planning the next recovery step."]
    .filter(Boolean)
    .join(" ");
}

function shouldPersistThreadSummary(summary: string) {
  const trimmed = summary.trim();

  if (!trimmed) {
    return false;
  }

  return !isOperationalAutomationMessage(trimmed) && !/^builder run started\.?$/i.test(trimmed);
}

function resolveAutomationUiLanguage(samples: string[]) {
  return samples.some(containsHangul) ? "ko" : "en";
}

function humanizeAutomationUiStepSummary(value: string, language: "ko" | "en") {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (language === "ko") {
    if (/^thinking[.…]*$/i.test(trimmed)) {
      return "필요한 맥락을 정리하고 있습니다.";
    }

    if (/^finishing[.…]*$/i.test(trimmed)) {
      return "마무리하고 있습니다.";
    }

    if (/plan the next bounded research step/i.test(trimmed)) {
      return "다음 연구 단계를 작게 쪼개서 정리하고 있습니다.";
    }

    if (/let codex choose and execute the next bounded step/i.test(trimmed)) {
      return "다음으로 검증할 실험이나 구현 단계를 고르고 있습니다.";
    }

    if (/continuing the current step\. the latest instruction will be applied next/i.test(trimmed)) {
      return "현재 단계는 마저 끝내고, 방금 보낸 지시는 다음 단계부터 반영합니다.";
    }

    if (/^recovering after\b/i.test(trimmed)) {
      return "직전 단계 이후 복구 경로를 진행하고 있습니다.";
    }

    if (/^continuing after\b/i.test(trimmed)) {
      return "방금 끝난 단계에 이어 다음 작업을 진행하고 있습니다.";
    }
  }

  return trimmed;
}

function buildQueuedAutomationStepSummary(language: "ko" | "en") {
  return language === "ko"
    ? "현재 단계는 마저 끝내고, 방금 보낸 지시는 다음 단계부터 반영합니다."
    : "Continuing the current step. The latest instruction will be applied next.";
}

function describeAutomationControllerFailure(message: string) {
  const trimmed = message.trim() || "Automation failed.";

  if (isStrategistBlockedFailure(trimmed)) {
    return {
      title: "Automation blocked on the strategist run",
      summary: "The strategist browser step needs help before automation can continue.",
      currentStepSummary: "Blocked on the strategist run. Waiting for your direction.",
      nextActions: isStrategistBrowserBlockedFailure(trimmed)
        ? [
            "Keep the strategist Chrome window open until completion, then retry.",
            "If needed, set LITHIUM_ORACLE_VISIBLE=1 and retry so you can watch the oracle/browser flow."
          ]
        : [
            "Inspect the latest oracle session logs and retry the strategist step.",
            "If needed, set LITHIUM_ORACLE_VISIBLE=1 and retry so you can watch the oracle/browser flow."
          ]
    };
  }

  return {
    title: "Automation failed",
    summary: "The latest run did not finish cleanly.",
    currentStepSummary: "Automation stopped with an issue. Waiting for your direction.",
    nextActions: ["Inspect the latest checkpoint, logs, and run artifacts before resuming."]
  };
}

function isStrategistBlockedFailure(message: string) {
  return /oracle strategist run completed without producing output|chrome window closed before oracle finished|lithium_oracle_visible=1|saved chatgpt session expired|chatgpt session expired/i.test(
    message
  );
}

function isStrategistBrowserBlockedFailure(message: string) {
  return /chrome window closed before oracle finished|lithium_oracle_visible=1|saved chatgpt session expired|chatgpt session expired/i.test(
    message
  );
}

function buildContextDrivenBuilderPrompt(
  objective: string,
  decision: DecisionRecord | null | undefined,
  languagePreference: AppSettings["autopilotPromptLanguage"]
) {
  const primaryObjective = objective.trim();
  const strategistAnswer = extractVisibleStrategistReply(decision?.rawOutput ?? "") || handoffUserMessage(decision?.handoff);
  const strategistSummary = decision?.summary?.trim() ?? "";
  const strategistRationale = decision?.rationale?.trim() ?? "";
  const promptLanguage = resolveAutomationPromptLanguage(languagePreference, [
    objective,
    strategistAnswer,
    strategistSummary,
    strategistRationale
  ]);
  const successCriteria = decision?.handoff?.successCriteria ?? [];
  const suggestedFiles = decision?.handoff?.files ?? [];
  const openQuestions = decision?.handoff?.openQuestions ?? [];
  const summaryLine =
    strategistSummary && !strategistAnswer && !isRedundantBuilderContext(strategistSummary, strategistAnswer)
      ? `Strategist summary: ${strategistSummary}`
      : "";
  const rationaleLine = strategistRationale ? `Strategist rationale: ${strategistRationale}` : "";

  if (promptLanguage === "ko") {
    return [
      primaryObjective,
      strategistAnswer ? `Strategist answer:\n${strategistAnswer}` : "",
      summaryLine,
      rationaleLine,
      successCriteria.length ? formatPromptList("Success criteria", successCriteria) : "",
      suggestedFiles.length ? formatPromptList("Suggested files", suggestedFiles) : "",
      openQuestions.length ? formatPromptList("Open questions", openQuestions) : "",
      "최신 strategist 리서치와 프로젝트 상태는 runtime context에 들어 있습니다. 그 맥락을 참고해 Codex가 실행 주체로서 현재 저장소에서 가장 가치 있는 다음 bounded action을 직접 결정하고 수행하세요.",
      "아직 코드나 파일 수정보다 추가 리서치, 노트 정리, 또는 사용자 보고가 더 적절하면 파일을 바꾸지 말고 그렇게 판단한 이유와 다음 제안만 답하세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    primaryObjective,
    strategistAnswer ? `Strategist answer:\n${strategistAnswer}` : "",
    summaryLine,
    rationaleLine,
    successCriteria.length ? formatPromptList("Success criteria", successCriteria) : "",
    suggestedFiles.length ? formatPromptList("Suggested files", suggestedFiles) : "",
    openQuestions.length ? formatPromptList("Open questions", openQuestions) : "",
    "The latest strategist research and project state are in the runtime context. Use that context and let Codex decide and execute the highest-value next bounded action inside the active repository.",
    "If deeper research, note-taking, or a user-facing report is more appropriate than changing files right now, do not modify files and explain that judgment plus the next recommendation."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function stripLegacyNextTask(handoff: LithiumHandoff) {
  const { nextTask: _legacyNextTask, ...rest } = handoff;
  return rest;
}

function extractVisibleStrategistReply(rawOutput: string, maxChars = 2400) {
  const stripped = rawOutput
    .replace(/\n*LITHIUM_HANDOFF[\s\S]*$/m, "")
    .replace(/\n\s*입니다\.\s*(?=\n|$)/g, "")
    .trim();

  if (!stripped || looksLikeStructuredStrategistOnly(stripped)) {
    return "";
  }

  if (stripped.length <= maxChars) {
    return stripped;
  }

  const budget = Math.max(0, maxChars - 1);
  return `${stripped.slice(0, budget).trimEnd()}…`;
}

function looksLikeStructuredStrategistOnly(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return true;
  }

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || trimmed === "LITHIUM_HANDOFF") {
    return true;
  }

  const meaningfulLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return meaningfulLines.every((line) =>
    /^(summary|machine_summary|user_message|next[_ ]task|rationale|files|risks|paper_actions|run_actions|success_criteria|open_questions)\s*:/i.test(
      line
    )
  );
}

function isRedundantBuilderContext(summary: string, answer: string) {
  const normalizedSummary = summary.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedAnswer = answer.replace(/\s+/g, " ").trim().toLowerCase();
  return Boolean(normalizedSummary && normalizedAnswer && normalizedAnswer.includes(normalizedSummary));
}

function resolveAutomationPromptLanguage(
  preference: AppSettings["autopilotPromptLanguage"],
  samples: string[]
): "ko" | "en" {
  if (preference === "ko" || preference === "en") {
    return preference;
  }

  return samples.some(containsHangul) ? "ko" : "en";
}

function containsHangul(value: string) {
  return /[\u3131-\u318E\uAC00-\uD7A3]/.test(value);
}

function formatPromptList(label: string, values: string[]) {
  return `${label}:\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function inferAutomationBuilderStepKind(builderPrompt: string): AutomationStepKind {
  const normalized = builderPrompt.toLowerCase();

  if (/\b(run|train|evaluate|benchmark|ablation|experiment|sweep)\b/.test(normalized)) {
    return "experiment-run";
  }

  if (/\b(analy[sz]e|inspect|summari[sz]e|plot|csv|metric|result|figure|table)\b/.test(normalized)) {
    return "result-analysis";
  }

  if (/\b(paper|manuscript|latex|tex|write|draft|section|caption)\b/.test(normalized)) {
    return "paper-sync";
  }

  if (/\b(literature|paper search|related work|citation|survey|search)\b/.test(normalized)) {
    return "literature-search";
  }

  return "code-edit";
}

function buildAutomationEvidence(run?: RunRecord | null) {
  if (!run) {
    return [];
  }

  return Array.from(
    new Set(
      [
        run.id,
        `status:${run.status}`,
        handoffMachineSummary(run.handoff),
        ...run.changedFiles.slice(0, 8)
      ].filter(Boolean)
    )
  );
}

function isPaperRelatedPath(filePath: string) {
  return /(^|\/)(paper|manuscript)\//i.test(filePath) || /\.(tex|bib|cls|sty|pdf)$/i.test(filePath);
}

function shouldBeginPaperPhase(
  session: AutomationSessionRecord,
  decision: DecisionRecord | null | undefined
) {
  if (session.paperWriteEnabled || !decision) {
    return session.paperWriteEnabled;
  }

  const combined = [
    decision.summary,
    decision.rationale,
    ...(decision.handoff?.paperActions ?? [])
  ]
    .join(" ")
    .toLowerCase();

  return /\b(paper|manuscript|latex|tex|abstract|results section|discussion section|write-up|draft)\b/.test(
    combined
  );
}

function clampTerminalSize(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.round(value as number), min), max);
}

function resolveBuilderModel(candidate: BuilderRequest["model"], fallback?: string): BuilderModel {
  if (isBuilderModel(candidate)) {
    return candidate;
  }

  if (isBuilderModel(fallback)) {
    return fallback;
  }

  return DEFAULT_APP_SETTINGS.builderModel;
}

function resolveBuilderReasoningEffort(
  candidate: BuilderRequest["reasoningEffort"],
  fallback?: BuilderReasoningEffort
): BuilderReasoningEffort {
  if (isBuilderReasoningEffort(candidate)) {
    return candidate;
  }

  return isBuilderReasoningEffort(fallback) ? fallback : DEFAULT_APP_SETTINGS.builderReasoningEffort;
}

function extractChatRouteOverride(rawPrompt: string): {
  route: ChatRoute | null;
  prompt: string;
} {
  const trimmed = rawPrompt.trim();
  const match = trimmed.match(/^\/(research|build|mixed|plan)\b\s*/i);

  if (!match) {
    return {
      route: null,
      prompt: trimmed
    };
  }

  const command = match[1].toLowerCase();
  const prompt = trimmed.slice(match[0].length).trim();

  return {
    route:
      command === "research" || command === "plan"
        ? "strategist"
        : command === "build"
        ? "builder"
        : "mixed",
    prompt
  };
}

function mergeProgressDetails(primary: string[], secondary: string[]) {
  return Array.from(
    new Set(
      [...primary, ...secondary]
        .map((entry) => entry.replace(/\s+/g, " ").trim())
        .filter(Boolean)
    )
  ).slice(-5);
}

function extractProgressTailDetails(...tails: string[]) {
  return Array.from(
    new Set(
      tails
        .flatMap((text) => text.split("\n"))
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .filter((line) => !/^LITHIUM_/i.test(line))
        .filter((line) => !/^[>{}\[\],"]+$/.test(line))
        .filter((line) => !/^(model|reasoning intensity|launching browser mode|objective|budget|latest user direction)\s*:/i.test(line))
        .filter(
          (line) =>
            !/^(summary|next_task|rationale|files|risks|paper_actions|run_actions|success_criteria|open_questions)\s*:/i.test(
              line
            )
        )
        .filter(
          (line) =>
            /thinking|search|reading|opening|checking|analy|fetch|cite|source|draft|writing|compare|review/i.test(
              line
            )
        )
        .filter((line) => line.length <= 220)
    )
  ).slice(-3);
}

async function readOracleSessionTail(sessionSlug: string) {
  const logPath = await resolveOracleSessionOutputLogPath(sessionSlug);

  if (!logPath) {
    return "";
  }

  return await readTailText(logPath, 24 * 1024).catch(() => "");
}

async function resolveOracleSessionOutputLogPath(sessionSlug: string) {
  const sessionsDir = path.join(resolveOracleHomeDir(), "sessions");
  const candidateSessionIds = Array.from(
    new Set([sessionSlug, normalizeOracleSessionId(sessionSlug)]).values()
  );

  for (const candidateSessionId of candidateSessionIds) {
    const exactPath = path.join(sessionsDir, candidateSessionId, "output.log");

    try {
      await access(exactPath);
      return exactPath;
    } catch {
      // Fall through to prefix scan.
    }
  }

  const entries = await readdirSafe(sessionsDir);
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) =>
        candidateSessionIds.some(
          (candidateSessionId) =>
            entry.name === candidateSessionId || entry.name.startsWith(`${candidateSessionId}-`)
        )
      )
      .map(async (entry) => {
        const logPath = path.join(sessionsDir, entry.name, "output.log");

        try {
          const metadata = await stat(logPath);
          return {
            logPath,
            modifiedAt: metadata.mtimeMs
          };
        } catch {
          return null;
        }
      })
  );

  return candidates
    .filter((entry): entry is { logPath: string; modifiedAt: number } => Boolean(entry))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.logPath;
}

async function readdirSafe(dirPath: string) {
  return await readdir(dirPath, { withFileTypes: true }).catch(() => []);
}

function resolveOracleHomeDir() {
  return process.env.ORACLE_HOME_DIR?.trim() || path.join(os.homedir(), ".oracle");
}

function formatRouterActivityLine(trace: RouterTraceRecord) {
  const overrideSuffix = trace.requestedRoute ? ` override=${trace.requestedRoute}` : "";
  const downstreamSuffix = trace.downstreamError
    ? ` downstream_error=${trace.downstreamError}`
    : [
        trace.downstreamDecisionId ? `decision=${trace.downstreamDecisionId}` : "",
        trace.downstreamRunId ? `run=${trace.downstreamRunId}` : "",
        trace.downstreamTaskId ? `task=${trace.downstreamTaskId}` : ""
      ]
        .filter(Boolean)
        .join(" ");

  return `${trace.id} routed model=${trace.route} final=${trace.finalRoute}${overrideSuffix}${
    downstreamSuffix ? ` ${downstreamSuffix}` : ""
  }`;
}

function looksLikeCodexTranscript(value: string) {
  const legacyMarkers = [
    /^OpenAI Codex v/im.test(value),
    /\nuser\s*\nYou are the Lithium builder/i.test(value),
    /\nCONTEXT_PACK:\n/i.test(value) ||
      /\nRUNTIME_CONTEXT:\n/i.test(value) ||
      /\nFULL_ARTIFACT_CONTEXT:\n/i.test(value),
    /\nexec\s*\n\/bin\/zsh -lc/i.test(value),
    /\nPlan update\s*\n/i.test(value)
  ].filter(Boolean);

  if (legacyMarkers.length >= 2) {
    return true;
  }

  const jsonEventMarkers = [
    /(?:^|\s)\{"type":"thread\.(?:started|completed)"/m.test(value),
    /(?:^|\s)\{"type":"turn\.(?:started|completed)"/m.test(value),
    /"type":"item\.(?:started|completed|updated)"/.test(value),
    /"type":"(?:agent_message|command_execution|web_search|todo_list)"/.test(value)
  ].filter(Boolean).length;

  if (jsonEventMarkers >= 3) {
    return true;
  }

  const progress = parseCodexProgressLog(value);
  const hasJsonProgressSignal = Boolean(
    progress.progressSummary || progress.progressDetails.length > 0 || progress.activeCommand
  );

  if (jsonEventMarkers >= 2 && hasJsonProgressSignal) {
    return true;
  }

  const jsonObjectCount = value.match(/\{"type":"[^"]+"/g)?.length ?? 0;
  return jsonObjectCount >= 4 && /"type":"item\.(?:started|completed|updated)"/.test(value);
}

function looksLikeBuilderPromptTemplate(handoff: LithiumHandoff) {
  const summary = handoffMachineSummary(handoff) || handoff.summary;

  return (
    summary.includes("<what changed>") ||
    handoff.files.some((entry) => entry.includes("<relative path>")) ||
    handoff.risks.some((entry) => entry.includes("<risk")) ||
    handoff.paperActions.some((entry) => entry.includes("<paper")) ||
    handoff.runActions.some((entry) => entry.includes("<run")) ||
    handoff.successCriteria.some((entry) => entry.includes("<verification>")) ||
    handoff.openQuestions.some((entry) => entry.includes("<open question"))
  );
}

function extractBuilderFailureSummary(stdout: string, stderr: string) {
  const transcriptFailure = extractCodexTranscriptFailure(stdout);

  if (transcriptFailure) {
    return transcriptFailure;
  }

  const stderrFailure = extractMeaningfulFailureLine(stderr);

  if (stderrFailure) {
    return stderrFailure;
  }

  return "";
}

function extractCodexTranscriptFailure(stdout: string) {
  let latestFailure = "";

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        item?: {
          type?: string;
          status?: string;
          aggregated_output?: string;
        };
      };

      if (
        event.type !== "item.completed" ||
        event.item?.type !== "command_execution" ||
        event.item.status !== "failed"
      ) {
        continue;
      }

      const normalized = extractMeaningfulFailureLine(event.item.aggregated_output ?? "");

      if (normalized) {
        latestFailure = normalized;
      }
    } catch {
      // Ignore malformed transcript lines.
    }
  }

  return latestFailure;
}

function extractMeaningfulFailureLine(value: string) {
  const lines = value
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !isIgnorableBuilderWarning(line));

  return lines.at(-1) ?? "";
}

function isIgnorableBuilderWarning(value: string) {
  return /codex_core::shell_snapshot: Failed to delete shell snapshot .*No such file or directory/i.test(
    value.trim()
  );
}

function summarizeInterruptedAutomationSession(
  step: AutomationStepRecord | null,
  run: RunRecord | null
) {
  if (run?.status === "completed") {
    return "The latest builder run finished, but automation stopped when Lithium restarted before it could continue.";
  }

  if (step?.lane === "strategist") {
    return "Automation stopped when Lithium restarted during the strategist step.";
  }

  if (step?.lane === "builder") {
    return "Automation stopped when Lithium restarted during the builder step.";
  }

  return "Automation stopped when Lithium restarted before the latest step finished.";
}

function createSyntheticBuilderFinalMessage(summary: string, result: "success" | "partial" | "failed") {
  return [
    summary,
    "",
    "LITHIUM_STATUS",
    JSON.stringify({
      summary,
      machine_summary: summary,
      result,
      files: [],
      risks: [],
      paper_actions: [],
      run_actions: [],
      success_criteria: [],
      open_questions: []
    })
  ].join("\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createEmptyProjectSnapshot(): ProjectSnapshot {
  return {
    project: null,
    memory: null,
    threads: [],
    activeThreadId: null,
    activeThread: null,
    attachments: [],
    activeThreadAttachments: [],
    decisions: [],
    tasks: [],
    runs: [],
    routerTraces: [],
    latestDecision: null,
    latestTask: null,
    latestRun: null,
    latestRouterTrace: null,
    terminalSessions: [],
    latestTerminalSession: null,
    manuscript: null,
    automationSessions: [],
    automationSteps: [],
    automationCheckpoints: [],
    latestAutomationSession: null,
    latestAutomationCheckpoint: null,
    logs: []
  };
}
