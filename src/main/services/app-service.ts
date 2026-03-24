import path, { basename } from "node:path";
import { execFile } from "node:child_process";
import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
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
  AutomationCycleLaneState,
  AutomationCyclePhase,
  AutomationCycleRecord,
  AutomationCycleStatus,
  AutomationInterruptRequest,
  AutomationMode,
  AutomationSessionControlRequest,
  AutomationSessionCreateRequest,
  AutomationSessionRecord,
  AutomationStatus,
  AutomationStepKind,
  AutomationWorkerMode,
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
  CommandSpec,
  ConversationEntryRecord,
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
import { OrchestratorRunner, type OrchestratorDelegationLane } from "./orchestrator-runner";
import { type OrchestratorDelegationDirective } from "./orchestrator-directives";
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
  orchestratorRunner?: Pick<OrchestratorRunner, "runTurn"> | null;
  routerRunner?: Pick<RouterRunner, "route">;
  oracleRunner?: Pick<OracleRunner, "consult"> &
    Partial<Pick<OracleRunner, "startConsult" | "terminateSession">>;
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
  operationId: string;
  lane: "orchestrator" | "router" | "strategist" | "builder";
  threadId: string;
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

type AutomationWorkerDelegation = Extract<
  OrchestratorDelegationDirective,
  { lane: "builder" | "strategist" }
>;

type AutomationDelegatedBuilderResult = {
  lane: "builder";
  delegation: Extract<AutomationWorkerDelegation, { lane: "builder" }>;
  step: AutomationStepRecord;
  latestRun: RunRecord | null;
  runStatus: RecordStatus;
  runSummary: string;
  runChangedFiles: string[];
  runEvidence: string[];
  runRisks: string[];
  runActions: string[];
};

type AutomationDelegatedStrategistResult = {
  lane: "strategist";
  delegation: Extract<AutomationWorkerDelegation, { lane: "strategist" }>;
  step: AutomationStepRecord;
  decision: DecisionRecord | null;
  pending?: boolean;
};

type AutomationDelegatedWorkerResult =
  | AutomationDelegatedBuilderResult
  | AutomationDelegatedStrategistResult;

export class AppService {
  private static terminalEventUnsubscribe: (() => void) | null = null;
  private selectedWorkspacePath: string;
  private readonly terminatingRunIds = new Set<string>();
  private readonly activeChatProgressByWorkspace = new Map<string, ActiveChatProgress>();
  private readonly automationControllers = new Map<string, AutomationControllerState>();
  private readonly orchestratorTurnLocks = new Map<string, Promise<void>>();
  private readonly store: ProjectStore;
  private readonly orchestratorRunner: Pick<OrchestratorRunner, "runTurn"> | null;
  private readonly routerRunner: Pick<RouterRunner, "route">;
  private readonly oracleRunner: Pick<OracleRunner, "consult"> &
    Partial<Pick<OracleRunner, "startConsult" | "terminateSession">>;
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
    this.orchestratorRunner = dependencies.orchestratorRunner ?? null;
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
      plannerSessionId: undefined,
      plannerUpdatedAt: undefined,
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
      latestCycleId: undefined,
      activeCycleId: undefined,
      activeLaneStepIds: [],
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
      await this.finalizeAutomationCycle(workspacePath, session, session.activeCycleId, {
        status: "failed",
        phase: "reporting",
        summary: visibleStopInstruction || instruction || "Stopped by the user."
      });

      await this.store.writeAutomationSession(workspacePath, {
        ...session,
        status: "idle",
        activeCycleId: undefined,
        activeLaneStepIds: [],
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

    const resumedMode = resolveAutomationConversationMode(
      session.mode,
      [response, session.displayObjective ?? ""].filter(Boolean).join("\n")
    );
    await this.writeRunningAutomationSession(workspacePath, session, {
      mode: resumedMode,
      latestCheckpointId: undefined,
      currentStepSummary: "Checkpoint approved. Continuing automation.",
      lastUserInstruction: response || session.lastUserInstruction,
      queuedUserInstruction: response || session.queuedUserInstruction
    });
    await this.appendAutomationStatusEntry(workspacePath, {
      session,
      body: buildAutomationResumeConversationMessage({
        session,
        checkpoint,
        response,
        mode: resumedMode
      })
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

  private async handleConversationOrchestratorMessage(
    input: {
      workspacePath: string;
      snapshot: ProjectSnapshot;
      activeThread: ThreadRecord;
      prompt: string;
      normalizedPrompt: string;
    },
    options: {
      strategistSessionReady?: boolean;
    } = {}
  ) {
    const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
    const requestPaths = this.buildConversationOrchestratorRequestPaths(input.workspacePath, input.activeThread.id);

    await this.appendConversationEntry(input.workspacePath, {
      threadId: input.activeThread.id,
      role: "user",
      source: "user",
      body: input.prompt
    });
    await this.store.appendPromptLog(input.workspacePath, {
      kind: "chat.user",
      lane: "chat",
      threadId: input.activeThread.id,
      prompt: input.prompt,
      normalizedPrompt: input.normalizedPrompt,
      orchestrated: true
    });

    this.setChatProgress(input.workspacePath, {
      lane: "orchestrator",
      threadId: input.activeThread.id,
      progressSummary: "Thinking…",
      progressDetails: ["Reviewing the latest thread state and choosing the next move."],
      activeCommand: null,
      stdoutPath: path.join(path.dirname(requestPaths.builder), "orchestrator.stdout.log"),
      stderrPath: path.join(path.dirname(requestPaths.builder), "orchestrator.stderr.log")
    });
    try {
      const initialContext = await this.store.buildRuntimeContext(input.workspacePath, input.normalizedPrompt, {
        lane: "builder"
      });
      const firstTurn = await this.runSerializedOrchestratorTurn(
        input.workspacePath,
        `chat:${input.activeThread.id}`,
        async () =>
          await this.orchestratorRunner!.runTurn({
            workspacePath: input.workspacePath,
            sessionId: input.activeThread.conversationOrchestratorSessionId,
            prompt: input.prompt,
            runtimeContext: initialContext.content,
            stdoutPath: path.join(path.dirname(requestPaths.builder), "orchestrator.stdout.log"),
            stderrPath: path.join(path.dirname(requestPaths.builder), "orchestrator.stderr.log"),
            outputPath: path.join(path.dirname(requestPaths.builder), "orchestrator.reply.md"),
            requestPaths,
            hostKey: `chat:${input.activeThread.id}`,
            model: appSettings.builderModel === "gpt-5.3-codex" ? "gpt-5.4" : appSettings.builderModel,
            reasoningEffort: "xhigh"
          })
      );
      await this.persistConversationOrchestratorSessionId(
        input.workspacePath,
        input.activeThread,
        firstTurn.sessionId
      );

      const directReply = sanitizeConversationBody(firstTurn.finalMessage);
      const firstDelegations = resolveOrchestratorDelegations(firstTurn, input.normalizedPrompt);
      const automationDelegation = firstDelegations.find(
        (delegation): delegation is Extract<OrchestratorDelegationDirective, { lane: "automation" }> =>
          delegation.lane === "automation"
      );
      const workerDelegations = firstDelegations.filter(
        (delegation): delegation is Extract<OrchestratorDelegationDirective, { lane: "builder" | "strategist" }> =>
          delegation.lane === "builder" || delegation.lane === "strategist"
      );

      if (automationDelegation) {
        const automationMode = resolveAutomationConversationMode(
          automationDelegation.mode,
          input.prompt
        );
        const createdSnapshot = await this.createAutomationSession({
          workspacePath: input.workspacePath,
          threadId: input.activeThread.id,
          objective: automationDelegation.prompt || input.prompt,
          displayObjective: input.prompt,
          mode: automationMode,
          maxSteps: automationDelegation.maxSteps ?? 64,
          maxRuntimeMinutes: automationDelegation.maxRuntimeMinutes ?? 24 * 60,
          maxRetries: automationDelegation.maxRetries ?? 8,
          paperWriteEnabled: automationDelegation.paperWriteEnabled ?? false
        });
        const sessionId = createdSnapshot.latestAutomationSession?.id;

        if (!sessionId) {
          throw new Error("Automation session could not be created.");
        }

        await this.startAutomationSession({
          workspacePath: input.workspacePath,
          sessionId
        });
        const reply =
          directReply ||
          localizeAutomationStartReply(input.prompt);

        await this.appendConversationEntry(input.workspacePath, {
          threadId: input.activeThread.id,
          role: "assistant",
          source: "automation",
          body: reply,
          automationSessionId: sessionId
        });
        await this.syncThreadFromArtifacts(input.workspacePath, input.activeThread, {
          prompt: input.prompt,
          summary: reply
        });
        await this.store.appendActivity(input.workspacePath, `${sessionId} automation started from orchestrator chat`);
        await this.store.updateSessionSummary(input.workspacePath);
        return await this.store.getSnapshot(input.workspacePath);
      }

      if (!workerDelegations.length) {
        const reply = directReply || "I reviewed the latest workspace state, but I do not have a clearer answer yet.";

        await this.appendConversationEntry(input.workspacePath, {
          threadId: input.activeThread.id,
          role: "assistant",
          source: "orchestrator",
          body: reply
        });
        await this.syncThreadFromArtifacts(input.workspacePath, input.activeThread, {
          prompt: input.prompt,
          summary: reply
        });
        await this.store.appendActivity(input.workspacePath, "orchestrator answered directly in chat");
        await this.store.updateSessionSummary(input.workspacePath);
        return await this.store.getSnapshot(input.workspacePath);
      }

      this.clearChatProgress(input.workspacePath, input.activeThread.id, "orchestrator");

      const workerTurn = await this.runOrchestratorWorkerTurns(
        input,
        workerDelegations,
        options
      );
      if (
        workerTurn.startedLiveRun &&
        workerTurn.results.length === 1 &&
        workerTurn.results[0].lane === "builder"
      ) {
        const liveDelegation = workerTurn.results[0].delegation;
        const reply =
          directReply ||
          (liveDelegation
            ? summarizeLiveWorkerStartForConversation(liveDelegation, workerTurn.snapshot)
            : summarizeWorkerSnapshotsForConversation(workerDelegations, workerTurn.snapshot));
        await this.appendConversationEntry(input.workspacePath, {
          threadId: input.activeThread.id,
          role: "assistant",
          source: "orchestrator",
          body: reply,
          runId: workerTurn.snapshot.latestRun?.id
        });
        await this.syncThreadFromArtifacts(input.workspacePath, input.activeThread, {
          prompt: input.prompt,
          summary: reply
        });
        await this.store.appendActivity(input.workspacePath, "orchestrator started a live builder run from chat");
        await this.store.updateSessionSummary(input.workspacePath);
        return await this.store.getSnapshot(input.workspacePath);
      }
      const refreshedThread =
        workerTurn.snapshot.threads.find((thread) => thread.id === input.activeThread.id) ?? input.activeThread;
      const followupPrompt =
        workerDelegations.length === 1
          ? buildOrchestratorWorkerFollowupPrompt({
              originalPrompt: input.prompt,
              lane: workerDelegations[0].lane,
              workerPrompt: workerDelegations[0].prompt || input.normalizedPrompt,
              snapshot: workerTurn.snapshot
            })
          : buildOrchestratorParallelFollowupPrompt({
              originalPrompt: input.prompt,
              delegations: workerDelegations,
              snapshot: workerTurn.snapshot
            });
      const followupContext = await this.store.buildRuntimeContext(
        input.workspacePath,
        followupPrompt,
        {
          lane: "builder"
        }
      );
      this.setChatProgress(input.workspacePath, {
        lane: "orchestrator",
        threadId: input.activeThread.id,
        progressSummary: "Wrapping up…",
        progressDetails: ["Turning the worker result into a clean reply for this chat."],
        activeCommand: null,
        stdoutPath: path.join(path.dirname(requestPaths.builder), "orchestrator.followup.stdout.log"),
        stderrPath: path.join(path.dirname(requestPaths.builder), "orchestrator.followup.stderr.log")
      });
      const secondTurn = await this.runSerializedOrchestratorTurn(
        input.workspacePath,
        `chat:${refreshedThread.id}`,
        async () =>
          await this.orchestratorRunner!.runTurn({
            workspacePath: input.workspacePath,
            sessionId:
              refreshedThread.conversationOrchestratorSessionId ||
              firstTurn.sessionId ||
              undefined,
            prompt: followupPrompt,
            runtimeContext: followupContext.content,
            stdoutPath: path.join(path.dirname(requestPaths.builder), "orchestrator.followup.stdout.log"),
            stderrPath: path.join(path.dirname(requestPaths.builder), "orchestrator.followup.stderr.log"),
            outputPath: path.join(path.dirname(requestPaths.builder), "orchestrator.followup.reply.md"),
            requestPaths,
            hostKey: `chat:${refreshedThread.id}`,
            model: appSettings.builderModel === "gpt-5.3-codex" ? "gpt-5.4" : appSettings.builderModel,
            reasoningEffort: "xhigh"
          })
      );
      await this.persistConversationOrchestratorSessionId(
        input.workspacePath,
        refreshedThread,
        secondTurn.sessionId
      );

      const reply =
        sanitizeConversationBody(secondTurn.finalMessage) ||
        summarizeWorkerSnapshotsForConversation(workerDelegations, workerTurn.snapshot);
      const relatedDecisionId = workerDelegations.some((delegation) => delegation.lane === "strategist")
        ? workerTurn.snapshot.latestDecision?.id
        : undefined;
      const relatedRunId = workerDelegations.some((delegation) => delegation.lane === "builder")
        ? workerTurn.snapshot.latestRun?.id
        : undefined;

      await this.appendConversationEntry(input.workspacePath, {
        threadId: input.activeThread.id,
        role: "assistant",
        source: "orchestrator",
        body: reply,
        decisionId: relatedDecisionId,
        runId: relatedRunId
      });
      await this.syncThreadFromArtifacts(input.workspacePath, refreshedThread, {
        prompt: input.prompt,
        summary: reply
      });
      await this.store.appendActivity(
        input.workspacePath,
        `orchestrator completed a ${describeDelegationSetForActivity(workerDelegations)} follow-up in chat`
      );
      await this.store.updateSessionSummary(input.workspacePath);
      return await this.store.getSnapshot(input.workspacePath);
    } finally {
      this.clearChatProgress(input.workspacePath, input.activeThread.id, "orchestrator");
    }
  }

  private buildConversationOrchestratorRequestPaths(workspacePath: string, threadId: string) {
    const paths = this.store.buildPaths(workspacePath);
    const baseDir = path.join(paths.root, "orchestrator", "chat", threadId);

    return {
      builder: path.join(baseDir, "builder.md"),
      strategist: path.join(baseDir, "strategist.md"),
      automation: path.join(baseDir, "automation.md")
    };
  }

  private buildAutomationPlannerRequestPaths(workspacePath: string, sessionId: string) {
    const paths = this.store.buildPaths(workspacePath);
    const baseDir = path.join(paths.root, "automation", "planner", sessionId);

    return {
      builder: path.join(baseDir, "builder.md"),
      strategist: path.join(baseDir, "strategist.md"),
      automation: path.join(baseDir, "automation.md")
    };
  }

  private async appendConversationEntry(
    workspacePath: string,
    input: Omit<ConversationEntryRecord, "id" | "createdAt">
  ) {
    const allocation = await this.store.allocateConversationEntry(workspacePath);
    const entry: ConversationEntryRecord = {
      id: allocation.id,
      createdAt: new Date().toISOString(),
      ...input
    };

    await this.store.writeConversationEntry(workspacePath, entry);
    return entry;
  }

  private async appendAutomationStatusEntry(
    workspacePath: string,
    input: {
      session: AutomationSessionRecord;
      body: string;
      checkpoint?: AutomationCheckpointRecord;
      cycleId?: string;
      stepId?: string;
    }
  ) {
    const body = input.body.trim();

    if (!body) {
      return null;
    }

    return await this.appendConversationEntry(workspacePath, {
      threadId: input.session.threadId,
      role: "system",
      source: input.checkpoint ? "checkpoint" : "system",
      body,
      automationSessionId: input.session.id,
      automationCycleId: input.cycleId,
      automationStepId: input.stepId,
      automationCheckpointId: input.checkpoint?.id
    });
  }

  private async appendAutomationAssistantEntry(
    workspacePath: string,
    input: {
      session: AutomationSessionRecord;
      body: string;
      decisionId?: string;
      runId?: string;
      cycleId?: string;
      stepId?: string;
    }
  ) {
    const body = sanitizeConversationBody(input.body);

    if (!body) {
      return null;
    }

    return await this.appendConversationEntry(workspacePath, {
      threadId: input.session.threadId,
      role: "assistant",
      source: "automation",
      body,
      decisionId: input.decisionId,
      runId: input.runId,
      automationSessionId: input.session.id,
      automationCycleId: input.cycleId,
      automationStepId: input.stepId
    });
  }

  private async persistConversationOrchestratorSessionId(
    workspacePath: string,
    thread: ThreadRecord,
    sessionId: string | null
  ) {
    const normalizedSessionId = sessionId?.trim() || "";

    if (!normalizedSessionId || thread.conversationOrchestratorSessionId === normalizedSessionId) {
      return;
    }

    await this.store.writeThread(workspacePath, {
      ...thread,
      conversationOrchestratorSessionId: normalizedSessionId,
      conversationOrchestratorUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  private async persistAutomationPlannerSessionId(
    workspacePath: string,
    session: AutomationSessionRecord,
    plannerSessionId: string | null
  ) {
    const normalizedSessionId = plannerSessionId?.trim() || "";

    if (!normalizedSessionId || session.plannerSessionId === normalizedSessionId) {
      return session;
    }

    const nextSession: AutomationSessionRecord = {
      ...session,
      plannerSessionId: normalizedSessionId,
      plannerUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await this.store.writeAutomationSession(workspacePath, nextSession);
    return nextSession;
  }

  private async runSerializedOrchestratorTurn<T>(
    workspacePath: string,
    scopeKey: string,
    task: () => Promise<T>
  ) {
    const key = `${workspacePath}::${scopeKey}`;
    const previous = this.orchestratorTurnLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous
      .catch(() => undefined)
      .then(() => current);

    this.orchestratorTurnLocks.set(key, chained);

    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      release();
      void chained.finally(() => {
        if (this.orchestratorTurnLocks.get(key) === chained) {
          this.orchestratorTurnLocks.delete(key);
        }
      });
    }
  }

  private async runOrchestratorWorkerTurn(
    input: {
      workspacePath: string;
      activeThread: ThreadRecord;
      prompt: string;
      normalizedPrompt: string;
    },
    delegation: Extract<OrchestratorDelegationDirective, { lane: "builder" | "strategist" }>,
    options: {
      strategistSessionReady?: boolean;
    } = {}
  ) {
    const progressOperationId = delegation.lane;

    if (delegation.lane === "strategist") {
      this.setChatProgress(input.workspacePath, {
        lane: "strategist",
        threadId: input.activeThread.id,
        progressSummary: "Researching…",
        progressDetails: ["Collecting the judgment needed before replying in chat."],
        activeCommand: null,
        operationId: progressOperationId
      });

      return {
        lane: delegation.lane,
        delegation,
        startedLiveRun: false,
        snapshot: await this.consultStrategist(
          {
            workspacePath: input.workspacePath,
            threadId: input.activeThread.id,
            prompt: delegation.prompt,
            displayPrompt: input.prompt,
            model: delegation.model,
            reasoningIntensity: delegation.reasoningIntensity,
            attachExplicitWorkspaceFiles: delegation.attachExplicitWorkspaceFiles
          },
          {
            ...options,
            progressOperationId
          }
        )
      };
    }

    if (delegation.executionMode === "live") {
      this.setChatProgress(input.workspacePath, {
        lane: "builder",
        threadId: input.activeThread.id,
        progressSummary: "Starting…",
        progressDetails: ["Launching a live workspace run under the orchestrator."],
        activeCommand: null,
        operationId: progressOperationId
      });

      return {
        lane: delegation.lane,
        delegation,
        startedLiveRun: true,
        snapshot: await this.startBuilderTask(
          {
            workspacePath: input.workspacePath,
            threadId: input.activeThread.id,
            prompt: delegation.prompt,
            displayPrompt: input.prompt,
            model: delegation.model,
            reasoningEffort: delegation.reasoningEffort
          },
          {
            progressOperationId
          }
        )
      };
    }

    this.setChatProgress(input.workspacePath, {
      lane: "builder",
      threadId: input.activeThread.id,
      progressSummary: "Working…",
      progressDetails: ["Running the concrete workspace step before replying in chat."],
      activeCommand: null,
      operationId: progressOperationId
    });

    return {
      lane: delegation.lane,
      delegation,
      startedLiveRun: false,
      snapshot: await this.runBuilderTask(
        {
          workspacePath: input.workspacePath,
          threadId: input.activeThread.id,
          prompt: delegation.prompt,
          displayPrompt: input.prompt,
          model: delegation.model,
          reasoningEffort: delegation.reasoningEffort
        },
        {
          progressOperationId
        }
      )
    };
  }

  private async runOrchestratorWorkerTurns(
    input: {
      workspacePath: string;
      activeThread: ThreadRecord;
      prompt: string;
      normalizedPrompt: string;
    },
    delegations: Array<Extract<OrchestratorDelegationDirective, { lane: "builder" | "strategist" }>>,
    options: {
      strategistSessionReady?: boolean;
    } = {}
  ) {
    const results = await Promise.all(
      delegations.map((delegation) => this.runOrchestratorWorkerTurn(input, delegation, options))
    );

    return {
      results,
      startedLiveRun: results.some((result) => result.startedLiveRun),
      snapshot: await this.store.getSnapshot(input.workspacePath)
    };
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

    if (this.orchestratorRunner) {
      return await this.handleConversationOrchestratorMessage(
        {
          workspacePath,
          snapshot,
          activeThread,
          prompt: request.prompt,
          normalizedPrompt
        },
        options
      );
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
        threadId: activeThread.id,
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
            threadId: activeThread.id,
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
            threadId: activeThread.id,
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
      this.clearChatProgress(workspacePath, activeThread.id, "router");
    }
  }

  async consultStrategist(
    request: StrategistRequest,
    options: {
      strategistSessionReady?: boolean;
      manageProgress?: boolean;
      progressOperationId?: string;
    } = {}
  ): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    const manageProgress = options.manageProgress ?? true;
    const progressOperationId = options.progressOperationId?.trim() || "strategist";
    const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
    let progressThreadId = request.threadId?.trim() || "pending-thread";

    if (manageProgress) {
      this.setChatProgress(workspacePath, {
        lane: "strategist",
        threadId: progressThreadId,
        progressSummary: "Thinking…",
        progressDetails: [],
        activeCommand: null,
        operationId: progressOperationId
      });
    }

    try {
      await this.prepareReusableStrategistSession(options.strategistSessionReady);
      if (manageProgress) {
        this.setChatProgress(workspacePath, {
          lane: "strategist",
          threadId: progressThreadId,
          progressSummary: "Thinking…",
          progressDetails: [],
          activeCommand: null,
          operationId: progressOperationId
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
      if (manageProgress && progressThreadId && progressThreadId !== activeThread.id) {
        this.clearChatProgress(workspacePath, progressThreadId, progressOperationId);
      }
      progressThreadId = activeThread.id;
      const decisionPaths = await this.store.allocateDecision(workspacePath);
      const strategistSessionSlug =
        request.sessionSlug?.trim() || buildStrategistOracleSessionId(workspacePath, activeThread.id);
      const activeProgressSlug = this.getLatestChatProgressEntry(
        workspacePath,
        activeThread.id,
        "strategist"
      )?.oracleSessionSlug;
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
          threadId: activeThread.id,
          progressSummary: "Thinking…",
          progressDetails: [],
          activeCommand: null,
          oracleSessionSlug: strategistSessionSlug,
          stdoutPath: decisionPaths.stdoutPath,
          stderrPath: decisionPaths.stderrPath,
          operationId: progressOperationId
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
          threadId: activeThread.id,
          progressSummary: "Finishing…",
          progressDetails: [],
          activeCommand: null,
          oracleSessionSlug: result.sessionId ?? strategistSessionSlug,
          stdoutPath: decisionPaths.stdoutPath,
          stderrPath: decisionPaths.stderrPath,
          operationId: progressOperationId
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
        this.clearChatProgress(workspacePath, progressThreadId || undefined, progressOperationId);
      }
    }
  }

  async runBuilderTask(
    request: BuilderRequest,
    options: {
      manageProgress?: boolean;
      progressOperationId?: string;
    } = {}
  ): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    const manageProgress = options.manageProgress ?? true;
    const progressOperationId = options.progressOperationId?.trim() || "builder";
    let progressThreadId = request.threadId?.trim() || "pending-thread";
    await this.reconcileStaleBuilderRuns(workspacePath);
    try {
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
      progressThreadId = activeThread.id;
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
      if (manageProgress) {
        this.setChatProgress(workspacePath, {
          lane: "builder",
          threadId: activeThread.id,
          progressSummary: "Working…",
          progressDetails: ["Running the concrete workspace step before replying in chat."],
          activeCommand: null,
          stdoutPath: runPaths.stdoutPath,
          stderrPath: runPaths.stderrPath,
          operationId: progressOperationId
        });
      }
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
    } finally {
      if (manageProgress) {
        this.clearChatProgress(workspacePath, progressThreadId || undefined, progressOperationId);
      }
    }
  }

  async startBuilderTask(
    request: BuilderRequest,
    options: {
      manageProgress?: boolean;
      progressOperationId?: string;
    } = {}
  ): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    const manageProgress = options.manageProgress ?? true;
    const progressOperationId = options.progressOperationId?.trim() || "builder";
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
    if (manageProgress) {
      this.setChatProgress(workspacePath, {
        lane: "builder",
        threadId: activeThread.id,
        progressSummary: "Starting…",
        progressDetails: ["Launching a live workspace run under the orchestrator."],
        activeCommand: null,
        stdoutPath: runPaths.stdoutPath,
        stderrPath: runPaths.stderrPath,
        operationId: progressOperationId
      });
    }

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

    const progressEntries = this.listChatProgressEntries(workspacePath, request.threadId);

    if (!progressEntries.length) {
      return null;
    }

    const inspections = await Promise.all(
      progressEntries.map((progress) => this.inspectSingleChatProgressEntry(workspacePath, progress))
    );

    if (inspections.length === 1) {
      return inspections[0];
    }

    return combineParallelChatProgressInspections(inspections);
  }

  private async inspectSingleChatProgressEntry(
    workspacePath: string,
    progress: ActiveChatProgress
  ): Promise<ChatProgressInspection> {
    const [stdoutTail, stderrTail, oracleLogTail, liveOracleProgress, latestTouchedAt] = await Promise.all([
      progress.stdoutPath ? readTailText(progress.stdoutPath) : Promise.resolve(""),
      progress.stderrPath ? readTailText(progress.stderrPath) : Promise.resolve(""),
      progress.oracleSessionSlug ? readOracleSessionTail(progress.oracleSessionSlug) : Promise.resolve(""),
      progress.oracleSessionSlug ? readLiveOracleSessionProgress(progress.oracleSessionSlug) : Promise.resolve(null),
      resolveChatProgressTouchedAt(progress)
    ]);
    const oracleProgress = extractOracleSessionProgress(oracleLogTail);
    const strategistProgress = progress.lane === "strategist";
    const strategistLiveProgress = mergeStrategistLiveProgress(liveOracleProgress, oracleProgress);
    const codexProgress = strategistProgress ? null : parseCodexProgressLog(stdoutTail);
    const hasCodexNarration = Boolean(codexProgress?.progressSummary || codexProgress?.progressDetails.length);
    const progressSummary = strategistProgress
      ? strategistLiveProgress.progressSummary || progress.progressSummary
      : codexProgress?.progressSummary || progress.progressSummary;
    const progressDetails = strategistProgress
      ? strategistLiveProgress.progressDetails
      : mergeProgressDetails(
          codexProgress?.progressDetails ?? [],
          mergeProgressDetails(
            extractProgressTailDetails(stdoutTail, stderrTail),
            hasCodexNarration ? [] : progress.progressDetails
          )
        ).filter((detail) => detail !== progressSummary);

    const inspection = {
      active: true,
      lane: progress.lane,
      threadId: progress.threadId,
      progressSummary,
      progressDetails,
      activeCommand: strategistProgress
        ? progress.activeCommand
        : codexProgress?.activeCommand ?? progress.activeCommand,
      stdoutTail,
      stderrTail,
      updatedAt: latestTouchedAt || progress.updatedAt
    } satisfies ChatProgressInspection;

    this.rememberObservedChatProgress(workspacePath, progress, inspection);

    return inspection;
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

    const runningSteps =
      snapshot.automationSteps
        ?.filter((step) => step.sessionId === session.id && step.status === "running")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)) ?? [];
    const latestStep =
      runningSteps[0] ??
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

    const refreshedRunningSteps =
      refreshedSnapshot.automationSteps
        ?.filter((step) => step.sessionId === refreshedSession.id && step.status === "running")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)) ?? [];
    const refreshedStep =
      refreshedRunningSteps[0] ??
      refreshedSnapshot.automationSteps?.find((step) => step.id === refreshedSession.latestStepId) ??
      refreshedSnapshot.automationSteps?.find((step) => step.sessionId === refreshedSession.id) ??
      null;
    const refreshedRun = refreshedStep?.runId
      ? refreshedSnapshot.runs.find((run) => run.id === refreshedStep.runId) ?? null
      : null;

    if (refreshedRunningSteps.some((step) => step.lane === "builder")) {
      await this.writeRunningAutomationSession(workspacePath, refreshedSession, {
        currentStepSummary:
          refreshedRunningSteps.some((step) => step.lane === "strategist")
            ? "Resuming the in-flight builder and strategist work after Lithium restarted."
            : "Resuming the in-flight builder step after Lithium restarted."
      });
      void this.runAutomationLoop(workspacePath, refreshedSession.id);
      return;
    }

    if (refreshedRunningSteps.some((step) => step.lane === "strategist")) {
      await this.writeRunningAutomationSession(workspacePath, refreshedSession, {
        currentStepSummary: "Resuming the in-flight strategist step after Lithium restarted."
      });
      void this.runAutomationLoop(workspacePath, refreshedSession.id);
      return;
    }

    if (refreshedSession.mode === "continuous") {
      for (const runningStep of refreshedRunningSteps) {
        if (runningStep.lane === "builder" || runningStep.lane === "strategist") {
          continue;
        }

        await this.completeAutomationStep(workspacePath, refreshedSession, runningStep, {
          status: "failed",
          summary: `Automation resumed after Lithium restarted while "${runningStep.title}" was still marked in progress.`,
          changedFiles: [],
          evidence: [runningStep.id]
        });
      }

      await this.writeRunningAutomationSession(workspacePath, refreshedSession, {
        currentStepSummary: "Automation resumed after Lithium restarted."
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
    await this.finalizeAutomationCycle(workspacePath, refreshedSession, refreshedSession.activeCycleId, {
      status: "paused",
      phase: "reporting",
      summary: interruptedSummary
    });

    await this.store.writeAutomationSession(workspacePath, {
      ...refreshedSession,
      status: "idle",
      activeCycleId: undefined,
      activeLaneStepIds: [],
      latestCheckpointId: checkpoint.id,
      currentStepSummary: "Automation was interrupted when Lithium restarted. Waiting for your direction.",
      stopReason: interruptedSummary,
      endedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await this.appendAutomationStatusEntry(workspacePath, {
      session: refreshedSession,
      checkpoint,
      body: buildAutomationCheckpointConversationMessage({
        session: refreshedSession,
        checkpoint
      })
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
      activeLaneStepIds: patch.activeLaneStepIds ?? session.activeLaneStepIds ?? [],
      latestCheckpointId: patch.latestCheckpointId,
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

  private async createAutomationCycle(
    workspacePath: string,
    session: AutomationSessionRecord,
    input: {
      title: string;
      objective: string;
      plannerPrompt: string;
      summary?: string;
      plannerReply?: string;
      plannerSessionId?: string;
    }
  ) {
    const allocation = await this.store.allocateAutomationCycle(workspacePath);
    const now = new Date().toISOString();
    const cycle: AutomationCycleRecord = {
      id: allocation.id,
      sessionId: session.id,
      threadId: session.threadId,
      title: input.title,
      objective: input.objective,
      plannerPrompt: input.plannerPrompt,
      plannerReply: input.plannerReply,
      plannerSessionId: input.plannerSessionId,
      status: "running",
      phase: "planning",
      summary: input.summary ?? input.title,
      laneStates: [],
      activeLaneStepIds: [],
      completedLaneStepIds: [],
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };

    await this.store.writeAutomationCycle(workspacePath, cycle);
    await this.writeRunningAutomationSession(workspacePath, session, {
      latestCycleId: cycle.id,
      activeCycleId: cycle.id,
      activeLaneStepIds: [],
      currentStepSummary: input.summary ?? input.title,
      updatedAt: now
    });

    return cycle;
  }

  private async ensureAutomationCycle(
    workspacePath: string,
    session: AutomationSessionRecord,
    input: {
      title: string;
      objective: string;
      plannerPrompt: string;
      summary?: string;
    }
  ) {
    if (session.activeCycleId) {
      const existing = await this.readAutomationCycle(workspacePath, session.activeCycleId);

      if (existing) {
        return existing;
      }
    }

    return await this.createAutomationCycle(workspacePath, session, input);
  }

  private async readAutomationCycle(workspacePath: string, cycleId: string) {
    const cycles = await this.store.listAutomationCycles(workspacePath);
    return cycles.find((record) => record.id === cycleId) ?? null;
  }

  private async writeAutomationCycle(
    workspacePath: string,
    cycle: AutomationCycleRecord,
    patch: Partial<AutomationCycleRecord>
  ) {
    const nextCycle: AutomationCycleRecord = {
      ...cycle,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };

    await this.store.writeAutomationCycle(workspacePath, nextCycle);
    return nextCycle;
  }

  private buildCycleLaneStatesFromDelegations(
    delegations: AutomationWorkerDelegation[]
  ): AutomationCycleLaneState[] {
    const now = new Date().toISOString();

    return delegations.map((delegation) => ({
      lane: delegation.lane,
      title:
        delegation.lane === "builder"
          ? "Run the next builder execution branch"
          : "Run the next strategist research branch",
      status: "pending",
      workerMode:
        delegation.lane === "builder"
          ? delegation.executionMode === "live"
            ? "live"
            : delegation.executionMode === "sync"
            ? "sync"
            : "async"
          : "async",
      summary:
        delegation.lane === "builder"
          ? "Waiting for the next builder branch to start."
          : "Waiting for the next strategist branch to start.",
      updatedAt: now
    }));
  }

  private async updateAutomationCycleLaneState(
    workspacePath: string,
    cycleId: string | undefined,
    lane: AutomationStepRecord["lane"],
    patch: Partial<AutomationCycleLaneState>
  ) {
    if (!cycleId) {
      return null;
    }

    const cycle = await this.readAutomationCycle(workspacePath, cycleId);

    if (!cycle) {
      return null;
    }

    const laneStates = cycle.laneStates.slice();
    const index = laneStates.findIndex((entry) => entry.lane === lane);
    const baseState: AutomationCycleLaneState =
      index >= 0
        ? laneStates[index]
        : {
            lane,
            title: patch.title ?? lane,
            status: "pending",
            workerMode: patch.workerMode ?? "async",
            summary: patch.summary ?? "",
            updatedAt: new Date().toISOString()
          };
    const nextState: AutomationCycleLaneState = {
      ...baseState,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };

    if (index >= 0) {
      laneStates[index] = nextState;
    } else {
      laneStates.push(nextState);
    }

    return await this.writeAutomationCycle(workspacePath, cycle, { laneStates });
  }

  private async finalizeAutomationCycle(
    workspacePath: string,
    session: AutomationSessionRecord,
    cycleId: string | undefined,
    input: {
      status: AutomationCycleStatus;
      phase?: AutomationCyclePhase;
      summary: string;
    }
  ) {
    if (!cycleId) {
      return null;
    }

    const cycle = await this.readAutomationCycle(workspacePath, cycleId);

    if (!cycle) {
      return null;
    }

    const completedAt =
      input.status === "completed" || input.status === "failed" || input.status === "paused"
        ? new Date().toISOString()
        : cycle.completedAt;
    const nextCycle = await this.writeAutomationCycle(workspacePath, cycle, {
      status: input.status,
      phase: input.phase ?? cycle.phase,
      summary: input.summary,
      completedAt
    });

    if (session.activeCycleId === cycleId && input.status !== "running") {
      await this.store.writeAutomationSession(workspacePath, {
        ...session,
        activeCycleId: undefined,
        activeLaneStepIds: [],
        updatedAt: new Date().toISOString()
      });
    }

    return nextCycle;
  }

  private buildAutomationStepIdempotencyKey(
    session: AutomationSessionRecord,
    input: {
      cycleId?: string;
      kind: AutomationStepKind;
      lane: AutomationStepRecord["lane"];
      title: string;
      prompt: string;
    }
  ) {
    return createHash("sha1")
      .update(
        [
          session.id,
          input.cycleId ?? "no-cycle",
          input.kind,
          input.lane,
          input.title.trim(),
          input.prompt.trim()
        ].join("\n")
      )
      .digest("hex")
      .slice(0, 20);
  }

  private async listRunningAutomationSteps(
    workspacePath: string,
    sessionId: string,
    lane?: AutomationStepRecord["lane"]
  ) {
    const steps = await this.store.listAutomationSteps(workspacePath);

    return steps
      .filter((step) => step.sessionId === sessionId && step.status === "running")
      .filter((step) => !lane || step.lane === lane)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async findLatestRunningAutomationStep(
    workspacePath: string,
    sessionId: string,
    lane: AutomationStepRecord["lane"]
  ) {
    return (await this.listRunningAutomationSteps(workspacePath, sessionId, lane))[0] ?? null;
  }

  private async findRecoverableAutomationStep(
    workspacePath: string,
    session: AutomationSessionRecord,
    lane: AutomationStepRecord["lane"]
  ) {
    const runningSteps = await this.listRunningAutomationSteps(workspacePath, session.id, lane);
    const activeIds = new Set(session.activeLaneStepIds ?? []);
    const activeCycleId = session.activeCycleId?.trim() || "";

    return (
      runningSteps.find(
        (step) =>
          activeIds.has(step.id) ||
          (activeCycleId && step.cycleId === activeCycleId)
      ) ??
      runningSteps[0] ??
      null
    );
  }

  private async resumeInFlightAutomationBuilderStep(
    workspacePath: string,
    session: AutomationSessionRecord,
    controller: AutomationControllerState
  ) {
    const builderStep = await this.findRecoverableAutomationStep(workspacePath, session, "builder");

    const runId = builderStep?.runId ?? builderStep?.resumeCursor ?? "";

    if (!builderStep || builderStep.status !== "running" || builderStep.lane !== "builder" || !runId) {
      return {
        handled: false,
        shouldStopLoop: false
      };
    }

    const run = await this.store.readRun(workspacePath, runId).catch(() => null);

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

  private async resumeInFlightAutomationStrategistStep(
    workspacePath: string,
    session: AutomationSessionRecord,
    controller: AutomationControllerState
  ) {
    const strategistStep = await this.findRecoverableAutomationStep(workspacePath, session, "strategist");

    if (!strategistStep || strategistStep.status !== "running" || strategistStep.lane !== "strategist") {
      return {
        handled: false,
        shouldStopLoop: false
      };
    }

    const strategistSlug =
      strategistStep.resumeCursor?.trim() ||
      buildAutomationStrategistSessionSlug(workspacePath, session, null, strategistStep);

    if (!/resuming the in-flight strategist step/i.test(session.currentStepSummary)) {
      await this.writeRunningAutomationSession(workspacePath, session, {
        currentStepSummary: "Resuming the in-flight strategist step after Lithium restarted."
      });
    }

    const activeOracleProcess = await inspectActiveOracleProcessBySlug(strategistSlug);

    if (activeOracleProcess) {
      controller.activeStrategistSlug = strategistSlug;

      try {
        const recoveredDecision = await this.waitForRecoveredStrategistDecision(
          workspacePath,
          session,
          strategistStep,
          controller,
          strategistSlug,
          activeOracleProcess
        );

        if (recoveredDecision) {
          await this.completeAutomationStep(workspacePath, session, strategistStep, {
            status: "completed",
            summary: recoveredDecision.summary || "Recovered the interrupted strategist step.",
            decisionId: recoveredDecision.id,
            changedFiles: [],
            evidence: recoveredDecision.summary ? [recoveredDecision.summary] : []
          });

          return {
            handled: true,
            shouldStopLoop: false
          };
        }
      } finally {
        controller.activeStrategistSlug = null;
      }
    }

    await this.completeAutomationStep(workspacePath, session, strategistStep, {
      status: "cancelled",
      summary: "Step started.",
      changedFiles: [],
      evidence: []
    });

    const recoveryInstruction =
      session.queuedUserInstruction?.trim() ||
      buildInterruptedStrategistRecoveryInstruction(session, strategistStep);
    controller.redirectInstruction = recoveryInstruction;

    await this.writeRunningAutomationSession(workspacePath, session, {
      currentStepSummary: "Retrying the interrupted strategist step after Lithium restarted."
    });

    return {
      handled: true,
      shouldStopLoop: false
    };
  }

  private async runAutomationOrchestratorCycle(
    workspacePath: string,
    session: AutomationSessionRecord,
    controller: AutomationControllerState,
    snapshot: ProjectSnapshot,
    redirectInstruction: string,
    appSettings: AppSettings
  ) {
    if (!this.orchestratorRunner) {
      return {
        handled: false,
        shouldStopLoop: false
      };
    }

    const activeThread =
      snapshot.threads.find((thread) => thread.id === session.threadId) ??
      snapshot.activeThread;

    if (!activeThread) {
      return {
        handled: false,
        shouldStopLoop: false
      };
    }

    const requestPaths = this.buildAutomationPlannerRequestPaths(workspacePath, session.id);
    const planningPrompt = buildAutomationOrchestratorPrompt({
      session,
      redirectInstruction,
      languagePreference: appSettings.autopilotPromptLanguage,
      snapshot
    });
    const cycle = await this.createAutomationCycle(workspacePath, session, {
      title: "Plan and launch the next bounded automation cycle",
      objective: redirectInstruction || session.displayObjective || session.objective,
      plannerPrompt: planningPrompt,
      plannerSessionId: session.plannerSessionId,
      summary: "Choosing the next bounded automation cycle."
    });
    const planningStep = await this.createAutomationStep(workspacePath, session, {
      cycleId: cycle.id,
      kind: "strategize",
      lane: "controller",
      workerMode: "sync",
      title: "Plan and launch the next bounded automation cycle",
      prompt: planningPrompt
    });
    const requestDir = path.dirname(requestPaths.builder);

    this.setChatProgress(workspacePath, {
      lane: "orchestrator",
      threadId: activeThread.id,
      progressSummary: "Planning…",
      progressDetails: ["Choosing the next bounded automation move and whether to fan work out in parallel."],
      activeCommand: null,
      stdoutPath: path.join(requestDir, "orchestrator.automation.stdout.log"),
      stderrPath: path.join(requestDir, "orchestrator.automation.stderr.log"),
      operationId: "automation-orchestrator"
    });

    let planningTurn: Awaited<ReturnType<NonNullable<typeof this.orchestratorRunner>["runTurn"]>>;

    try {
      const planningContext = await this.store.buildRuntimeContext(workspacePath, planningPrompt, {
        lane: "builder"
      });
      planningTurn = await this.runSerializedOrchestratorTurn(
        workspacePath,
        `planner:${session.id}`,
        async () =>
          await this.orchestratorRunner!.runTurn({
            workspacePath,
            sessionId: session.plannerSessionId,
            prompt: planningPrompt,
            runtimeContext: planningContext.content,
            stdoutPath: path.join(requestDir, "orchestrator.automation.stdout.log"),
            stderrPath: path.join(requestDir, "orchestrator.automation.stderr.log"),
            outputPath: path.join(requestDir, "orchestrator.automation.reply.md"),
            requestPaths,
            hostKey: `planner:${session.id}`,
            model: appSettings.builderModel === "gpt-5.3-codex" ? "gpt-5.4" : appSettings.builderModel,
            reasoningEffort: "xhigh"
          })
      );
    } finally {
      this.clearChatProgress(workspacePath, activeThread.id, "automation-orchestrator");
    }

    let activeSession = await this.requireAutomationSession(workspacePath, session.id);
    activeSession = await this.persistAutomationPlannerSessionId(
      workspacePath,
      activeSession,
      planningTurn.sessionId
    );

    const planningReply = sanitizeConversationBody(planningTurn.finalMessage);
    const delegations = resolveOrchestratorDelegations(
      planningTurn,
      redirectInstruction.trim() || session.objective
    );
    const automationDelegation = delegations.find(
      (delegation): delegation is Extract<OrchestratorDelegationDirective, { lane: "automation" }> =>
        delegation.lane === "automation"
    );
    const workerDelegations = delegations.filter(
      (delegation): delegation is AutomationWorkerDelegation =>
        delegation.lane === "builder" || delegation.lane === "strategist"
    );

    const plannerSummary =
      planningReply ||
      summarizeAutomationPlannerResult(workerDelegations, automationDelegation) ||
      "The automation planner did not launch a concrete worker step.";

    await this.completeAutomationStep(workspacePath, activeSession, planningStep, {
      status: automationDelegation || workerDelegations.length ? "completed" : "failed",
      summary: plannerSummary,
      changedFiles: [],
      evidence: planningReply ? [planningReply] : []
    });
    await this.writeAutomationCycle(workspacePath, cycle, {
      plannerReply: planningReply || undefined,
      plannerSessionId: activeSession.plannerSessionId,
      summary: plannerSummary,
      phase: workerDelegations.length ? "workers" : "planning",
      laneStates: this.buildCycleLaneStatesFromDelegations(workerDelegations)
    });

    if (controller.redirectInstruction.trim() === redirectInstruction) {
      controller.redirectInstruction = "";
    }

    if (redirectInstruction && activeSession.queuedUserInstruction?.trim() === redirectInstruction) {
      activeSession = await this.writeRunningAutomationSession(workspacePath, activeSession, {
        queuedUserInstruction: undefined
      });
    }

    if (automationDelegation && !workerDelegations.length) {
      const pauseSummary =
        planningReply ||
        automationDelegation.prompt.trim() ||
        "Automation paused because the planner identified a true review boundary.";

      await this.appendAutomationAssistantEntry(workspacePath, {
        session: activeSession,
        body: pauseSummary,
        cycleId: cycle.id,
        stepId: planningStep.id
      });
      await this.syncThreadFromArtifacts(workspacePath, activeThread, {
        prompt: redirectInstruction || activeSession.displayObjective || activeSession.objective,
        summary: pauseSummary
      });
      await this.finalizeAutomationCycle(workspacePath, activeSession, cycle.id, {
        status: "paused",
        phase: "reporting",
        summary: pauseSummary
      });
      await this.pauseAutomationWithCheckpoint(workspacePath, {
        session: activeSession,
        title:
          "Checkpoint ready",
        summary: pauseSummary,
        whatChanged: [],
        evidence: [],
        risks: ["The planner identified a review boundary that needs attention."],
        nextActions: [
          automationDelegation.prompt.trim() || "Review the planner note and choose the next direction."
        ],
        currentStepSummary: "Waiting for your direction.",
        stopReason: pauseSummary
      });
      return {
        handled: true,
        shouldStopLoop: true
      };
    }

    if (!workerDelegations.length) {
      await this.finalizeAutomationCycle(workspacePath, activeSession, cycle.id, {
        status: "failed",
        phase: "planning",
        summary: plannerSummary
      });
      return {
        handled: false,
        shouldStopLoop: false
      };
    }

    activeSession = await this.writeRunningAutomationSession(workspacePath, activeSession, {
      latestCycleId: cycle.id,
      activeCycleId: cycle.id,
      currentStepSummary: summarizeAutomationDelegationCycle(
        workerDelegations,
        redirectInstruction || activeSession.displayObjective || activeSession.objective
      )
    });

    const workerTurn = await this.runAutomationDelegatedWorkerTurns(
      workspacePath,
      activeSession,
      cycle,
      controller,
      workerDelegations,
      redirectInstruction,
      appSettings
    );
    const refreshedSnapshot = workerTurn.snapshot;
    const refreshedThread =
      refreshedSnapshot.threads.find((thread) => thread.id === activeThread.id) ?? activeThread;
    const followupPrompt = buildAutomationOrchestratorFollowupPrompt({
      objective: redirectInstruction || activeSession.displayObjective || activeSession.objective,
      delegations: workerDelegations,
      snapshot: refreshedSnapshot
    });

    this.setChatProgress(workspacePath, {
      lane: "orchestrator",
      threadId: refreshedThread.id,
      progressSummary: "Reporting…",
      progressDetails: ["Turning the latest worker results into a short automation update for chat."],
      activeCommand: null,
      stdoutPath: path.join(requestDir, "orchestrator.automation.followup.stdout.log"),
      stderrPath: path.join(requestDir, "orchestrator.automation.followup.stderr.log"),
      operationId: "automation-orchestrator"
    });

    let followupTurn: Awaited<ReturnType<NonNullable<typeof this.orchestratorRunner>["runTurn"]>>;

    try {
      const followupContext = await this.store.buildRuntimeContext(workspacePath, followupPrompt, {
        lane: "builder"
      });
      followupTurn = await this.runSerializedOrchestratorTurn(
        workspacePath,
        `planner:${session.id}`,
        async () =>
          await this.orchestratorRunner!.runTurn({
            workspacePath,
            sessionId:
              activeSession.plannerSessionId ||
              planningTurn.sessionId ||
              session.plannerSessionId,
            prompt: followupPrompt,
            runtimeContext: followupContext.content,
            stdoutPath: path.join(requestDir, "orchestrator.automation.followup.stdout.log"),
            stderrPath: path.join(requestDir, "orchestrator.automation.followup.stderr.log"),
            outputPath: path.join(requestDir, "orchestrator.automation.followup.reply.md"),
            requestPaths,
            hostKey: `planner:${session.id}`,
            model: appSettings.builderModel === "gpt-5.3-codex" ? "gpt-5.4" : appSettings.builderModel,
            reasoningEffort: "xhigh"
          })
      );
    } finally {
      this.clearChatProgress(workspacePath, refreshedThread.id, "automation-orchestrator");
    }

    activeSession = await this.persistAutomationPlannerSessionId(
      workspacePath,
      activeSession,
      followupTurn.sessionId
    );

    const followupReply =
      sanitizeConversationBody(followupTurn.finalMessage) ||
      summarizeWorkerSnapshotsForConversation(workerDelegations, refreshedSnapshot);
    const relatedDecisionId = workerTurn.results.some((result) => result.lane === "strategist")
      ? refreshedSnapshot.latestDecision?.id
      : undefined;
    const relatedRunId = workerTurn.results.some((result) => result.lane === "builder")
      ? refreshedSnapshot.latestRun?.id
      : undefined;

    await this.appendAutomationAssistantEntry(workspacePath, {
      session: activeSession,
      body: followupReply,
      decisionId: relatedDecisionId,
      runId: relatedRunId,
      cycleId: cycle.id
    });
    await this.syncThreadFromArtifacts(workspacePath, refreshedThread, {
      prompt: redirectInstruction || activeSession.displayObjective || activeSession.objective,
      summary: followupReply
    });
    await this.store.appendActivity(
      workspacePath,
      `${session.id} automation completed an orchestrated ${describeDelegationSetForActivity(workerDelegations)} cycle`
    );

    const builderResult = workerTurn.results.find(
      (result): result is AutomationDelegatedBuilderResult => result.lane === "builder"
    );

    if (builderResult) {
      const resumedSession = await this.requireAutomationSession(workspacePath, session.id);
      const shouldStopLoop = await this.applyAutomationBuilderOutcome(workspacePath, {
        session: resumedSession,
        cycle,
        controller,
        builderStep: builderResult.step,
        latestDecision: refreshedSnapshot.latestDecision,
        latestRun: builderResult.latestRun,
        redirectInstruction,
        runStatus: builderResult.runStatus,
        runSummary: builderResult.runSummary,
        runChangedFiles: builderResult.runChangedFiles,
        runEvidence: builderResult.runEvidence,
        runRisks: builderResult.runRisks,
        runActions: builderResult.runActions
      });

      return {
        handled: true,
        shouldStopLoop
      };
    }

    const resumedSession = await this.requireAutomationSession(workspacePath, session.id);
    const nextUsedSteps = resumedSession.budget.usedSteps + 1;

    if (controller.pauseRequested || resumedSession.mode === "checkpoint") {
      await this.finalizeAutomationCycle(workspacePath, resumedSession, cycle.id, {
        status: "paused",
        phase: "reporting",
        summary:
          refreshedSnapshot.latestDecision?.summary ||
          followupReply ||
          "The latest strategist cycle finished."
      });
      await this.pauseAutomationWithCheckpoint(workspacePath, {
        session: resumedSession,
        title: controller.pauseRequested ? "Automation paused after the latest step" : "Checkpoint ready",
        summary:
          refreshedSnapshot.latestDecision?.summary ||
          followupReply ||
          "The latest strategist cycle finished.",
        whatChanged: [],
        evidence: refreshedSnapshot.latestDecision?.summary ? [refreshedSnapshot.latestDecision.summary] : [],
        risks: refreshedSnapshot.latestDecision?.handoff?.risks ?? [],
        nextActions:
          refreshedSnapshot.latestDecision?.handoff?.runActions?.length ||
          refreshedSnapshot.latestDecision?.handoff?.openQuestions?.length
            ? [
                ...(refreshedSnapshot.latestDecision?.handoff?.runActions ?? []),
                ...(refreshedSnapshot.latestDecision?.handoff?.openQuestions ?? [])
              ]
            : ["Review the latest research update and continue the next bounded step."],
        currentStepSummary:
          controller.pauseRequested
            ? "Stopped after finishing the current step."
            : "Waiting for your direction.",
        budget: {
          ...resumedSession.budget,
          usedSteps: nextUsedSteps
        }
      });
      controller.pauseRequested = false;
      controller.stopRequested = false;
      return {
        handled: true,
        shouldStopLoop: true
      };
    }

    await this.finalizeAutomationCycle(workspacePath, resumedSession, cycle.id, {
      status: "completed",
      phase: "reporting",
      summary:
        refreshedSnapshot.latestDecision?.summary ||
        followupReply ||
        "The latest automation cycle finished."
    });
    await this.writeRunningAutomationSession(workspacePath, resumedSession, {
      currentStepSummary: "Continuing after the latest strategist guidance.",
      budget: {
        ...resumedSession.budget,
        usedSteps: nextUsedSteps
      }
    });
    await this.store.updateSessionSummary(workspacePath);

    return {
      handled: true,
      shouldStopLoop: false
    };
  }

  private async runAutomationDelegatedWorkerTurns(
    workspacePath: string,
    session: AutomationSessionRecord,
    cycle: AutomationCycleRecord,
    controller: AutomationControllerState,
    delegations: AutomationWorkerDelegation[],
    redirectInstruction: string,
    appSettings: AppSettings
  ) {
    const results = await Promise.all(
      delegations.map((delegation) =>
        this.runAutomationDelegatedWorkerTurn(
          workspacePath,
          session,
          cycle,
          controller,
          delegation,
          redirectInstruction,
          appSettings
        )
      )
    );

    return {
      results,
      snapshot: await this.store.getSnapshot(workspacePath)
    };
  }

  private async startAutomationStrategistLane(
    workspacePath: string,
    session: AutomationSessionRecord,
    cycle: AutomationCycleRecord,
    strategistStep: AutomationStepRecord,
    delegation: Extract<AutomationWorkerDelegation, { lane: "strategist" }>,
    displayPrompt: string,
    appSettings: AppSettings,
    progressOperationId: string
  ) {
    const project = await this.store.initProject(workspacePath, {
      name: await this.resolveProjectName(workspacePath)
    });
    await this.store.selectThread(workspacePath, session.threadId);
    const snapshot = await this.store.getSnapshot(workspacePath);
    const activeThread =
      snapshot.threads.find((thread) => thread.id === session.threadId) ?? snapshot.activeThread;

    if (!activeThread) {
      throw new Error("No active thread is available.");
    }

    const decisionPaths = await this.store.allocateDecision(workspacePath);
    const strategistSlug = buildAutomationStrategistSessionSlug(
      workspacePath,
      session,
      cycle,
      strategistStep
    );
    const strategistContextFingerprint = buildStrategistContextFingerprint(snapshot);
    const strategistContext = await this.prepareModelContext({
      workspacePath,
      prompt: delegation.prompt,
      lane: "strategist",
      snapshot,
      artifactId: decisionPaths.id
    });
    const attachStrategistRuntimeContext = shouldAttachStrategistRuntimeContext(
      snapshot,
      strategistContextFingerprint
    );
    const workspaceFiles = await this.store.listWorkspaceFiles(workspacePath);
    const explicitlyMentionedWorkspaceFiles =
      delegation.attachExplicitWorkspaceFiles === false
        ? []
        : resolveExplicitStrategistWorkspaceFiles(delegation.prompt, workspacePath, workspaceFiles);
    const strategistAttachments = snapshot.activeThreadAttachments
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
    const strategistModel = delegation.model ?? project.oracleModel;
    const strategistReasoningIntensity = coerceStrategistThinkingTime(
      strategistModel,
      delegation.reasoningIntensity ?? appSettings.strategistReasoningIntensity
    );

    await this.store.appendPromptLog(workspacePath, {
      kind: "strategist.request",
      threadId: activeThread.id,
      prompt: delegation.prompt,
      displayPrompt: `[Autopilot] ${displayPrompt}`,
      model: strategistModel,
      reasoningIntensity: strategistReasoningIntensity,
      oracleSessionSlug: strategistSlug,
      files: strategistFiles,
      runtimeContext: strategistContext.runtimeContext,
      contextPackPath: strategistContext.contextPackPath
    });

    this.setChatProgress(workspacePath, {
      lane: "strategist",
      threadId: activeThread.id,
      progressSummary: "Researching…",
      progressDetails: ["Keeping a longer strategist branch running in the background."],
      activeCommand: null,
      oracleSessionSlug: strategistSlug,
      stdoutPath: decisionPaths.stdoutPath,
      stderrPath: decisionPaths.stderrPath,
      operationId: progressOperationId
    });

    if (!this.oracleRunner.startConsult) {
      throw new Error("Async strategist execution requires oracle startConsult support.");
    }

    const started = await this.oracleRunner.startConsult({
      workspacePath,
      prompt: delegation.prompt,
      model: strategistModel,
      browserThinkingTime: strategistReasoningIntensity,
      files: strategistFiles,
      stdoutPath: decisionPaths.stdoutPath,
      stderrPath: decisionPaths.stderrPath,
      outputPath: decisionPaths.outputPath,
      slug: strategistSlug,
      strategistSessionReady: appSettings.strategistSessionReady
    });

    if (started.chromePath) {
      await this.store.initProject(workspacePath, {
        name: await this.resolveProjectName(workspacePath),
        oracleChromePath: started.chromePath
      });
    }

    const updatedStep: AutomationStepRecord = {
      ...strategistStep,
      resumeCursor: strategistSlug,
      startedSideEffects: Array.from(
        new Set(
          [
            ...(strategistStep.startedSideEffects ?? []),
            `oracle-session:${strategistSlug}`,
            `decision-artifacts:${decisionPaths.id}`
          ].filter(Boolean)
        )
      ),
      updatedAt: new Date().toISOString()
    };
    await this.store.writeAutomationStep(workspacePath, updatedStep);
    await this.updateAutomationCycleLaneState(workspacePath, cycle.id, strategistStep.lane, {
      stepId: strategistStep.id,
      workerMode: "async",
      summary: "Strategist research is running in the background.",
      resumeCursor: strategistSlug,
      updatedAt: updatedStep.updatedAt
    });
    await this.store.appendActivity(
      workspacePath,
      `${session.id} started async strategist lane ${strategistStep.id} (${strategistSlug})`
    );

    return {
      step: updatedStep,
      strategistSlug
    };
  }

  private async runAutomationDelegatedWorkerTurn(
    workspacePath: string,
    session: AutomationSessionRecord,
    cycle: AutomationCycleRecord,
    controller: AutomationControllerState,
    delegation: AutomationWorkerDelegation,
    redirectInstruction: string,
    appSettings: AppSettings
  ): Promise<AutomationDelegatedWorkerResult> {
    const displayPrompt = redirectInstruction || session.displayObjective || session.objective;
    const progressOperationId = `automation-${delegation.lane}`;

    if (delegation.lane === "strategist") {
      let strategistStep = await this.createAutomationStep(workspacePath, session, {
        cycleId: cycle.id,
        kind: "literature-search",
        lane: "strategist",
        workerMode: "async",
        title: "Run the next strategist research branch",
        prompt: delegation.prompt
      });
      const strategistDisplayPrompt = `[Autopilot] ${displayPrompt}`;
      const strategistSlug = buildAutomationStrategistSessionSlug(workspacePath, session, cycle, strategistStep);
      let strategistSnapshot: ProjectSnapshot;

      strategistStep = {
        ...strategistStep,
        resumeCursor: strategistSlug,
        startedSideEffects: [`oracle-session:${strategistSlug}`],
        updatedAt: new Date().toISOString()
      };
      await this.store.writeAutomationStep(workspacePath, strategistStep);
      await this.updateAutomationCycleLaneState(workspacePath, cycle.id, strategistStep.lane, {
        resumeCursor: strategistSlug,
        updatedAt: strategistStep.updatedAt
      });

      controller.activeStrategistSlug = strategistSlug;

      try {
        strategistSnapshot = await this.consultStrategist(
          {
            workspacePath,
            threadId: session.threadId,
            prompt: delegation.prompt,
            displayPrompt: strategistDisplayPrompt,
            attachExplicitWorkspaceFiles: delegation.attachExplicitWorkspaceFiles,
            sessionSlug: strategistSlug,
            model: delegation.model,
            reasoningIntensity: delegation.reasoningIntensity
          },
          {
            strategistSessionReady: appSettings.strategistSessionReady,
            progressOperationId
          }
        );
      } finally {
        controller.activeStrategistSlug = null;
      }

      const decision = strategistSnapshot.latestDecision ?? null;

      await this.completeAutomationStep(workspacePath, session, strategistStep, {
        status: decision ? "completed" : "failed",
        summary: decision?.summary || "The strategist branch did not return a concrete summary.",
        resumeCursor: strategistSlug,
        completedSideEffects: decision?.id ? [`decision:${decision.id}`] : [],
        decisionId: decision?.id,
        changedFiles: [],
        evidence: decision?.summary ? [decision.summary] : []
      });

      return {
        lane: delegation.lane,
        delegation,
        step: strategistStep,
        decision
      };
    }

    let builderStep = await this.createAutomationStep(workspacePath, session, {
      cycleId: cycle.id,
      kind: inferAutomationBuilderStepKind(delegation.prompt),
      lane: "builder",
      workerMode:
        delegation.executionMode === "live"
          ? "live"
          : delegation.executionMode === "sync"
          ? "sync"
          : "async",
      title: "Run the next builder execution branch",
      prompt: delegation.prompt
    });
    let latestRun: RunRecord | null = null;
    let runStatus: RecordStatus = "failed";
    let runSummary = "";
    let runChangedFiles: string[] = [];
    let runEvidence: string[] = [];
    let runRisks: string[] = [];
    let runActions: string[] = [];

    try {
      const builderRequest = {
        workspacePath,
        threadId: session.threadId,
        prompt: delegation.prompt,
        displayPrompt: `[autopilot] ${displayPrompt}`,
        model: delegation.model,
        reasoningEffort: delegation.reasoningEffort
      } satisfies BuilderRequest;

      const builderSnapshot =
        delegation.executionMode === "sync"
          ? await this.runBuilderTask(builderRequest, {
              progressOperationId
            })
          : await this.startBuilderTask(builderRequest, {
              progressOperationId
            });
      const runId = builderSnapshot.latestRun?.id ?? null;
      if (runId) {
        builderStep = {
          ...builderStep,
          runId,
          resumeCursor: runId,
          startedSideEffects: [`run:${runId}`],
          updatedAt: new Date().toISOString()
        };
        await this.store.writeAutomationStep(workspacePath, builderStep);
        await this.updateAutomationCycleLaneState(workspacePath, cycle.id, builderStep.lane, {
          resumeCursor: runId,
          updatedAt: builderStep.updatedAt
        });
      }
      const completedSnapshot =
        delegation.executionMode === "sync"
          ? builderSnapshot
          : runId
          ? ((controller.activeRunId = runId),
            await this.waitForAutomationRun(workspacePath, runId, controller))
          : await this.store.getSnapshot(workspacePath);

      controller.activeRunId = null;
      latestRun =
        (runId
          ? completedSnapshot.runs.find((record) => record.id === runId)
          : completedSnapshot.latestRun) ??
        (completedSnapshot.latestRun?.id === runId ? completedSnapshot.latestRun : null);
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
      runActions = [];
    }

    return {
      lane: delegation.lane,
      delegation,
      step: builderStep,
      latestRun,
      runStatus,
      runSummary,
      runChangedFiles,
      runEvidence,
      runRisks,
      runActions
    };
  }

  private async applyAutomationBuilderOutcome(
    workspacePath: string,
    input: {
      session: AutomationSessionRecord;
      cycle?: AutomationCycleRecord | null;
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
      cycle,
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
      await this.completeAutomationStep(workspacePath, session, builderStep, {
        status: "cancelled",
        summary: "Stopped by the user.",
        completedSideEffects: latestRun?.id ? [`run:${latestRun.id}`] : [],
        runId: latestRun?.id,
        changedFiles: [],
        evidence: []
      });
      await this.finalizeAutomationCycle(workspacePath, session, cycle?.id ?? builderStep.cycleId, {
        status: "failed",
        phase: "reporting",
        summary: "Stopped by the user."
      });
      return true;
    }

    await this.completeAutomationStep(workspacePath, session, builderStep, {
      status:
        runStatus === "completed"
          ? "completed"
          : runStatus === "cancelled"
          ? "cancelled"
          : "failed",
      summary: runSummary || "Builder run finished without a usable summary.",
      completedSideEffects: latestRun?.id ? [`run:${latestRun.id}`] : [],
      runId: latestRun?.id,
      changedFiles: runChangedFiles,
      evidence: runEvidence
    });

    if (session.paperWriteEnabled && runStatus === "completed") {
      const paperStep = await this.createAutomationStep(workspacePath, session, {
        cycleId: cycle?.id ?? builderStep.cycleId,
        kind: "paper-sync",
        lane: "writer",
        workerMode: "sync",
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

      await this.completeAutomationStep(workspacePath, session, paperStep, {
        status: "completed",
        summary: paperSummary,
        completedSideEffects: manuscriptSnapshot.manuscript ? [`manuscript:${manuscriptSnapshot.manuscript.path}`] : [],
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
    const pauseRequested = controller.pauseRequested || session.mode === "checkpoint";
    const requiresReviewBranch = runFailed && (retryBudgetExhausted || requiresUserCheckpoint);

    if (runFailed && !pauseRequested && !requiresReviewBranch) {
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

    if (requiresReviewBranch && session.mode === "continuous") {
      const continuation = await this.consultAutomationContinuationAdvisor(workspacePath, {
        session,
        reason: "failed-run",
        latestDecision,
        latestRun,
        redirectInstruction,
        runStatus,
        runSummary,
        runRisks,
        runActions
      });

      if (continuation.shouldPause) {
        await this.finalizeAutomationCycle(workspacePath, session, cycle?.id ?? builderStep.cycleId, {
          status: "paused",
          phase: "reporting",
          summary:
            continuation.decision?.summary ||
            continuation.userMessage ||
            runSummary ||
            latestDecision?.summary ||
            "The latest automation cycle finished."
        });
        await this.pauseAutomationWithCheckpoint(workspacePath, {
          session,
          title: "Automation needs review after a failed run",
          summary:
            continuation.decision?.summary ||
            continuation.userMessage ||
            runSummary ||
            latestDecision?.summary ||
            "The latest automation cycle finished.",
          whatChanged: runChangedFiles,
          evidence: runEvidence,
          risks: [
            ...(latestDecision?.handoff?.risks ?? []),
            ...(continuation.decision?.handoff?.risks ?? []),
            ...runRisks
          ],
          nextActions:
            continuation.decision?.handoff?.runActions?.length ||
            continuation.decision?.handoff?.openQuestions?.length ||
            runActions.length ||
            latestDecision?.handoff?.runActions.length
              ? [
                  ...(continuation.decision?.handoff?.runActions ?? []),
                  ...(continuation.decision?.handoff?.openQuestions ?? []),
                  ...(latestDecision?.handoff?.runActions ?? []),
                  ...runActions
                ]
              : [continuation.decision?.summary || "Review the latest research note and decide the next move."],
          currentStepSummary: "Waiting for your direction.",
          budget: {
            ...session.budget,
            usedSteps: nextUsedSteps,
            usedRetries: nextUsedRetries
          }
        });
        controller.pauseRequested = false;
        controller.stopRequested = false;
        return true;
      }

      await this.continueAutomationAfterAdvisor(workspacePath, {
        sessionId: session.id,
        fallbackSession: session,
        decision: continuation.decision,
        userMessage: continuation.userMessage,
        currentStepSummaryFallback: runFailed
          ? `Recovering after ${latestRun?.id ?? "the latest failed cycle"}.`
          : `Continuing after ${latestRun?.id ?? "the latest cycle"}.`,
        budget: {
          ...session.budget,
          usedSteps: nextUsedSteps,
          usedRetries: 0
        }
      });
      await this.finalizeAutomationCycle(workspacePath, session, cycle?.id ?? builderStep.cycleId, {
        status: runFailed ? "failed" : "completed",
        phase: "reporting",
        summary: runSummary || latestDecision?.summary || "Continuing after the latest automation cycle."
      });
      controller.pauseRequested = false;
      controller.stopRequested = false;
      return false;
    }

    if (pauseRequested) {
      await this.finalizeAutomationCycle(workspacePath, session, cycle?.id ?? builderStep.cycleId, {
        status: "paused",
        phase: "reporting",
        summary: runSummary || latestDecision?.summary || "The latest automation cycle finished."
      });
      await this.pauseAutomationWithCheckpoint(workspacePath, {
        session,
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
                ...(latestDecision?.handoff?.runActions ?? []),
                ...runActions
              ]
            : latestDecision?.handoff?.openQuestions?.length
            ? latestDecision.handoff.openQuestions
            : [latestDecision?.summary || "Review the latest research note and decide the next move."],
        currentStepSummary:
          controller.pauseRequested
            ? "Stopped after finishing the current step."
            : "Waiting for your direction.",
        budget: {
          ...session.budget,
          usedSteps: nextUsedSteps,
          usedRetries: nextUsedRetries
        }
      });
      controller.pauseRequested = false;
      controller.stopRequested = false;
      return true;
    }

    await this.finalizeAutomationCycle(workspacePath, session, cycle?.id ?? builderStep.cycleId, {
      status: runFailed ? "failed" : "completed",
      phase: "reporting",
      summary: runSummary || latestDecision?.summary || "The latest automation cycle finished."
    });
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

  private async consultAutomationContinuationAdvisor(
    workspacePath: string,
    input: {
      session: AutomationSessionRecord;
      reason: "failed-run" | "runtime-budget" | "step-budget" | "controller-failure";
      latestDecision?: DecisionRecord | null;
      latestRun?: RunRecord | null;
      latestCheckpoint?: AutomationCheckpointRecord | null;
      redirectInstruction?: string;
      runStatus?: RecordStatus;
      runSummary?: string;
      runRisks?: string[];
      runActions?: string[];
      failureMessage?: string;
    }
  ) {
    const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
    const cycle = await this.ensureAutomationCycle(workspacePath, input.session, {
      title: "Resolve the next branch and keep automation moving",
      objective: input.redirectInstruction?.trim() || input.session.displayObjective || input.session.objective,
      plannerPrompt: buildAutomationContinuationAdvisorPrompt({
        session: input.session,
        reason: input.reason,
        languagePreference: appSettings.autopilotPromptLanguage,
        latestDecision: input.latestDecision,
        latestRun: input.latestRun,
        latestCheckpoint: input.latestCheckpoint,
        redirectInstruction: input.redirectInstruction ?? "",
        runStatus: input.runStatus,
        runSummary: input.runSummary ?? "",
        runRisks: input.runRisks ?? [],
        runActions: input.runActions ?? [],
        failureMessage: input.failureMessage ?? ""
      }),
      summary: "Resolving the next automation branch."
    });
    const strategizeStep = await this.createAutomationStep(workspacePath, input.session, {
      cycleId: cycle.id,
      kind: "strategize",
      lane: "strategist",
      workerMode: "async",
      title: "Resolve the next branch and keep automation moving",
      prompt: cycle.plannerPrompt
    });
    const strategistSessionSlug = buildAutomationStrategistSessionSlug(
      workspacePath,
      input.session,
      cycle,
      strategizeStep
    );
    const strategistDisplayPrompt = `[Autopilot] ${input.session.displayObjective ?? input.session.objective}`;
    let strategistSnapshot: ProjectSnapshot;

    await this.store.writeAutomationStep(workspacePath, {
      ...strategizeStep,
      resumeCursor: strategistSessionSlug,
      startedSideEffects: [`oracle-session:${strategistSessionSlug}`],
      updatedAt: new Date().toISOString()
    });

    this.getAutomationController(workspacePath, input.session.id).activeStrategistSlug = strategistSessionSlug;

    try {
      strategistSnapshot = await this.consultStrategist(
        {
          workspacePath,
          threadId: input.session.threadId,
          prompt: strategizeStep.prompt,
          displayPrompt: strategistDisplayPrompt,
          attachExplicitWorkspaceFiles: false,
          sessionSlug: strategistSessionSlug,
          model: "gpt-5.4-pro",
          reasoningIntensity: "heavy"
        },
        {
          strategistSessionReady: appSettings.strategistSessionReady
        }
      );
    } finally {
      this.getAutomationController(workspacePath, input.session.id).activeStrategistSlug = null;
    }

    const decision = strategistSnapshot.latestDecision ?? null;

    await this.completeAutomationStep(workspacePath, input.session, strategizeStep, {
      status: decision ? "completed" : "failed",
      summary: decision?.summary || "The automation advisor did not return a concrete summary.",
      resumeCursor: strategistSessionSlug,
      completedSideEffects: decision?.id ? [`decision:${decision.id}`] : [],
      decisionId: decision?.id,
      changedFiles: [],
      evidence: decision?.summary ? [decision.summary] : []
    });

    return {
      decision,
      userMessage: resolveAutomationAdvisorUserMessage(
        input.session,
        decision,
        buildAutomationAdvisorFallbackMessage(input.session, input.reason)
      ),
      shouldPause: shouldRequireAutomationCheckpoint({
        decision,
        run: null
      })
    };
  }

  private async continueAutomationAfterAdvisor(
    workspacePath: string,
    input: {
      sessionId: string;
      fallbackSession: AutomationSessionRecord;
      decision: DecisionRecord | null;
      userMessage: string;
      currentStepSummaryFallback: string;
      budget?: AutomationSessionRecord["budget"];
      startedAt?: string;
    }
  ) {
    const session =
      (await this.store.readAutomationSession(workspacePath, input.sessionId).catch(() => null)) ??
      input.fallbackSession;
    const currentStepSummary =
      summarizeAutomationAdvisorCurrentStep(input.decision) || input.currentStepSummaryFallback;

    await this.writeRunningAutomationSession(workspacePath, session, {
      latestCheckpointId: undefined,
      currentStepSummary,
      budget: input.budget ?? session.budget,
      startedAt: input.startedAt ?? session.startedAt
    });

    if (input.userMessage.trim()) {
      await this.appendAutomationStatusEntry(workspacePath, {
        session,
        body: input.userMessage
      });
    }

    await this.store.updateSessionSummary(workspacePath);
  }

  private async pauseAutomationWithCheckpoint(
    workspacePath: string,
    input: {
      session: AutomationSessionRecord;
      title: string;
      summary: string;
      whatChanged: string[];
      evidence: string[];
      risks: string[];
      nextActions: string[];
      currentStepSummary: string;
      stopReason?: string;
      budget?: AutomationSessionRecord["budget"];
    }
  ) {
    const checkpoint = await this.createAutomationCheckpoint(workspacePath, input.session, {
      title: input.title,
      summary: input.summary,
      whatChanged: input.whatChanged,
      evidence: input.evidence,
      risks: input.risks,
      nextActions: input.nextActions
    });
    await this.finalizeAutomationCycle(workspacePath, input.session, input.session.activeCycleId, {
      status: "paused",
      phase: "reporting",
      summary: input.summary
    });

    await this.store.writeAutomationSession(workspacePath, {
      ...input.session,
      status: "idle",
      activeCycleId: undefined,
      activeLaneStepIds: [],
      latestCheckpointId: checkpoint.id,
      currentStepSummary: input.currentStepSummary,
      stopReason: input.stopReason,
      budget: input.budget ?? input.session.budget,
      endedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await this.appendAutomationStatusEntry(workspacePath, {
      session: input.session,
      checkpoint,
      cycleId: input.session.activeCycleId,
      body: buildAutomationCheckpointConversationMessage({
        session: input.session,
        checkpoint
      })
    });
    await this.store.updateSessionSummary(workspacePath);
    return checkpoint;
  }

  private async waitForRecoveredStrategistDecision(
    workspacePath: string,
    session: AutomationSessionRecord,
    strategistStep: AutomationStepRecord,
    controller: AutomationControllerState,
    strategistSlug: string,
    oracleProcess: ActiveOracleProcess
  ) {
    const artifacts = deriveDecisionArtifactsFromOutputPath(oracleProcess.outputPath);

    if (!artifacts) {
      return null;
    }

    while (true) {
      if (controller.stopRequested) {
        await this.oracleRunner.terminateSession?.(strategistSlug).catch(() => undefined);
        return null;
      }

      const strategistOutput = await readTextFile(artifacts.outputPath).catch(() => "");
      const strategistOutputIssue = describeIncompleteStrategistOutput(strategistOutput);

      if (strategistOutput.trim() && !strategistOutputIssue) {
        const existingDecision = await this.store.readDecision(workspacePath, artifacts.id).catch(() => null);

        if (existingDecision) {
          return existingDecision;
        }

        const snapshot = await this.store.getSnapshot(workspacePath);
        const activeThread =
          snapshot.threads.find((thread) => thread.id === session.threadId) ?? snapshot.activeThread;

        if (!activeThread) {
          throw new Error("No active thread is available.");
        }

        const strategistModel = oracleProcess.model ?? snapshot.project?.oracleModel ?? "gpt-5.4";
        const decision = this.buildDecisionRecord({
          id: artifacts.id,
          threadId: session.threadId,
          prompt: strategistStep.prompt,
          displayPrompt: `[Autopilot] ${session.displayObjective ?? session.objective}`,
          inputFiles: oracleProcess.files,
          model: strategistModel,
          rawOutput: strategistOutput,
          command: oracleProcess.command,
          stdoutPath: artifacts.stdoutPath,
          stderrPath: artifacts.stderrPath,
          outputPath: artifacts.outputPath,
          contextPackPath: undefined,
          startedAt: strategistStep.createdAt,
          exitCode: 0
        });

        await this.store.writeDecision(workspacePath, decision);
        await this.store.appendPromptLog(workspacePath, {
          kind: "strategist.response",
          threadId: session.threadId,
          decisionId: decision.id,
          model: strategistModel,
          oracleSessionSlug: strategistSlug,
          summary: decision.summary,
          rationale: decision.rationale,
          rawOutput: decision.rawOutput
        });
        await this.syncThreadFromArtifacts(workspacePath, activeThread, {
          prompt: session.displayObjective ?? session.objective,
          summary: handoffUserMessage(decision.handoff) || decision.summary
        });
        await this.store.appendActivity(workspacePath, `${decision.id} saved as research context`);
        await this.store.updateSessionSummary(workspacePath);
        return decision;
      }

      if (!(await isProcessAlive(oracleProcess.pid))) {
        break;
      }

      await sleep(900);
    }

    const strategistOutput = await readTextFile(artifacts.outputPath).catch(() => "");
    const strategistOutputIssue = describeIncompleteStrategistOutput(strategistOutput);

    if (!strategistOutput.trim() || strategistOutputIssue) {
      return null;
    }

    const existingDecision = await this.store.readDecision(workspacePath, artifacts.id).catch(() => null);
    if (existingDecision) {
      return existingDecision;
    }

    const snapshot = await this.store.getSnapshot(workspacePath);
    const activeThread =
      snapshot.threads.find((thread) => thread.id === session.threadId) ?? snapshot.activeThread;

    if (!activeThread) {
      throw new Error("No active thread is available.");
    }

    const strategistModel = oracleProcess.model ?? snapshot.project?.oracleModel ?? "gpt-5.4";
    const decision = this.buildDecisionRecord({
      id: artifacts.id,
      threadId: session.threadId,
      prompt: strategistStep.prompt,
      displayPrompt: `[Autopilot] ${session.displayObjective ?? session.objective}`,
      inputFiles: oracleProcess.files,
      model: strategistModel,
      rawOutput: strategistOutput,
      command: oracleProcess.command,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      outputPath: artifacts.outputPath,
      contextPackPath: undefined,
      startedAt: strategistStep.createdAt,
      exitCode: 0
    });

    await this.store.writeDecision(workspacePath, decision);
    await this.store.appendPromptLog(workspacePath, {
      kind: "strategist.response",
      threadId: session.threadId,
      decisionId: decision.id,
      model: strategistModel,
      oracleSessionSlug: strategistSlug,
      summary: decision.summary,
      rationale: decision.rationale,
      rawOutput: decision.rawOutput
    });
    await this.syncThreadFromArtifacts(workspacePath, activeThread, {
      prompt: session.displayObjective ?? session.objective,
      summary: handoffUserMessage(decision.handoff) || decision.summary
    });
    await this.store.appendActivity(workspacePath, `${decision.id} saved as research context`);
    await this.store.updateSessionSummary(workspacePath);
    return decision;
  }

  private async runAutomationLoop(workspacePath: string, sessionId: string) {
    const controller = this.getAutomationController(workspacePath, sessionId);

    if (controller.running) {
      return;
    }

    controller.running = true;
    let shouldRestartAfterFailure = false;

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
          await this.finalizeAutomationCycle(workspacePath, session, session.activeCycleId, {
            status: "failed",
            phase: "reporting",
            summary: "Interrupted by the user."
          });
          await this.store.writeAutomationSession(workspacePath, {
            ...session,
            status: "idle",
            activeCycleId: undefined,
            activeLaneStepIds: [],
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

        const resumedStrategistStep = await this.resumeInFlightAutomationStrategistStep(
          workspacePath,
          session,
          controller
        );

        if (resumedStrategistStep.handled) {
          if (resumedStrategistStep.shouldStopLoop) {
            return;
          }

          continue;
        }

        const snapshot = await this.store.getSnapshot(workspacePath);

        if (
          session.startedAt &&
          Date.now() - new Date(session.startedAt).getTime() >
            session.budget.maxRuntimeMinutes * 60 * 1000
        ) {
          if (session.mode === "continuous") {
            const runtimeContinuation = await this.consultAutomationContinuationAdvisor(
              workspacePath,
              {
                session,
                reason: "runtime-budget",
                latestDecision: snapshot.latestDecision,
                latestRun: snapshot.latestRun,
                latestCheckpoint: snapshot.latestAutomationCheckpoint
              }
            );

            if (runtimeContinuation.shouldPause) {
              await this.pauseAutomationWithCheckpoint(workspacePath, {
                session,
                title: "Checkpoint ready",
                summary:
                  runtimeContinuation.decision?.summary ||
                  runtimeContinuation.userMessage ||
                  "Automation paused because it hit the configured runtime limit.",
                whatChanged: [],
                evidence: [],
                risks: runtimeContinuation.decision?.handoff?.risks ?? ["Runtime budget exhausted."],
                nextActions:
                  runtimeContinuation.decision?.handoff?.runActions?.length ||
                  runtimeContinuation.decision?.handoff?.openQuestions?.length
                    ? [
                        ...(runtimeContinuation.decision?.handoff?.runActions ?? []),
                        ...(runtimeContinuation.decision?.handoff?.openQuestions ?? [])
                      ]
                    : ["Review progress and resume with a fresh budget if needed."],
                currentStepSummary: "Waiting for your direction.",
                stopReason:
                  runtimeContinuation.userMessage ||
                  runtimeContinuation.decision?.summary ||
                  "Runtime budget reached."
              });
              return;
            }

            await this.continueAutomationAfterAdvisor(workspacePath, {
              sessionId: session.id,
              fallbackSession: session,
              decision: runtimeContinuation.decision,
              userMessage: runtimeContinuation.userMessage,
              currentStepSummaryFallback: "Continuing after refreshing the runtime budget window.",
              startedAt: new Date().toISOString()
            });
            continue;
          }

          await this.pauseAutomationWithCheckpoint(workspacePath, {
            session,
            title: "Automation time budget reached",
            summary: "Automation paused because it hit the configured runtime limit.",
            whatChanged: [],
            evidence: [],
            risks: ["Runtime budget exhausted."],
            nextActions: ["Review progress and resume with a fresh budget if needed."],
            currentStepSummary: "Runtime budget reached. Waiting for your direction.",
            stopReason: "Runtime budget reached."
          });
          return;
        }

        if (session.budget.usedSteps >= session.budget.maxSteps) {
          if (session.mode === "continuous") {
            const stepContinuation = await this.consultAutomationContinuationAdvisor(
              workspacePath,
              {
                session,
                reason: "step-budget",
                latestDecision: snapshot.latestDecision,
                latestRun: snapshot.latestRun,
                latestCheckpoint: snapshot.latestAutomationCheckpoint
              }
            );

            if (stepContinuation.shouldPause) {
              await this.pauseAutomationWithCheckpoint(workspacePath, {
                session,
                title: "Checkpoint ready",
                summary:
                  stepContinuation.decision?.summary ||
                  stepContinuation.userMessage ||
                  "Automation paused because it used the configured step budget.",
                whatChanged: [],
                evidence: [],
                risks: stepContinuation.decision?.handoff?.risks ?? ["Step budget exhausted."],
                nextActions:
                  stepContinuation.decision?.handoff?.runActions?.length ||
                  stepContinuation.decision?.handoff?.openQuestions?.length
                    ? [
                        ...(stepContinuation.decision?.handoff?.runActions ?? []),
                        ...(stepContinuation.decision?.handoff?.openQuestions ?? [])
                      ]
                    : ["Review progress and resume if you want a longer run."],
                currentStepSummary: "Waiting for your direction.",
                stopReason:
                  stepContinuation.userMessage ||
                  stepContinuation.decision?.summary ||
                  "Step budget reached."
              });
              return;
            }

            await this.continueAutomationAfterAdvisor(workspacePath, {
              sessionId: session.id,
              fallbackSession: session,
              decision: stepContinuation.decision,
              userMessage: stepContinuation.userMessage,
              currentStepSummaryFallback: "Continuing with a fresh step budget window.",
              budget: {
                ...session.budget,
                usedSteps: 0
              }
            });
            continue;
          }

          await this.pauseAutomationWithCheckpoint(workspacePath, {
            session,
            title: "Automation step budget reached",
            summary: "Automation paused because it used the configured step budget.",
            whatChanged: [],
            evidence: [],
            risks: ["Step budget exhausted."],
            nextActions: ["Review progress and resume if you want a longer run."],
            currentStepSummary: "Step budget reached. Waiting for your direction.",
            stopReason: "Step budget reached."
          });
          return;
        }

        const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
        const redirectInstruction =
          controller.redirectInstruction.trim() || session.queuedUserInstruction?.trim() || "";

        const orchestratedCycle = await this.runAutomationOrchestratorCycle(
          workspacePath,
          session,
          controller,
          snapshot,
          redirectInstruction,
          appSettings
        );

        if (orchestratedCycle.handled) {
          if (orchestratedCycle.shouldStopLoop) {
            return;
          }

          continue;
        }

        const legacyCycle = await this.ensureAutomationCycle(workspacePath, session, {
          title: "Fallback legacy automation cycle",
          objective: redirectInstruction || session.displayObjective || session.objective,
          plannerPrompt: redirectInstruction || session.displayObjective || session.objective,
          summary: "Continuing with the fallback automation cycle."
        });

        const shouldConsultStrategist =
          shouldReplanFromRedirectInstruction(redirectInstruction) ||
          !snapshot.latestDecision ||
          shouldReplanAfterFailedRun(
            snapshot.latestRun,
            snapshot.latestAutomationCheckpoint,
            snapshot.latestDecision
          );
        let latestDecision = snapshot.latestDecision;

        if (shouldConsultStrategist) {
          const strategizePrompt = buildAutomationStrategistPrompt(
            session,
            redirectInstruction,
            appSettings.autopilotPromptLanguage,
            snapshot.latestRun,
            snapshot.latestAutomationCheckpoint,
            snapshot.latestDecision
          );
          const strategistDisplayPrompt =
            session.budget.usedSteps === 0
              ? session.displayObjective ?? session.objective
              : redirectInstruction
              ? `[Autopilot] ${redirectInstruction}`
              : `[Autopilot] ${session.displayObjective ?? session.objective}`;
          let strategizeStep = await this.createAutomationStep(workspacePath, session, {
            cycleId: legacyCycle.id,
            kind: "strategize",
            lane: "strategist",
            workerMode: "async",
            title: "Plan the next bounded research step",
            prompt: strategizePrompt
          });
          const strategistSessionSlug = buildAutomationStrategistSessionSlug(
            workspacePath,
            session,
            legacyCycle,
            strategizeStep
          );
          strategizeStep = {
            ...strategizeStep,
            resumeCursor: strategistSessionSlug,
            startedSideEffects: [`oracle-session:${strategistSessionSlug}`],
            updatedAt: new Date().toISOString()
          };
          await this.store.writeAutomationStep(workspacePath, strategizeStep);
          controller.activeStrategistSlug = strategistSessionSlug;
          let strategistSnapshot: ProjectSnapshot;

          try {
            strategistSnapshot = await this.consultStrategist(
              {
                workspacePath,
                threadId: session.threadId,
                prompt: strategizePrompt,
                displayPrompt: strategistDisplayPrompt,
                attachExplicitWorkspaceFiles: false,
                sessionSlug: strategistSessionSlug
              },
              {
                strategistSessionReady: appSettings.strategistSessionReady
              }
            );
          } finally {
            controller.activeStrategistSlug = null;
          }
          latestDecision = strategistSnapshot.latestDecision;

          await this.completeAutomationStep(workspacePath, session, strategizeStep, {
            status: "completed",
            summary:
              latestDecision?.summary || "The strategist did not return a concrete summary.",
            resumeCursor: strategistSessionSlug,
            completedSideEffects: latestDecision?.id ? [`decision:${latestDecision.id}`] : [],
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
        let builderStep = await this.createAutomationStep(workspacePath, session, {
          cycleId: legacyCycle.id,
          kind: inferAutomationBuilderStepKind(builderPrompt),
          lane: "builder",
          workerMode: "async",
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
          if (runId) {
            builderStep = {
              ...builderStep,
              runId,
              resumeCursor: runId,
              startedSideEffects: [`run:${runId}`],
              updatedAt: new Date().toISOString()
            };
            await this.store.writeAutomationStep(workspacePath, builderStep);
          }
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
          cycle: legacyCycle,
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
        if (session.mode === "continuous" && !isStrategistBlockedFailure(failureMessage)) {
          const snapshot = await this.store.getSnapshot(workspacePath).catch(() => null);
          const continuation = await this.consultAutomationContinuationAdvisor(workspacePath, {
            session,
            reason: "controller-failure",
            latestDecision: snapshot?.latestDecision ?? null,
            latestRun: snapshot?.latestRun ?? null,
            latestCheckpoint: snapshot?.latestAutomationCheckpoint ?? null,
            failureMessage
          }).catch(() => null);

          if (continuation && !continuation.shouldPause) {
            await this.continueAutomationAfterAdvisor(workspacePath, {
              sessionId,
              fallbackSession: session,
              decision: continuation.decision,
              userMessage: continuation.userMessage,
              currentStepSummaryFallback: "Recovering after an automation controller issue."
            });
            shouldRestartAfterFailure = true;
            return;
          }
        }

        await this.pauseAutomationWithCheckpoint(workspacePath, {
          session,
          title: failureDetails.title,
          summary: failureDetails.summary,
          whatChanged: [],
          evidence: [],
          risks: [failureMessage],
          nextActions: failureDetails.nextActions,
          currentStepSummary: failureDetails.currentStepSummary,
          stopReason: failureMessage
        });
      }
    } finally {
      controller.running = false;
      controller.activeRunId = null;
      controller.activeStrategistSlug = null;
      if (shouldRestartAfterFailure) {
        void this.runAutomationLoop(workspacePath, sessionId);
      }
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
      cycleId?: string;
      kind: AutomationStepKind;
      lane: AutomationStepRecord["lane"];
      workerMode?: AutomationWorkerMode;
      title: string;
      prompt: string;
      resumeCursor?: string;
    }
  ) {
    const currentSession =
      (await this.store.readAutomationSession(workspacePath, session.id).catch(() => null)) ?? session;
    const allocation = await this.store.allocateAutomationStep(workspacePath);
    const now = new Date().toISOString();
    const step: AutomationStepRecord = {
      id: allocation.id,
      sessionId: currentSession.id,
      threadId: currentSession.threadId,
      cycleId: input.cycleId,
      kind: input.kind,
      lane: input.lane,
      workerMode: input.workerMode,
      title: input.title,
      prompt: input.prompt,
      status: "running",
      summary: "Step started.",
      idempotencyKey: this.buildAutomationStepIdempotencyKey(currentSession, input),
      resumeCursor: input.resumeCursor,
      startedSideEffects: [],
      completedSideEffects: [],
      changedFiles: [],
      evidence: [],
      checkpointRequired: false,
      createdAt: now,
      updatedAt: now
    };

    await this.store.writeAutomationStep(workspacePath, step);
    await this.updateAutomationCycleLaneState(workspacePath, input.cycleId, input.lane, {
      title: input.title,
      status: "running",
      workerMode: input.workerMode ?? "async",
      summary: input.title,
      stepId: step.id,
      idempotencyKey: step.idempotencyKey,
      resumeCursor: input.resumeCursor,
      updatedAt: now
    });
    if (input.cycleId) {
      const currentCycle = await this.readAutomationCycle(workspacePath, input.cycleId);
      if (currentCycle) {
        await this.writeAutomationCycle(workspacePath, currentCycle, {
          activeLaneStepIds: Array.from(new Set([...(currentCycle.activeLaneStepIds ?? []), step.id])),
          completedLaneStepIds: (currentCycle.completedLaneStepIds ?? []).filter((entry) => entry !== step.id),
          phase: input.lane === "controller" ? "planning" : "workers",
          summary: input.title
        });
      }
    }
    await this.writeRunningAutomationSession(workspacePath, currentSession, {
      latestCycleId: input.cycleId ?? currentSession.latestCycleId,
      activeCycleId: input.cycleId ?? currentSession.activeCycleId,
      activeLaneStepIds: Array.from(new Set([...(currentSession.activeLaneStepIds ?? []), step.id])),
      latestStepId: step.id,
      currentStepSummary: input.title,
      updatedAt: now
    });

    return step;
  }

  private async completeAutomationStep(
    workspacePath: string,
    session: AutomationSessionRecord,
    step: AutomationStepRecord,
    input: {
      status: RecordStatus;
      summary: string;
      decisionId?: string;
      runId?: string;
      resumeCursor?: string;
      startedSideEffects?: string[];
      completedSideEffects?: string[];
      changedFiles: string[];
      evidence: string[];
    }
  ) {
    const currentSession =
      (await this.store.readAutomationSession(workspacePath, session.id).catch(() => null)) ?? session;
    const now = new Date().toISOString();
    const nextStep: AutomationStepRecord = {
      ...step,
      status: input.status,
      summary: input.summary,
      resumeCursor: input.resumeCursor ?? step.resumeCursor,
      startedSideEffects: input.startedSideEffects ?? step.startedSideEffects ?? [],
      completedSideEffects: input.completedSideEffects ?? step.completedSideEffects ?? [],
      decisionId: input.decisionId,
      runId: input.runId,
      changedFiles: input.changedFiles,
      evidence: input.evidence,
      checkpointRequired: input.status !== "completed",
      updatedAt: now,
      completedAt: now
    };

    await this.store.writeAutomationStep(workspacePath, nextStep);
    await this.updateAutomationCycleLaneState(workspacePath, step.cycleId, step.lane, {
      status: input.status,
      summary: input.summary,
      stepId: step.id,
      resumeCursor: nextStep.resumeCursor,
      idempotencyKey: nextStep.idempotencyKey,
      updatedAt: now
    });
    if (step.cycleId) {
      const currentCycle = await this.readAutomationCycle(workspacePath, step.cycleId);
      if (currentCycle) {
        await this.writeAutomationCycle(workspacePath, currentCycle, {
          activeLaneStepIds: (currentCycle.activeLaneStepIds ?? []).filter((entry) => entry !== step.id),
          completedLaneStepIds:
            input.status === "completed"
              ? Array.from(new Set([...(currentCycle.completedLaneStepIds ?? []), step.id]))
              : currentCycle.completedLaneStepIds ?? [],
          summary: input.summary
        });
      }
    }
    const nextActiveLaneStepIds = (currentSession.activeLaneStepIds ?? []).filter((entry) => entry !== step.id);
    await this.writeRunningAutomationSession(workspacePath, currentSession, {
      activeLaneStepIds: nextActiveLaneStepIds,
      latestStepId:
        currentSession.latestStepId === step.id
          ? nextActiveLaneStepIds.at(-1)
          : currentSession.latestStepId,
      activeCycleId:
        currentSession.activeCycleId === step.cycleId && nextActiveLaneStepIds.length === 0
          ? undefined
          : currentSession.activeCycleId,
      updatedAt: now
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
    const steps = await this.store.listAutomationSteps(workspacePath);
    const activeIds = new Set(session.activeLaneStepIds ?? []);
    const step =
      steps.find((record) => activeIds.has(record.id) && record.status === "running") ??
      steps.find((record) => record.id === session.latestStepId && record.status === "running") ??
      steps
        .filter((record) => record.sessionId === session.id && record.status === "running")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ??
      null;

    if (!step || step.status !== "running") {
      return;
    }

    await this.completeAutomationStep(workspacePath, session, step, {
      status: "failed",
      summary: failureSummary || "The automation step failed.",
      changedFiles: [],
      evidence: failureSummary ? [failureSummary] : []
    });
  }

  private setChatProgress(
    workspacePath: string,
    input: Omit<ActiveChatProgress, "updatedAt" | "operationId"> & { operationId?: string }
  ) {
    const operationId = input.operationId?.trim() || input.lane;

    this.activeChatProgressByWorkspace.set(this.chatProgressKey(workspacePath, input.threadId, operationId), {
      ...input,
      operationId,
      updatedAt: new Date().toISOString()
    });
  }

  private clearChatProgress(workspacePath: string, threadId?: string, operationId?: string) {
    if (threadId?.trim()) {
      if (operationId?.trim()) {
        this.activeChatProgressByWorkspace.delete(
          this.chatProgressKey(workspacePath, threadId, operationId)
        );
        return;
      }

      const threadPrefix = `${workspacePath}::${threadId}::`;

      for (const key of this.activeChatProgressByWorkspace.keys()) {
        if (key.startsWith(threadPrefix)) {
          this.activeChatProgressByWorkspace.delete(key);
        }
      }
      return;
    }

    const prefix = `${workspacePath}::`;

    for (const key of this.activeChatProgressByWorkspace.keys()) {
      if (key === workspacePath || key.startsWith(prefix)) {
        this.activeChatProgressByWorkspace.delete(key);
      }
    }
  }

  private listChatProgressEntries(workspacePath: string, threadId?: string) {
    if (threadId?.trim()) {
      const threadPrefix = `${workspacePath}::${threadId}::`;
      return Array.from(this.activeChatProgressByWorkspace.entries())
        .filter(([key]) => key.startsWith(threadPrefix))
        .map(([, value]) => value)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    const prefix = `${workspacePath}::`;
    const candidates = Array.from(this.activeChatProgressByWorkspace.entries())
      .filter(([key]) => key === workspacePath || key.startsWith(prefix))
      .map(([, value]) => value)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const latestThreadId = candidates[0]?.threadId;

    if (!latestThreadId) {
      return [];
    }

    return candidates.filter((candidate) => candidate.threadId === latestThreadId);
  }

  private getLatestChatProgressEntry(
    workspacePath: string,
    threadId?: string,
    lane?: ActiveChatProgress["lane"]
  ) {
    const candidates = this.listChatProgressEntries(workspacePath, threadId);

    if (!lane) {
      return candidates[0] ?? null;
    }

    return candidates.find((candidate) => candidate.lane === lane) ?? null;
  }

  private rememberObservedChatProgress(
    workspacePath: string,
    current: ActiveChatProgress,
    inspection: ChatProgressInspection
  ) {
    if (!hasMeaningfulChatProgressNarration(inspection.progressSummary, inspection.progressDetails)) {
      return;
    }

    const key = this.chatProgressKey(workspacePath, current.threadId, current.operationId);
    const nextProgress: ActiveChatProgress = {
      ...current,
      progressSummary: inspection.progressSummary,
      progressDetails: inspection.progressDetails,
      activeCommand: inspection.activeCommand,
      updatedAt: inspection.updatedAt
    };

    if (
      current.progressSummary === nextProgress.progressSummary &&
      current.activeCommand === nextProgress.activeCommand &&
      current.updatedAt === nextProgress.updatedAt &&
      current.progressDetails.length === nextProgress.progressDetails.length &&
      current.progressDetails.every((detail, index) => detail === nextProgress.progressDetails[index])
    ) {
      return;
    }

    this.activeChatProgressByWorkspace.set(key, nextProgress);
  }

  private chatProgressKey(workspacePath: string, threadId: string, operationId: string) {
    return `${workspacePath}::${threadId}::${operationId}`;
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
  const normalized = instruction.trim().toLowerCase().replace(/\s+/g, " ");

  if (!normalized) {
    return false;
  }

  if (/[?？]$/.test(normalized) || normalized.includes("?")) {
    return true;
  }

  if (
    /(?:지금|현재|방금|어디까지|무엇|뭐|뭘|뭐 하고|무슨 상태|한 줄).*(?:알려줘|말해줘|설명해줘|정리해줘)/i.test(
      normalized
    )
  ) {
    return true;
  }

  return /(?:progress|status|update|report|summary|what|why|how|which|where|when|did|does|is it|are we|so far|진행사항|현황|상태|보고|업데이트|요약|왜|어떻게|뭐야|뭐임|뭔가|맞아|맞음|좋아졌|기준삼아|기준으로|된 거|된거|어느 쪽|무슨 근거|무슨 기준|설명해|정리해|비교해)/i.test(
    normalized
  );
}

function looksLikeExplicitAutomationCheckpointPreference(instruction: string) {
  const normalized = instruction.trim().toLowerCase().replace(/\s+/g, " ");

  if (!normalized) {
    return false;
  }

  return (
    /(?:매 단계|단계마다|한 단계마다|스텝마다|매 스텝).*(?:체크포인트|checkpoint|승인|확인|멈춰)/i.test(
      normalized
    ) ||
    /(?:체크포인트|checkpoint)(?:\s*모드|\s*mode)?\s*(?:로|at|for)?\s*(?:멈춰|멈추|stop|pause|review|승인|확인|before continuing|before the next step)/i.test(
      normalized
    ) ||
    /(?:승인받고|승인 받고|확인받고|확인 받고|멈춰서 물어|멈춘 뒤 물어|pause for review|stop for review|ask me before continuing|approval after each step)/i.test(
      normalized
    )
  );
}

function resolveAutomationConversationMode(
  requestedMode: AutomationMode | undefined,
  instruction: string
): AutomationMode {
  if (requestedMode !== "checkpoint") {
    return requestedMode ?? "continuous";
  }

  return looksLikeExplicitAutomationCheckpointPreference(instruction) ? "checkpoint" : "continuous";
}

function sanitizeAutomationConversationSummary(summary: string) {
  const trimmed = summary.trim();

  if (!trimmed) {
    return "";
  }

  if (
    /builder run (?:stalled without producing|ended without writing) a final answer|automation is still running|waiting for your direction|latest strategist result:|latest builder result:/i.test(
      trimmed
    )
  ) {
    return "";
  }

  return trimmed.replace(/\s+/g, " ").trim();
}

function summarizeAutomationNextAction(nextActions: string[]) {
  return nextActions
    .map((action) => action.trim())
    .find(Boolean) ?? "";
}

function buildAutomationCheckpointConversationMessage(input: {
  session: AutomationSessionRecord;
  checkpoint: AutomationCheckpointRecord;
}) {
  const { session, checkpoint } = input;
  const language = resolveAutomationUiLanguage([
    session.displayObjective ?? "",
    session.objective,
    checkpoint.summary,
    checkpoint.title
  ]);
  const summary = sanitizeAutomationConversationSummary(checkpoint.summary);
  const nextAction = summarizeAutomationNextAction(checkpoint.nextActions);

  if (language === "ko") {
    if (/^automation paused after the latest step$/i.test(checkpoint.title)) {
      return [
        "요청대로 현재 단계까지만 마치고 여기서 멈췄습니다.",
        summary ? `마지막 결과는 ${summary}` : "",
        nextAction ? `다음으로는 ${nextAction}` : ""
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (/^checkpoint ready$/i.test(checkpoint.title)) {
      return [
        "한 단계가 끝났고 지금은 여기서 잠시 멈춰 있습니다.",
        summary ? `마지막 결과는 ${summary}` : "",
        nextAction ? `다음으로는 ${nextAction}` : "",
        "이 지점은 사용자 판단이 필요한 분기라고 감지돼 자동으로 멈췄습니다."
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (/needs review after a failed run|automation failed/i.test(checkpoint.title)) {
      return [
        "직전 단계가 실패해서 여기서 멈췄습니다.",
        summary ? `현재까지 정리된 요약은 ${summary}` : "",
        nextAction ? `복구 후보는 ${nextAction}` : "",
        "방향을 정하면 그 기준으로 바로 이어서 진행하겠습니다."
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (/time budget reached/i.test(checkpoint.title)) {
      return [
        "설정된 실행 시간 한도에 닿아서 여기서 잠시 멈췄습니다.",
        summary ? `현재까지 요약은 ${summary}` : "",
        nextAction ? `다음 후보는 ${nextAction}` : ""
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (/step budget reached/i.test(checkpoint.title)) {
      return [
        "설정된 단계 수 한도에 닿아서 여기서 잠시 멈췄습니다.",
        summary ? `현재까지 요약은 ${summary}` : "",
        nextAction ? `다음 후보는 ${nextAction}` : ""
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (/interrupted after app restart/i.test(checkpoint.title)) {
      return [
        "앱 재시작 때문에 자동 연구가 잠깐 끊겨 여기서 멈췄습니다.",
        summary ? `보존된 마지막 상태는 ${summary}` : "",
        nextAction ? `다음으로는 ${nextAction}` : ""
      ]
        .filter(Boolean)
        .join(" ");
    }

    return [
      "자동 연구가 여기서 잠시 멈춰 있습니다.",
      summary ? `현재까지 요약은 ${summary}` : "",
      nextAction ? `다음 후보는 ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/^automation paused after the latest step$/i.test(checkpoint.title)) {
    return [
      "Paused here after finishing the current step, as requested.",
      summary ? `Latest result: ${summary}` : "",
      nextAction ? `Likely next action: ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/^checkpoint ready$/i.test(checkpoint.title)) {
    return [
      "Finished one bounded step and paused here.",
      summary ? `Latest result: ${summary}` : "",
      nextAction ? `Likely next action: ${nextAction}` : "",
      "Lithium stopped because this point looked like a real decision branch."
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/needs review after a failed run|automation failed/i.test(checkpoint.title)) {
    return [
      "Paused here because the latest step failed.",
      summary ? `Current summary: ${summary}` : "",
      nextAction ? `Recovery candidate: ${nextAction}` : "",
      "Once you steer the direction, Lithium can continue from there."
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/time budget reached/i.test(checkpoint.title)) {
    return [
      "Paused here because the configured runtime budget was exhausted.",
      summary ? `Current summary: ${summary}` : "",
      nextAction ? `Likely next action: ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/step budget reached/i.test(checkpoint.title)) {
    return [
      "Paused here because the configured step budget was exhausted.",
      summary ? `Current summary: ${summary}` : "",
      nextAction ? `Likely next action: ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/interrupted after app restart/i.test(checkpoint.title)) {
    return [
      "Paused here because the app restarted mid-run.",
      summary ? `Latest saved state: ${summary}` : "",
      nextAction ? `Likely next action: ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    "Automation is paused here.",
    summary ? `Current summary: ${summary}` : "",
    nextAction ? `Likely next action: ${nextAction}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function buildAutomationResumeConversationMessage(input: {
  session: AutomationSessionRecord;
  checkpoint: AutomationCheckpointRecord;
  response?: string;
  mode: AutomationMode;
}) {
  const language = resolveAutomationUiLanguage([
    input.response ?? "",
    input.session.displayObjective ?? "",
    input.session.objective,
    input.checkpoint.summary
  ]);

  if (language === "ko") {
    return input.mode === "continuous"
      ? "방금 방향을 반영했고 자동 연구를 다시 이어갑니다. 이제 routine step에서는 멈추지 않고, 정말 판단이 필요한 분기에서만 다시 물어보겠습니다."
      : "방금 방향을 반영했고 자동 연구를 다시 이어갑니다. 다음 체크포인트가 오면 다시 이 채팅에서 바로 알려드리겠습니다.";
  }

  return input.mode === "continuous"
    ? "Applied your latest direction and resumed automation. Routine steps will keep going automatically, and Lithium will only stop again at a real decision branch."
    : "Applied your latest direction and resumed automation. Lithium will report back here again at the next checkpoint.";
}

function hasMeaningfulChatProgressNarration(summary: string, details: string[]) {
  const normalizedSummary = summary.trim();
  const normalizedDetails = details
    .map((detail) => detail.trim())
    .filter(Boolean);

  if (!normalizedSummary && !normalizedDetails.length) {
    return false;
  }

  return !isGenericChatProgressPlaceholder(normalizedSummary, normalizedDetails);
}

function isGenericChatProgressPlaceholder(summary: string, details: string[]) {
  const normalizedSummary = summary.trim();
  const normalizedDetails = details
    .map((detail) => detail.trim())
    .filter(Boolean);

  if (!normalizedSummary) {
    return normalizedDetails.length === 0;
  }

  if (normalizedSummary !== "Thinking…") {
    return false;
  }

  return (
    normalizedDetails.length === 0 ||
    normalizedDetails.every(
      (detail) => detail === "Reviewing the latest thread state and choosing the next move."
    )
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

function buildAutomationContinuationAdvisorPrompt(input: {
  session: AutomationSessionRecord;
  reason: "failed-run" | "runtime-budget" | "step-budget" | "controller-failure";
  languagePreference: AppSettings["autopilotPromptLanguage"];
  latestDecision?: DecisionRecord | null;
  latestRun?: RunRecord | null;
  latestCheckpoint?: AutomationCheckpointRecord | null;
  redirectInstruction: string;
  runStatus?: RecordStatus;
  runSummary: string;
  runRisks: string[];
  runActions: string[];
  failureMessage: string;
}) {
  const latestInstruction =
    input.redirectInstruction.trim() ||
    input.session.displayObjective?.trim() ||
    input.session.objective.trim();
  const latestDecisionSummary =
    handoffMachineSummary(input.latestDecision?.handoff) || input.latestDecision?.summary || "";
  const latestRunSummary =
    handoffMachineSummary(input.latestRun?.handoff) ||
    input.runSummary.trim() ||
    extractRunSummary(input.latestRun?.finalMessage || "");
  const latestCheckpointSummary = input.latestCheckpoint?.summary?.trim() || "";
  const promptLanguage = resolveAutomationPromptLanguage(input.languagePreference, [
    latestInstruction,
    latestDecisionSummary,
    latestRunSummary,
    latestCheckpointSummary,
    input.failureMessage
  ]);

  const issueSummary =
    input.reason === "failed-run"
      ? input.runStatus === "cancelled"
        ? "The latest builder step was cancelled right before completion and hit a review boundary."
        : "The latest builder step failed and hit a review boundary."
      : input.reason === "runtime-budget"
      ? "The configured runtime budget window was exhausted."
      : input.reason === "step-budget"
      ? "The configured step budget was exhausted."
      : `The automation controller hit an issue: ${input.failureMessage.trim() || "unknown failure"}`;
  const issueSummaryKo =
    input.reason === "failed-run"
      ? input.runStatus === "cancelled"
        ? "직전 builder step이 끝나기 직전에 취소되었고, 기존 규칙이라면 여기서 review로 멈출 상황입니다."
        : "직전 builder step이 실패했고, 기존 규칙이라면 여기서 review로 멈출 상황입니다."
      : input.reason === "runtime-budget"
      ? "설정된 실행 시간 한도에 닿았습니다."
      : input.reason === "step-budget"
      ? "설정된 단계 수 한도에 닿았습니다."
      : `자동화 컨트롤러 쪽 이슈가 발생했습니다: ${input.failureMessage.trim() || "원인 미상"}`;

  if (promptLanguage === "ko") {
    return [
      latestInstruction,
      issueSummaryKo,
      latestDecisionSummary ? `현재 최신 전략 요약: ${latestDecisionSummary}` : "",
      latestRunSummary ? `현재 최신 실행 요약: ${latestRunSummary}` : "",
      latestCheckpointSummary ? `직전 체크포인트 요약: ${latestCheckpointSummary}` : "",
      input.runRisks.length ? formatPromptList("Failure risks", input.runRisks) : "",
      input.runActions.length ? formatPromptList("Suggested next actions", input.runActions) : "",
      "이 자동 연구는 continuous 모드이며, 웬만하면 여기서 멈추지 말고 계속 진행해야 합니다.",
      "지금 상황을 큰 분기로 보고 gpt-5.4-pro 관점에서 다음 방향을 하나 정하세요.",
      "응답의 맨 앞에는 사용자가 읽을 짧은 진행 보고를 같은 언어로 자연스럽게 적고, 그 뒤에는 왜 그 방향이 맞는지와 바로 실행할 다음 bounded step을 정리하세요.",
      "외부 의존성이나 실제 사용자 선호가 없으면 진행 자체가 불가능한 경우에만 다시 물어보세요. 그때만 needs_user_checkpoint=true 또는 automation_mode=checkpoint/blocked를 쓰세요.",
      "그 외에는 자동으로 계속 진행할 수 있게 방향을 고르고, 이 채팅에 보고한 뒤 바로 이어서 실행 가능한 상태로 넘기세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    latestInstruction,
    issueSummary,
    latestDecisionSummary ? `Latest strategy summary: ${latestDecisionSummary}` : "",
    latestRunSummary ? `Latest run summary: ${latestRunSummary}` : "",
    latestCheckpointSummary ? `Latest checkpoint summary: ${latestCheckpointSummary}` : "",
    input.runRisks.length ? formatPromptList("Failure risks", input.runRisks) : "",
    input.runActions.length ? formatPromptList("Suggested next actions", input.runActions) : "",
    "This automation is in continuous mode, so it should keep moving unless there is a truly blocking reason to stop.",
    "Treat the current situation as a major branch and decide the next direction from a gpt-5.4-pro research perspective.",
    "Start your answer with a brief user-facing progress update in the same language as the recent chat, then explain why that direction is right and name the next bounded step that should run immediately.",
    "Only ask the user again if an external dependency or a real preference choice makes progress impossible. Only in that case should you use needs_user_checkpoint=true or automation_mode=checkpoint/blocked.",
    "Otherwise choose a direction that lets automation continue, report it naturally in chat, and hand off the next executable bounded step."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildAutomationOrchestratorPrompt(input: {
  session: AutomationSessionRecord;
  redirectInstruction: string;
  languagePreference: AppSettings["autopilotPromptLanguage"];
  snapshot: ProjectSnapshot;
}) {
  const latestInstruction = input.redirectInstruction.trim() || input.session.objective.trim();
  const latestDecisionSummary = input.snapshot.latestDecision?.summary?.trim() || "";
  const latestRunSummary =
    handoffMachineSummary(input.snapshot.latestRun?.handoff) ||
    extractRunSummary(input.snapshot.latestRun?.finalMessage || "");
  const latestCheckpointSummary = input.snapshot.latestAutomationCheckpoint?.summary?.trim() || "";
  const promptLanguage = resolveAutomationPromptLanguage(input.languagePreference, [
    latestInstruction,
    input.session.displayObjective || "",
    latestDecisionSummary,
    latestRunSummary,
    latestCheckpointSummary
  ]);
  const budgetSummary =
    promptLanguage === "ko"
      ? `현재 예산: steps ${input.session.budget.usedSteps}/${input.session.budget.maxSteps}, retries ${input.session.budget.usedRetries}/${input.session.budget.maxRetries}, runtime ${input.session.budget.maxRuntimeMinutes}분`
      : `Current budget: steps ${input.session.budget.usedSteps}/${input.session.budget.maxSteps}, retries ${input.session.budget.usedRetries}/${input.session.budget.maxRetries}, runtime ${input.session.budget.maxRuntimeMinutes} minutes`;

  if (promptLanguage === "ko") {
    return [
      latestInstruction,
      input.session.displayObjective ? `사용자에게 보이는 목표: ${input.session.displayObjective}` : "",
      budgetSummary,
      latestDecisionSummary ? `최신 전략 요약: ${latestDecisionSummary}` : "",
      latestRunSummary ? `최신 실행 요약: ${latestRunSummary}` : "",
      latestCheckpointSummary ? `직전 체크포인트: ${latestCheckpointSummary}` : "",
      "이 turn은 진행 중인 자동 연구의 다음 bounded cycle을 정하는 planner turn입니다.",
      "가능하면 builder가 바로 시작할 수 있는 실제 workspace step을 포함하세요.",
      "병렬성이 도움이 되면 builder와 strategist를 동시에 요청하세요.",
      "단, strategist-only로 길게 머물지 말고 builder가 바로 할 수 있는 일이 있으면 같이 시작하세요.",
      "사용자에게 보여줄 말은 짧고 자연스럽게 적되, 내부 verbose나 제어 파일 이름은 드러내지 마세요.",
      "정말 진행이 막히는 외부 의존성이나 실제 사용자 선택이 필요한 경우에만 automation lane으로 checkpoint/blocked를 요청하세요.",
      "그 외에는 worker lane만 골라서 자동 연구가 계속 굴러가게 하세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    latestInstruction,
    input.session.displayObjective ? `Visible goal: ${input.session.displayObjective}` : "",
    budgetSummary,
    latestDecisionSummary ? `Latest strategy summary: ${latestDecisionSummary}` : "",
    latestRunSummary ? `Latest run summary: ${latestRunSummary}` : "",
    latestCheckpointSummary ? `Latest checkpoint: ${latestCheckpointSummary}` : "",
    "This turn is for planning the next bounded cycle of an already-running research automation.",
    "Prefer a concrete builder action that can start immediately whenever one exists.",
    "If parallelism helps, request builder and strategist in parallel.",
    "Do not linger in strategist-only mode when the builder can make concrete progress now.",
    "Keep the visible reply short and natural, and do not expose internal verbose or control files.",
    "Only request the automation lane with checkpoint/blocked when an external dependency or a real user choice makes progress impossible.",
    "Otherwise choose worker lanes that keep the automation moving."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildAutomationOrchestratorFollowupPrompt(input: {
  objective: string;
  delegations: AutomationWorkerDelegation[];
  snapshot: ProjectSnapshot;
}) {
  const base =
    input.delegations.length === 1
      ? buildOrchestratorWorkerFollowupPrompt({
          originalPrompt: input.objective,
          lane: input.delegations[0].lane,
          workerPrompt: input.delegations[0].prompt,
          snapshot: input.snapshot
        })
      : buildOrchestratorParallelFollowupPrompt({
          originalPrompt: input.objective,
          delegations: input.delegations,
          snapshot: input.snapshot
        });

  const promptLanguage = containsHangul(input.objective) ? "ko" : "en";

  if (promptLanguage === "ko") {
    return [
      base,
      "이 답변은 ongoing 자동 연구의 짧은 진행 보고입니다.",
      "가능하면 metric, command, log path, artifact path, next action을 짧게 녹여서 알려주세요.",
      "단, raw verbose를 길게 덤프하지는 마세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    base,
    "This reply is a short progress update for an ongoing automation run.",
    "When possible, briefly include the metric, command, log path, artifact path, and next action.",
    "Do not dump raw verbose logs."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function summarizeAutomationPlannerResult(
  workerDelegations: AutomationWorkerDelegation[],
  automationDelegation?: Extract<OrchestratorDelegationDirective, { lane: "automation" }> | null
) {
  if (workerDelegations.length) {
    return summarizeAutomationDelegationCycle(workerDelegations, workerDelegations.map((item) => item.prompt).join("\n"));
  }

  if (!automationDelegation) {
    return "";
  }

  return "The automation planner prepared a checkpoint for review.";
}

function summarizeAutomationDelegationCycle(
  delegations: AutomationWorkerDelegation[],
  languageSample: string
) {
  const uniqueLanes = Array.from(new Set(delegations.map((delegation) => delegation.lane)));
  const isKo = containsHangul(languageSample);

  if (uniqueLanes.includes("builder") && uniqueLanes.includes("strategist")) {
    return isKo
      ? "builder 실행과 strategist 리서치를 병렬로 진행하고 있습니다."
      : "Running builder execution and strategist research in parallel.";
  }

  if (uniqueLanes.includes("builder")) {
    return isKo
      ? "바로 실행 가능한 builder step을 진행하고 있습니다."
      : "Running the next concrete builder step.";
  }

  return isKo
    ? "다음 실행 판단을 위한 strategist 리서치를 진행하고 있습니다."
    : "Running strategist research for the next execution decision.";
}

function buildAutomationStrategistPrompt(
  session: AutomationSessionRecord,
  redirectInstruction: string,
  languagePreference: AppSettings["autopilotPromptLanguage"],
  latestRun?: RunRecord | null,
  latestCheckpoint?: AutomationCheckpointRecord | null,
  latestDecision?: DecisionRecord | null
) {
  const latestInstruction =
    redirectInstruction.trim() ||
    session.objective;

  if (!shouldReplanAfterFailedRun(latestRun, latestCheckpoint, latestDecision)) {
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
  latestCheckpoint?: AutomationCheckpointRecord | null,
  latestDecision?: DecisionRecord | null
) {
  if (!run || (run.status !== "failed" && run.status !== "cancelled")) {
    return false;
  }

  const runTimestamp = run.endedAt || run.startedAt || run.createdAt;

  if (latestDecision && latestDecision.createdAt >= runTimestamp) {
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

function buildAutomationAdvisorFallbackMessage(
  session: AutomationSessionRecord,
  reason: "failed-run" | "runtime-budget" | "step-budget" | "controller-failure"
) {
  const language = resolveAutomationUiLanguage([
    session.displayObjective ?? "",
    session.objective
  ]);

  if (language === "ko") {
    if (reason === "failed-run") {
      return "직전 분기를 다시 검토했고, 그 판단을 반영해 자동 연구를 계속 이어가겠습니다.";
    }

    if (reason === "runtime-budget") {
      return "실행 시간 한도에 닿았지만, 방향을 다시 정리해서 자동 연구를 계속 이어가겠습니다.";
    }

    if (reason === "step-budget") {
      return "단계 수 한도에 닿았지만, 다음 방향을 다시 정리해서 자동 연구를 계속 이어가겠습니다.";
    }

    return "방금 이슈를 다시 검토했고, 복구 방향을 반영해 자동 연구를 계속 이어가겠습니다.";
  }

  if (reason === "failed-run") {
    return "I reviewed the latest branch and will keep automation moving with the updated direction.";
  }

  if (reason === "runtime-budget") {
    return "The runtime window was exhausted, but I refreshed the direction and will keep automation moving.";
  }

  if (reason === "step-budget") {
    return "The step budget was exhausted, but I refreshed the direction and will keep automation moving.";
  }

  return "I reviewed the latest issue and will keep automation moving with the updated recovery path.";
}

function resolveAutomationAdvisorUserMessage(
  session: AutomationSessionRecord,
  decision: DecisionRecord | null,
  fallback: string
) {
  const visibleReply = extractVisibleStrategistReply(decision?.rawOutput ?? "", 900).trim();
  const handoffReply = handoffUserMessage(decision?.handoff)?.trim() || "";
  const summary = sanitizeAutomationConversationSummary(
    handoffMachineSummary(decision?.handoff) || decision?.summary || ""
  );

  return (
    visibleReply ||
    handoffReply ||
    summary ||
    fallback ||
    buildAutomationAdvisorFallbackMessage(session, "controller-failure")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeAutomationAdvisorCurrentStep(decision: DecisionRecord | null) {
  return sanitizeAutomationConversationSummary(
    handoffMachineSummary(decision?.handoff) || decision?.summary || ""
  );
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

type ActiveOracleProcess = {
  pid: number;
  commandLine: string;
  outputPath: string;
  model?: AppSettings["strategistModel"];
  files: string[];
  command: CommandSpec;
};

async function inspectActiveOracleProcessBySlug(sessionSlug: string): Promise<ActiveOracleProcess | null> {
  const psOutput = await execFileText("ps", ["axww", "-o", "pid=,command="]).catch(() => "");

  if (!psOutput.trim()) {
    return null;
  }

  const slugCandidates = Array.from(new Set([sessionSlug, normalizeOracleSessionId(sessionSlug)]));
  const matches = psOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);

      if (!match) {
        return null;
      }

      return {
        pid: Number(match[1]),
        commandLine: match[2]
      };
    })
    .filter((entry): entry is { pid: number; commandLine: string } => Boolean(entry))
    .filter(
      (entry) =>
        entry.commandLine.includes("/oracle") &&
        slugCandidates.some((slug) => entry.commandLine.includes(`--slug ${slug}`))
    );

  const active = matches.at(-1);

  if (!active) {
    return null;
  }

  const outputPathMatch = active.commandLine.match(/--write-output\s+(\S+)/);
  const outputPath = outputPathMatch?.[1]?.trim();

  if (!outputPath) {
    return null;
  }

  const modelMatch = active.commandLine.match(/--model\s+(gpt-5\.4(?:-pro)?)/);
  const fileMatches = Array.from(active.commandLine.matchAll(/--file\s+(\S+)/g)).map((match) => match[1]);

  return {
    pid: active.pid,
    commandLine: active.commandLine,
    outputPath,
    model: isOracleModelValue(modelMatch?.[1]) ? modelMatch?.[1] : undefined,
    files: fileMatches,
    command: {
      command: "oracle",
      args: ["--slug", sessionSlug],
      cwd: path.dirname(path.dirname(outputPath))
    }
  };
}

function deriveDecisionArtifactsFromOutputPath(outputPath: string) {
  const match = outputPath.trim().match(/^(.*\/)?(D\d+)\.output\.txt$/);

  if (!match) {
    return null;
  }

  const directory = match[1] ? match[1].replace(/\/$/, "") : path.dirname(outputPath);
  const id = match[2];

  return {
    id,
    outputPath,
    stdoutPath: path.join(directory, `${id}.stdout.log`),
    stderrPath: path.join(directory, `${id}.stderr.log`)
  };
}

function buildInterruptedStrategistRecoveryInstruction(
  session: AutomationSessionRecord,
  step: AutomationStepRecord
) {
  const language = resolveAutomationUiLanguage([
    session.displayObjective ?? "",
    session.objective,
    session.lastUserInstruction ?? "",
    step.prompt
  ]);
  const basePrompt = session.queuedUserInstruction?.trim() || session.lastUserInstruction?.trim();

  if (language === "ko") {
    return [
      basePrompt || (session.displayObjective ?? session.objective).trim(),
      "앱 재시작으로 방금 진행 중이던 strategist planning step이 끊겼습니다.",
      "사용자에게 멈춰서 묻지 말고, 최신 저장 상태를 기준으로 같은 planning step을 자동으로 다시 만들어 다음 bounded research step 하나를 정한 뒤 계속 진행하세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    basePrompt || (session.displayObjective ?? session.objective).trim(),
    "The in-flight strategist planning step was interrupted by an app restart.",
    "Do not stop for user review. Recreate that planning step from the latest saved workspace state, choose the next bounded research step again, and continue automatically."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildAutomationStrategistSessionSlug(
  workspacePath: string,
  session: AutomationSessionRecord,
  cycle: AutomationCycleRecord | null,
  step: AutomationStepRecord
) {
  const seed = [
    basename(workspacePath).replace(/[^a-z0-9]+/gi, "").toLowerCase().slice(0, 12) || "workspace",
    session.id,
    cycle?.id ?? step.cycleId ?? "nocycle",
    step.id || step.lane
  ].join("-");

  return normalizeOracleSessionId(`ors-auto-${seed}`);
}

function isOracleModelValue(value: string | undefined): value is AppSettings["strategistModel"] {
  return value === "gpt-5.4" || value === "gpt-5.4-pro";
}

function execFileText(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stdout);
    });
  });
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

function buildOrchestratorWorkerFollowupPrompt(input: {
  originalPrompt: string;
  lane: OrchestratorDelegationLane;
  workerPrompt: string;
  snapshot: ProjectSnapshot;
}) {
  const latestDecision = input.snapshot.latestDecision;
  const latestRun = input.snapshot.latestRun;
  const workerSummary =
    input.lane === "strategist"
      ? latestDecision?.summary?.trim() || "none"
      : handoffMachineSummary(latestRun?.handoff) || extractRunSummary(latestRun?.finalMessage || "") || "none";
  const workerReply =
    input.lane === "strategist"
      ? extractVisibleStrategistReply(latestDecision?.rawOutput || "", 800) || handoffUserMessage(latestDecision?.handoff)
      : handoffUserMessage(latestRun?.handoff) || sanitizeConversationBody(latestRun?.finalMessage || "");
  const changedFiles =
    input.lane === "builder" ? latestRun?.changedFiles?.slice(0, 8).join(", ") || "none" : "none";

  return [
    `Original user message: ${input.originalPrompt.trim()}`,
    `You delegated to: ${input.lane}`,
    `Worker task: ${input.workerPrompt.trim()}`,
    `Worker summary: ${workerSummary}`,
    workerReply ? `Worker visible reply:\n${workerReply}` : "",
    input.lane === "builder" ? `Changed files: ${changedFiles}` : "",
    "Now write the user-facing reply for the thread.",
    "Keep it natural and concise in the user's language.",
    "Synthesize the worker result. Do not echo raw verbose logs, control headers, or truncated fragments.",
    "Only delegate again if the answer would be materially incomplete without another concrete step."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildOrchestratorParallelFollowupPrompt(input: {
  originalPrompt: string;
  delegations: Array<Extract<OrchestratorDelegationDirective, { lane: "builder" | "strategist" }>>;
  snapshot: ProjectSnapshot;
}) {
  const sections = input.delegations.map((delegation) => {
    if (delegation.lane === "strategist") {
      const summary = input.snapshot.latestDecision?.summary?.trim() || "none";
      const reply =
        extractVisibleStrategistReply(input.snapshot.latestDecision?.rawOutput || "", 800) ||
        handoffUserMessage(input.snapshot.latestDecision?.handoff);

      return [
        "Worker lane: strategist",
        `Worker task: ${delegation.prompt.trim()}`,
        `Worker summary: ${summary}`,
        reply ? `Worker visible reply:\n${reply}` : ""
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    const summary =
      handoffMachineSummary(input.snapshot.latestRun?.handoff) ||
      extractRunSummary(input.snapshot.latestRun?.finalMessage || "") ||
      "none";
    const reply =
      handoffUserMessage(input.snapshot.latestRun?.handoff) ||
      sanitizeConversationBody(input.snapshot.latestRun?.finalMessage || "");
    const changedFiles = input.snapshot.latestRun?.changedFiles?.slice(0, 8).join(", ") || "none";
    const runStatus = input.snapshot.latestRun?.status || "unknown";

    return [
      "Worker lane: builder",
      `Worker task: ${delegation.prompt.trim()}`,
      `Worker status: ${runStatus}`,
      `Worker summary: ${summary}`,
      reply ? `Worker visible reply:\n${reply}` : "",
      `Changed files: ${changedFiles}`
    ]
      .filter(Boolean)
      .join("\n\n");
  });

  return [
    `Original user message: ${input.originalPrompt.trim()}`,
    "You delegated to multiple workers in parallel.",
    ...sections,
    "Now write the single user-facing reply for the thread.",
    "Keep it natural and concise in the user's language.",
    "Synthesize the worker results together. Make it clear when one lane is still running and another already finished.",
    "Do not echo raw verbose logs, control headers, or truncated fragments.",
    "Only delegate again if the answer would be materially incomplete without another concrete step."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function sanitizeConversationBody(value: string) {
  return value
    .replace(/\n*LITHIUM_STATUS\s*\n[\s\S]*$/i, "")
    .replace(/\n*LITHIUM_HANDOFF\s*\n[\s\S]*$/i, "")
    .replace(/\n\s*[*_`>~-]*입니다\.?[*_`>~-]*\s*(?=\n|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summarizeWorkerSnapshotForConversation(
  lane: OrchestratorDelegationLane,
  snapshot: ProjectSnapshot
) {
  if (lane === "strategist") {
    return (
      extractVisibleStrategistReply(snapshot.latestDecision?.rawOutput || "", 900) ||
      handoffUserMessage(snapshot.latestDecision?.handoff) ||
      snapshot.latestDecision?.summary ||
      "I reviewed the research context and captured the next recommendation."
    );
  }

  return (
    handoffUserMessage(snapshot.latestRun?.handoff) ||
    sanitizeConversationBody(snapshot.latestRun?.finalMessage || "") ||
    handoffMachineSummary(snapshot.latestRun?.handoff) ||
    "I finished the workspace step and recorded the latest result."
  );
}

function summarizeWorkerSnapshotsForConversation(
  delegations: Array<Extract<OrchestratorDelegationDirective, { lane: "builder" | "strategist" }>>,
  snapshot: ProjectSnapshot
) {
  const parts = delegations
    .map((delegation) => summarizeWorkerSnapshotForConversation(delegation.lane, snapshot))
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return "I finished the delegated work and captured the latest state.";
  }

  return Array.from(new Set(parts)).join("\n\n");
}

function describeDelegationSetForActivity(
  delegations: Array<Extract<OrchestratorDelegationDirective, { lane: "builder" | "strategist" }>>
) {
  return delegations
    .map((delegation) => delegation.lane)
    .filter((lane, index, values) => values.indexOf(lane) === index)
    .sort()
    .join("+");
}

function summarizeLiveWorkerStartForConversation(
  delegation: Extract<OrchestratorDelegationDirective, { lane: "builder" }>,
  snapshot: ProjectSnapshot
) {
  const run = snapshot.latestRun;

  if (run?.status === "running") {
    if (containsHangul(delegation.prompt)) {
      return "바로 이어서 live builder 실행을 시작했습니다. 진행 상황과 결과는 이 채팅에서 계속 정리하겠습니다.";
    }

    return "I started the live builder run and will keep the progress and result flowing back into this chat.";
  }

  return summarizeWorkerSnapshotForConversation("builder", snapshot);
}

function localizeAutomationStartReply(prompt: string) {
  if (containsHangul(prompt)) {
    return "이 목표로 자동 연구를 시작하겠습니다. 진행하면서 필요한 상태와 결과를 채팅으로 이어서 보고하겠습니다.";
  }

  return "I’ll start the automation from this goal and continue the status updates here in chat.";
}

function stripLegacyNextTask(handoff: LithiumHandoff) {
  const { nextTask: _legacyNextTask, ...rest } = handoff;
  return rest;
}

function extractVisibleStrategistReply(rawOutput: string, maxChars = 2400) {
  const stripped = rawOutput
    .replace(/\n*LITHIUM_HANDOFF[\s\S]*$/m, "")
    .replace(/\n\s*[*_`>~-]*입니다\.?[*_`>~-]*\s*(?=\n|$)/g, "")
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

function resolveOrchestratorDelegations(
  turn: {
    requestedLane: OrchestratorDelegationLane | null;
    delegatedPrompt: string;
    delegation?: OrchestratorDelegationDirective | null;
    delegations?: OrchestratorDelegationDirective[];
  },
  fallbackPrompt: string
): OrchestratorDelegationDirective[] {
  if (turn.delegations?.length) {
    return dedupeOrchestratorDelegations(turn.delegations);
  }

  if (turn.delegation) {
    return dedupeOrchestratorDelegations([turn.delegation]);
  }

  const prompt = turn.delegatedPrompt?.trim() || fallbackPrompt.trim();

  if (!turn.requestedLane || !prompt) {
    return [];
  }

  if (turn.requestedLane === "builder") {
    return [{
      lane: "builder",
      prompt
    }];
  }

  if (turn.requestedLane === "strategist") {
    return [{
      lane: "strategist",
      prompt
    }];
  }

  return [{
    lane: "automation",
    prompt
  }];
}

function dedupeOrchestratorDelegations(delegations: OrchestratorDelegationDirective[]) {
  const latestByLane = new Map<OrchestratorDelegationDirective["lane"], OrchestratorDelegationDirective>();

  for (const delegation of delegations) {
    latestByLane.set(delegation.lane, delegation);
  }

  const orderedLanes: OrchestratorDelegationDirective["lane"][] = ["automation", "builder", "strategist"];
  return orderedLanes
    .map((lane) => latestByLane.get(lane) ?? null)
    .filter((delegation): delegation is OrchestratorDelegationDirective => Boolean(delegation));
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

function combineParallelChatProgressInspections(inspections: ChatProgressInspection[]): ChatProgressInspection {
  const ordered = [...inspections].sort((left, right) => left.lane.localeCompare(right.lane));
  const combinedText = ordered
    .flatMap((inspection) => [inspection.progressSummary, ...inspection.progressDetails])
    .join("\n");
  const progressSummary = containsHangul(combinedText)
    ? "병렬 작업 진행 중입니다."
    : "Parallel work is in progress.";
  const progressDetails = ordered
    .map((inspection) => formatParallelChatProgressDetail(inspection))
    .filter(Boolean);

  return {
    active: true,
    lane: "orchestrator",
    threadId: ordered[0]?.threadId,
    progressSummary,
    progressDetails,
    activeCommand: null,
    stdoutTail: ordered
      .map((inspection) => inspection.stdoutTail.trim())
      .filter(Boolean)
      .join("\n\n"),
    stderrTail: ordered
      .map((inspection) => inspection.stderrTail.trim())
      .filter(Boolean)
      .join("\n\n"),
    updatedAt: ordered.reduce((latest, inspection) =>
      inspection.updatedAt.localeCompare(latest) > 0 ? inspection.updatedAt : latest,
    ordered[0]?.updatedAt || new Date().toISOString())
  };
}

function formatParallelChatProgressDetail(inspection: ChatProgressInspection) {
  const label = inspection.lane === "builder"
    ? "Builder"
    : inspection.lane === "strategist"
    ? "Strategist"
    : "Worker";
  const lines = Array.from(
    new Set([
      inspection.progressSummary.trim(),
      ...inspection.progressDetails.map((detail) => detail.trim())
    ].filter(Boolean))
  ).slice(0, 3);

  if (!lines.length) {
    return "";
  }

  return `${label}\n${lines.map((line) => `- ${line}`).join("\n")}`;
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

async function resolveChatProgressTouchedAt(progress: ActiveChatProgress) {
  const candidatePaths = [
    progress.stdoutPath,
    progress.stderrPath,
    progress.oracleSessionSlug ? await resolveOracleSessionOutputLogPath(progress.oracleSessionSlug) : ""
  ].filter((value): value is string => Boolean(value));

  const modifiedAts = await Promise.all(
    candidatePaths.map(async (filePath) => {
      try {
        const metadata = await stat(filePath);
        return metadata.mtime.toISOString();
      } catch {
        return "";
      }
    })
  );

  return modifiedAts.filter(Boolean).sort().at(-1) || "";
}

function extractProgressTailDetails(...tails: string[]) {
  return Array.from(
    new Set(
      tails
        .flatMap((text) => text.split("\n"))
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith("{"))
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
    conversationEntries: [],
    latestConversationEntry: null,
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
