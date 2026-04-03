import path, { basename } from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import yauzl from "yauzl";
import {
  getStrategistPerspectiveLabel,
  isBuilderModel,
  isBuilderReasoningEffort,
  normalizeStrategistModel,
  normalizeStrategistThinkingTime
} from "../../shared/model-config";
import type {
  AppSettings,
  AttachmentDeleteRequest,
  AttachmentImportRequest,
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
  ProjectMemoryRecord,
  ProjectSnapshot,
  RecordStatus,
  RouterTraceRecord,
  StrategistRequest,
  ThreadCreateRequest,
  ThreadRecord,
  ThreadSelectionRequest,
  TaskRecord,
  RunRecord
} from "../../shared/types";
import { DEFAULT_APP_SETTINGS } from "../../shared/types";
import {
  handoffMachineSummary,
  handoffUserMessage,
  isOperationalAutomationMessage
} from "../../shared/handoff-utils";
import {
  dedupeNormalizedParagraphs
} from "../../shared/conversation-normalization";
import {
  sanitizePromptEchoProgress,
  stripLeadingPromptEchoParagraph
} from "../../shared/prompt-echo";
import { ProjectStore } from "./project-store";
import {
  OracleRunner,
  normalizeOracleSessionId,
  readOracleSessionError,
  resolveOracleLaunchOptions
} from "./oracle-runner";
import { CodexRunner } from "./codex-runner";
import { parseCodexProgressLog } from "./codex-progress";
import { RouterRunner } from "./router-runner";
import { OrchestratorRunner, type OrchestratorDelegationLane } from "./orchestrator-runner";
import { type OrchestratorDelegationDirective } from "./orchestrator-directives";
import { ChatgptAuthRunner } from "./chatgpt-auth-runner";
import {
  describeIncompleteStrategistOutput,
  extractVisibleBuilderMessage,
  extractVisibleStrategistMessage,
  parseBuilderOutput,
  parseOracleOutput,
} from "./protocol";
import {
  buildAutomationChatFollowupPrompt,
  buildAutomationCheckpointConversationMessage,
  buildAutomationEvidence,
  buildAutomationResumeConversationMessage,
  buildRunningAutomationChatFollowupPrompt,
  containsHangul,
  extractRunSummary,
  humanizeAutomationUiIssue,
  humanizeAutomationUiStepSummary,
  inferAutomationBuilderStepKind,
  isRetryableStrategistControllerFailure,
  isStrategistBlockedFailure,
  isStrategistBrowserBlockedFailure,
  isStrategistBrowserClosedFailure,
  isStrategistLoginRequiredFailure,
  isStrategistSessionExpiredFailure,
  localizeAutomationStartReply,
  resolveAutomationPromptLanguage,
  resolveAutomationUiLanguage,
  sanitizeAutomationConversationSummary,
  stripConversationControlFooters,
  summarizeAutomationNextAction,
  summarizeInterruptedAutomationSession
} from "./automation-text";
import {
  collectGitChangedFiles,
  inferFinalRunStatus,
  inferRunStatus,
  mergeChangedFiles,
  parseChangedFilesFromFinalMessage,
  readTailText,
  readTextFile
} from "./run-artifacts";
import { getLiveProcess, inspectLiveProcessFiles, startLiveProcess, stopLiveProcess } from "./live-process-registry";
import { resolveWorkspaceCommandContext } from "./workspace-execution";
import {
  buildStrategistPromptEnvelope,
  buildStrategistContextFingerprint,
  buildStrategistOracleSessionId,
  isWithinStrategistUploadLimit,
  isSupportedStrategistUploadPath,
  limitStrategistUploadCandidates,
  resolveRecentStrategistAttachmentCandidates,
  resolveRelevantStrategistWorkspaceFiles,
  STRATEGIST_BROWSER_UPLOAD_MAX_FILES
} from "./strategist-context";
import {
  extractOracleSessionProgress,
  hasMeaningfulStrategistProgress,
  mergeStrategistLiveProgress,
  readLiveOracleSessionProgress
} from "./strategist-progress";
import { isProcessAlive, readProcessCommand, terminateProcessTree } from "./process-tree";
import {
  RuntimeRegistry,
  type ActiveChatProgress,
  type AutomationControllerState
} from "./runtime-registry";

type AppServiceDependencies = {
  store?: ProjectStore;
  orchestratorRunner?: Pick<OrchestratorRunner, "runTurn"> | null;
  routerRunner?: Pick<RouterRunner, "route">;
  oracleRunner?: Pick<OracleRunner, "consult"> &
    Partial<Pick<OracleRunner, "startConsult" | "terminateSession">>;
  chatgptAuthRunner?: Pick<ChatgptAuthRunner, "signIn" | "prepareReusableSession">;
  codexRunner?: Pick<CodexRunner, "runTask"> & Partial<Pick<CodexRunner, "buildTaskCommand">>;
  getAppSettings?: () => Promise<AppSettings>;
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

type StrategistUploadPlanCandidate = {
  path: string;
  priority: number;
  label: string;
};

type StrategistUploadPlan = {
  files: string[];
  selectedUploadLines: string[];
  skippedUploadLines: string[];
  skippedPromptNotes: string[];
};

type StrategistSubmission = {
  strategistContextFingerprint: string;
  runtimeContext: string;
  runtimeContextPath: string;
  contextPackPath?: string;
  strategistReferenceDigestPath: string;
  files: string[];
  oraclePrompt: string;
};

const ASYNC_STRATEGIST_POLL_INTERVAL_MS = 5_000;
const ASYNC_STRATEGIST_STALL_MS = 10 * 60 * 1000;
const AUTOMATION_CHAT_ANSWER_TIMEOUT_MS = 10 * 60 * 1000;
const STRATEGIST_ARCHIVE_DIGEST_MAX_ENTRIES = 160;
const STRATEGIST_ARCHIVE_DIGEST_MAX_PREVIEWS = 12;
const STRATEGIST_ARCHIVE_DIGEST_MAX_PREVIEW_BYTES = 24_000;
const STRATEGIST_DEFAULT_DIRECT_UPLOAD_MAX_FILES = 2;
const STRATEGIST_EXPLICIT_DIRECT_UPLOAD_MAX_FILES = 3;

export class AppService {
  private selectedWorkspacePath: string;
  private readonly runtime = new RuntimeRegistry();
  private readonly store: ProjectStore;
  private readonly orchestratorRunner: Pick<OrchestratorRunner, "runTurn"> | null;
  private readonly routerRunner: Pick<RouterRunner, "route">;
  private readonly oracleRunner: Pick<OracleRunner, "consult"> &
    Partial<Pick<OracleRunner, "startConsult" | "terminateSession">>;
  private readonly chatgptAuthRunner: Pick<ChatgptAuthRunner, "signIn" | "prepareReusableSession">;
  private readonly codexRunner: Pick<CodexRunner, "runTask"> & Partial<Pick<CodexRunner, "buildTaskCommand">>;
  private readonly getAppSettings: () => Promise<AppSettings>;

  constructor(workspacePath: string, dependencies: AppServiceDependencies = {}) {
    this.selectedWorkspacePath = workspacePath.trim();
    this.store = dependencies.store ?? new ProjectStore();
    this.orchestratorRunner = dependencies.orchestratorRunner ?? null;
    this.routerRunner = dependencies.routerRunner ?? new RouterRunner();
    this.oracleRunner = dependencies.oracleRunner ?? new OracleRunner();
    this.chatgptAuthRunner = dependencies.chatgptAuthRunner ?? new ChatgptAuthRunner();
    this.codexRunner = dependencies.codexRunner ?? new CodexRunner();
    this.getAppSettings = dependencies.getAppSettings ?? (async () => DEFAULT_APP_SETTINGS);
  }

  setSelectedWorkspacePath(workspacePath: string) {
    const nextWorkspacePath = workspacePath.trim();
    this.updateSelectedWorkspacePath(nextWorkspacePath);
  }

  async initProject(workspacePath?: string) {
    const resolvedWorkspacePath = await this.resolveResearchWorkspacePath(workspacePath);
    await this.store.initProject(resolvedWorkspacePath, await this.resolveProjectDefaults(resolvedWorkspacePath));
    return await this.buildContextBundleSnapshot(
      resolvedWorkspacePath,
      "Initialize the workspace context bundle for this workspace."
    );
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

  private async getSummarizedSnapshot(workspacePath: string) {
    await this.store.updateSessionSummary(workspacePath);
    return await this.store.getSnapshot(workspacePath);
  }

  private async resolveProjectDefaults(workspacePath: string) {
    const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
    return {
      name: await this.resolveProjectName(workspacePath),
      oracleModel: normalizeStrategistModel(appSettings.strategistModel)
    };
  }

  private async buildContextBundleSnapshot(
    workspacePath: string,
    prompt: string,
    options: {
      includeSessionSummary?: boolean;
    } = {}
  ) {
    if (options.includeSessionSummary) {
      await this.store.updateSessionSummary(workspacePath);
    }

    await this.store.buildContextBundle(workspacePath, prompt);
    return await this.store.getSnapshot(workspacePath);
  }

  async createThread(request: ThreadCreateRequest = {}): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.store.createThread(workspacePath, request.title);
    return await this.buildContextBundleSnapshot(
      workspacePath,
      "Refresh the workspace context bundle after creating a new thread.",
      { includeSessionSummary: true }
    );
  }

  async selectThread(request: ThreadSelectionRequest): Promise<ProjectSnapshot> {
    const workspacePath = this.requireWorkspacePath(request.workspacePath);
    await this.store.selectThread(workspacePath, request.threadId);
    return await this.buildContextBundleSnapshot(
      workspacePath,
      "Refresh the workspace context bundle after switching threads.",
      { includeSessionSummary: true }
    );
  }

  async createAutomationSession(request: AutomationSessionCreateRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.store.initProject(workspacePath, await this.resolveProjectDefaults(workspacePath));
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
        "checkpoint"
      ],
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
      mode: session.mode
    });
    await this.store.appendActivity(workspacePath, `${session.id} automation session created`);
    return await this.buildContextBundleSnapshot(
      workspacePath,
      "Refresh the workspace context bundle after creating an automation session.",
      { includeSessionSummary: true }
    );
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
      startedAt: session.startedAt ?? new Date().toISOString(),
      budget: {
        ...session.budget,
        usedRetries: 0
      }
    });
    await this.store.appendPromptLog(workspacePath, {
      kind: "automation.session.started",
      threadId: session.threadId,
      sessionId: session.id,
      objective: session.objective
    });
    await this.store.appendActivity(workspacePath, `${session.id} automation started`);
    await this.store.updateSessionSummary(workspacePath);
    this.scheduleAutomationLoop(workspacePath, session.id);
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
    return await this.getSummarizedSnapshot(workspacePath);
  }

  async resumeAutomationSession(request: AutomationSessionControlRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.reconcileStaleBuilderRuns(workspacePath);
    const session = await this.requireAutomationSession(workspacePath, request.sessionId);
    const controller = this.getAutomationController(workspacePath, session.id);
    controller.pauseRequested = false;
    controller.stopRequested = false;
    await this.writeRunningAutomationSession(workspacePath, session, {
      currentStepSummary: "Automation resumed.",
      budget: {
        ...session.budget,
        usedRetries: 0
      }
    });
    await this.store.appendActivity(workspacePath, `${session.id} automation resumed`);
    await this.store.updateSessionSummary(workspacePath);
    this.scheduleAutomationLoop(workspacePath, session.id);
    return await this.store.getSnapshot(workspacePath);
  }

  async interruptAutomationSession(request: AutomationInterruptRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    const session = await this.requireAutomationSession(workspacePath, request.sessionId);
    const controller = this.getAutomationController(workspacePath, session.id);
    const instruction = request.instruction.trim();
    const stoppedAt = new Date().toISOString();

    await this.appendAutomationUserEntry(workspacePath, session, instruction);

    if (request.stopNow) {
      controller.stopRequested = true;
      controller.pauseRequested = false;
      const visibleStopInstruction =
        instruction && !isOperationalAutomationMessage(instruction) ? instruction : "";

      await this.terminatePersistedAutomationWorkers(workspacePath, session, controller);

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
      this.cleanupAutomationController(workspacePath, session.id);
      await this.store.appendPromptLog(workspacePath, {
        kind: "automation.interrupt",
        threadId: session.threadId,
        sessionId: session.id,
        instruction,
        stopNow: true
      });
      await this.store.appendActivity(workspacePath, `${session.id} automation stopped`);
      return await this.getSummarizedSnapshot(workspacePath);
    }

    const snapshot = await this.store.getSnapshot(workspacePath);
    const activeRunInspection = this.latestActiveAutomationBuilderRunId(controller)
      ? await this.inspectBuilderRun({
          workspacePath,
          runId: this.latestActiveAutomationBuilderRunId(controller) ?? ""
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
      currentStepSummary: session.currentStepSummary,
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
    return await this.getSummarizedSnapshot(workspacePath);
  }

  private async approveAutomationCheckpoint(request: {
    workspacePath?: string;
    sessionId: string;
    checkpointId?: string;
    response?: string;
  }): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    const session = await this.requireAutomationSession(workspacePath, request.sessionId);
    const checkpoints = await this.store.listAutomationCheckpoints(workspacePath);
    const checkpoint =
      checkpoints.find((record) => record.id === (request.checkpointId ?? session.latestCheckpointId)) ?? null;

    if (!checkpoint) {
      throw new Error("Automation checkpoint not found.");
    }

    const response = request.response?.trim() || "";
    await this.appendAutomationUserEntry(workspacePath, session, response);
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
      queuedUserInstruction: response || session.queuedUserInstruction,
      budget: {
        ...session.budget,
        usedRetries: 0
      }
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
    this.scheduleAutomationLoop(workspacePath, session.id);
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
      if (intent === "question") {
        return await this.answerRunningAutomationQuestion(
          {
            workspacePath: input.workspacePath,
            session,
            question: input.normalizedPrompt
          },
          input.rawPrompt
        );
      }

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
    const snapshot = await this.store.getSnapshot(input.workspacePath);
    const activeThread =
      snapshot.threads.find((thread) => thread.id === input.session.threadId) ?? snapshot.activeThread;

    if (!activeThread) {
      throw new Error("No active thread is available.");
    }

    const prompt = buildAutomationChatFollowupPrompt(
      input.session,
      input.question,
      input.checkpoint
    );
    const answerPaths = this.buildAutomationQuestionAnswerPaths(
      input.workspacePath,
      activeThread.id,
      displayPrompt
    );
    const context = await this.prepareModelContext({
      workspacePath: input.workspacePath,
      prompt,
      lane: "builder",
      snapshot,
      artifactId: answerPaths.id
    });
    const executionContext = await resolveWorkspaceCommandContext(input.workspacePath);
    const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
    const answerModel = appSettings.builderModel === "gpt-5.3-codex" ? "gpt-5.4" : appSettings.builderModel;

    await mkdir(path.dirname(answerPaths.outputPath), { recursive: true });
    await this.appendAutomationUserEntry(input.workspacePath, input.session, displayPrompt);
    await this.store.appendPromptLog(input.workspacePath, {
      kind: "automation.question.request",
      lane: "automation",
      threadId: activeThread.id,
      sessionId: input.session.id,
      checkpointId: input.checkpoint.id,
      prompt,
      displayPrompt,
      source: "automation-checkpoint-question",
      runtimeContext: context.runtimeContext,
      contextPackPath: context.contextPackPath
    });
    await this.store.appendActivity(
      input.workspacePath,
      `${input.session.id} answering an automation checkpoint question in chat`
    );

    this.setChatProgress(input.workspacePath, {
      lane: "orchestrator",
      threadId: activeThread.id,
      promptPreview: displayPrompt,
      progressSummary: "",
      progressDetails: [],
      activeCommand: null,
      stdoutPath: answerPaths.stdoutPath,
      stderrPath: answerPaths.stderrPath,
      operationId: "automation-chat-answer"
    });

    try {
      const result = await this.codexRunner.runTask({
        workspacePath: input.workspacePath,
        commandCwd: executionContext.commandCwd,
        prompt,
        runtimeContext: context.runtimeContext,
        artifactContext: context.artifactContext,
        model: answerModel,
        reasoningEffort: "xhigh",
        promptLanguage: appSettings.autopilotPromptLanguage,
        stdoutPath: answerPaths.stdoutPath,
        stderrPath: answerPaths.stderrPath,
        outputPath: answerPaths.outputPath,
        timeoutMs: AUTOMATION_CHAT_ANSWER_TIMEOUT_MS,
        env: executionContext.env
      });
      const reply =
        sanitizeConversationBody(result.finalMessage) ||
        input.checkpoint.summary.trim() ||
        "I reviewed the latest checkpoint context, but I do not have a clearer answer yet.";

      await this.store.appendPromptLog(input.workspacePath, {
        kind: "automation.question.response",
        lane: "automation",
        threadId: activeThread.id,
        sessionId: input.session.id,
        checkpointId: input.checkpoint.id,
        model: answerModel,
        command: result.command,
        finalMessage: result.finalMessage,
        summary: reply,
        timedOut: result.timedOut
      });
      await this.appendAutomationAssistantEntry(input.workspacePath, {
        session: input.session,
        body: reply
      });
      await this.syncThreadFromArtifacts(input.workspacePath, activeThread, {
        prompt: displayPrompt,
        summary: reply
      });
      await this.store.appendActivity(
        input.workspacePath,
        `${input.session.id} answered an automation checkpoint question in chat`
      );
      return await this.getSummarizedSnapshot(input.workspacePath);
    } finally {
      this.clearChatProgress(input.workspacePath, activeThread.id, "automation-chat-answer");
    }
  }

  private async answerRunningAutomationQuestion(
    input: {
      workspacePath: string;
      session: AutomationSessionRecord;
      question: string;
    },
    displayPrompt: string
  ) {
    const snapshot = await this.store.getSnapshot(input.workspacePath);
    const activeThread =
      snapshot.threads.find((thread) => thread.id === input.session.threadId) ?? snapshot.activeThread;

    if (!activeThread) {
      throw new Error("No active thread is available.");
    }

    const controller = this.getAutomationController(input.workspacePath, input.session.id);
    const activeRunInspection = this.latestActiveAutomationBuilderRunId(controller)
      ? await this.inspectBuilderRun({
          workspacePath: input.workspacePath,
          runId: this.latestActiveAutomationBuilderRunId(controller) ?? ""
        })
      : null;
    const activeChatProgress = await this.inspectChatProgress({
      workspacePath: input.workspacePath,
      threadId: input.session.threadId
    });
    const answerPaths = this.buildAutomationQuestionAnswerPaths(
      input.workspacePath,
      activeThread.id,
      displayPrompt
    );
    const prompt = buildRunningAutomationChatFollowupPrompt({
      session: input.session,
      question: input.question,
      snapshot,
      builderInspection: activeRunInspection,
      chatProgress: activeChatProgress
    });
    const context = await this.prepareModelContext({
      workspacePath: input.workspacePath,
      prompt,
      lane: "builder",
      snapshot,
      artifactId: answerPaths.id
    });
    const executionContext = await resolveWorkspaceCommandContext(input.workspacePath);
    const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
    const answerModel = appSettings.builderModel === "gpt-5.3-codex" ? "gpt-5.4" : appSettings.builderModel;

    await mkdir(path.dirname(answerPaths.outputPath), { recursive: true });
    await this.appendAutomationUserEntry(input.workspacePath, input.session, displayPrompt);
    await this.store.appendPromptLog(input.workspacePath, {
      kind: "automation.question.request",
      lane: "automation",
      threadId: activeThread.id,
      sessionId: input.session.id,
      prompt,
      displayPrompt,
      source: "automation-running-question",
      runtimeContext: context.runtimeContext,
      contextPackPath: context.contextPackPath
    });
    await this.store.appendActivity(input.workspacePath, `${input.session.id} answering a running automation question`);

    this.setChatProgress(input.workspacePath, {
      lane: "orchestrator",
      threadId: activeThread.id,
      promptPreview: displayPrompt,
      progressSummary: "",
      progressDetails: [],
      activeCommand: null,
      stdoutPath: answerPaths.stdoutPath,
      stderrPath: answerPaths.stderrPath,
      operationId: "automation-chat-answer"
    });

    try {
      const result = await this.codexRunner.runTask({
        workspacePath: input.workspacePath,
        commandCwd: executionContext.commandCwd,
        prompt,
        runtimeContext: context.runtimeContext,
        artifactContext: context.artifactContext,
        model: answerModel,
        reasoningEffort: "xhigh",
        promptLanguage: appSettings.autopilotPromptLanguage,
        stdoutPath: answerPaths.stdoutPath,
        stderrPath: answerPaths.stderrPath,
        outputPath: answerPaths.outputPath,
        timeoutMs: AUTOMATION_CHAT_ANSWER_TIMEOUT_MS,
        env: executionContext.env
      });
      const reply =
        sanitizeConversationBody(result.finalMessage) ||
        summarizeAutomationInterrupt({
          instruction: input.question,
          session: input.session,
          snapshot,
          builderInspection: activeRunInspection,
          chatProgress: activeChatProgress,
          queueRedirect: false
        });

      await this.store.appendPromptLog(input.workspacePath, {
        kind: "automation.question.response",
        lane: "automation",
        threadId: activeThread.id,
        sessionId: input.session.id,
        model: answerModel,
        command: result.command,
        finalMessage: result.finalMessage,
        summary: reply
      });
      await this.appendAutomationAssistantEntry(input.workspacePath, {
        session: input.session,
        body: reply
      });
      await this.syncThreadFromArtifacts(input.workspacePath, activeThread, {
        prompt: displayPrompt,
        summary: reply
      });
      await this.store.appendActivity(input.workspacePath, `${input.session.id} answered a running automation question in chat`);
      return await this.getSummarizedSnapshot(input.workspacePath);
    } finally {
      this.clearChatProgress(input.workspacePath, activeThread.id, "automation-chat-answer");
    }
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
    const attachmentIds = input.snapshot.activeThreadAttachments.map((attachment) => attachment.id);

    const userEntry = await this.appendConversationEntry(input.workspacePath, {
      threadId: input.activeThread.id,
      role: "user",
      source: "user",
      body: input.prompt,
      attachmentIds
    });
    await this.store.consumeAttachments(input.workspacePath, attachmentIds, {
      conversationEntryId: userEntry.id,
      decisionId: undefined,
      runId: undefined
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
      promptPreview: input.prompt,
      progressSummary: "",
      progressDetails: [],
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
          maxRetries: automationDelegation.maxRetries ?? 8
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

        await this.appendAssistantConversationEntry(input.workspacePath, {
          threadId: input.activeThread.id,
          source: "automation",
          body: reply,
          automationSessionId: sessionId
        });
        await this.syncThreadFromArtifacts(input.workspacePath, input.activeThread, {
          prompt: input.prompt,
          summary: reply
        });
        await this.store.appendActivity(input.workspacePath, `${sessionId} automation started from orchestrator chat`);
        return await this.getSummarizedSnapshot(input.workspacePath);
      }

      if (!workerDelegations.length) {
        const reply = directReply || "I reviewed the latest workspace state, but I do not have a clearer answer yet.";

        await this.appendAssistantConversationEntry(input.workspacePath, {
          threadId: input.activeThread.id,
          source: "orchestrator",
          body: reply
        });
        await this.syncThreadFromArtifacts(input.workspacePath, input.activeThread, {
          prompt: input.prompt,
          summary: reply
        });
        await this.store.appendActivity(input.workspacePath, "orchestrator answered directly in chat");
        return await this.getSummarizedSnapshot(input.workspacePath);
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
        await this.appendAssistantConversationEntry(input.workspacePath, {
          threadId: input.activeThread.id,
          source: "orchestrator",
          body: reply,
          runId: workerTurn.snapshot.latestRun?.id
        });
        await this.syncThreadFromArtifacts(input.workspacePath, input.activeThread, {
          prompt: input.prompt,
          summary: reply
        });
        await this.store.appendActivity(input.workspacePath, "orchestrator started a live builder run from chat");
        return await this.getSummarizedSnapshot(input.workspacePath);
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
        promptPreview: input.prompt,
        progressSummary: "",
        progressDetails: [],
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

      await this.appendAssistantConversationEntry(input.workspacePath, {
        threadId: input.activeThread.id,
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
      return await this.getSummarizedSnapshot(input.workspacePath);
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

  private buildAutomationQuestionAnswerPaths(workspacePath: string, threadId: string, question: string) {
    const requestPaths = this.buildConversationOrchestratorRequestPaths(workspacePath, threadId);
    const baseDir = path.dirname(requestPaths.builder);
    const id = `AQ${createHash("sha1")
      .update(`${threadId}\n${question.trim()}\n${Date.now()}`)
      .digest("hex")
      .slice(0, 10)
      .toUpperCase()}`;

    return {
      id,
      stdoutPath: path.join(baseDir, `${id}.stdout.log`),
      stderrPath: path.join(baseDir, `${id}.stderr.log`),
      outputPath: path.join(baseDir, `${id}.reply.md`)
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
    this.rememberConversationLanguage(workspacePath, entry);
    return entry;
  }

  private async appendAssistantConversationEntry(
    workspacePath: string,
    input: Omit<ConversationEntryRecord, "id" | "createdAt" | "role" | "body"> & {
      threadId: string;
      body: string;
    }
  ) {
    const body = await this.prepareAssistantConversationBody(
      workspacePath,
      input.threadId,
      input.body
    );

    if (!body) {
      return null;
    }

    return await this.appendConversationEntry(workspacePath, {
      ...input,
      role: "assistant",
      body
    });
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
    const body = await this.prepareAssistantConversationBody(
      workspacePath,
      input.session.threadId,
      input.body
    );

    if (!body) {
      return null;
    }

    return await this.appendConversationEntry(workspacePath, {
      threadId: input.session.threadId,
      role: "assistant",
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
    return await this.appendAssistantConversationEntry(workspacePath, {
      threadId: input.session.threadId,
      source: "automation",
      body: input.body,
      decisionId: input.decisionId,
      runId: input.runId,
      automationSessionId: input.session.id,
      automationCycleId: input.cycleId,
      automationStepId: input.stepId
    });
  }

  private async prepareAssistantConversationBody(
    workspacePath: string,
    threadId: string,
    body: string
  ) {
    const latestUserBody = await this.findLatestThreadUserBody(workspacePath, threadId);
    return stripLeadingPromptEchoParagraph(sanitizeConversationBody(body), latestUserBody);
  }

  private async appendAutomationWorkerHistory(
    workspacePath: string,
    input: {
      session: AutomationSessionRecord;
      step: AutomationStepRecord;
      decisionId?: string;
      runId?: string;
    }
  ) {
    if (input.decisionId) {
      const decision = await this.store.readDecision(workspacePath, input.decisionId).catch(() => null);

      if (decision) {
        await this.store.appendWorkerHistory(workspacePath, {
          lane: "strategist",
          threadId: input.session.threadId,
          automationSessionId: input.session.id,
          automationCycleId: input.step.cycleId,
          automationStepId: input.step.id,
          artifactId: decision.id,
          prompt: decision.prompt,
          summary: handoffMachineSummary(decision.handoff) || decision.summary,
          rationale: decision.rationale,
          replyPath: decision.outputPath,
          stdoutPath: decision.stdoutPath,
          stderrPath: decision.stderrPath,
          replyBody: decision.rawOutput
        });
      }
    }

    if (input.runId) {
      const run = await this.store.readRun(workspacePath, input.runId).catch(() => null);

      if (run) {
        await this.store.appendWorkerHistory(workspacePath, {
          lane: "builder",
          threadId: input.session.threadId,
          automationSessionId: input.session.id,
          automationCycleId: input.step.cycleId,
          automationStepId: input.step.id,
          artifactId: run.id,
          prompt: run.prompt,
          summary: handoffMachineSummary(run.handoff) || extractRunSummary(run.finalMessage || ""),
          result: run.status,
          changedFiles: run.changedFiles,
          replyPath: run.finalMessagePath,
          stdoutPath: run.stdoutPath,
          stderrPath: run.stderrPath,
          replyBody: run.finalMessage
        });
      }
    }
  }

  private async appendAutomationUserEntry(
    workspacePath: string,
    session: AutomationSessionRecord,
    body: string
  ) {
    const trimmedBody = body.trim();

    if (!trimmedBody) {
      return null;
    }

    const snapshot = await this.store.getSnapshot(workspacePath);
    const latestThreadUserEntry = (snapshot.conversationEntries ?? [])
      .filter((entry) => entry.threadId === session.threadId && entry.role === "user")
      .at(-1);

    if (
      latestThreadUserEntry?.automationSessionId === session.id &&
      latestThreadUserEntry.body.trim() === trimmedBody
    ) {
      return latestThreadUserEntry;
    }

    return await this.appendConversationEntry(workspacePath, {
      threadId: session.threadId,
      role: "user",
      source: "user",
      body: trimmedBody,
      automationSessionId: session.id
    });
  }

  private async findLatestThreadUserBody(workspacePath: string, threadId: string) {
    const entries = await this.store.listConversationEntries(workspacePath).catch(() => []);

    return [...entries]
      .reverse()
      .find((entry) => entry.threadId === threadId && entry.role === "user")
      ?.body;
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

  private async persistAutomationConversationReportFingerprint(
    workspacePath: string,
    session: AutomationSessionRecord,
    fingerprint: string
  ) {
    const normalizedFingerprint = fingerprint.trim();

    if (!normalizedFingerprint) {
      return session;
    }

    const currentSession =
      (await this.store.readAutomationSession(workspacePath, session.id).catch(() => null)) ?? session;

    if (currentSession.lastConversationReportFingerprint === normalizedFingerprint) {
      return currentSession;
    }

    const nextSession: AutomationSessionRecord = {
      ...currentSession,
      lastConversationReportFingerprint: normalizedFingerprint,
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
    return await this.runtime.runSerialized(workspacePath, scopeKey, task);
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
      progressOperationId?: string;
    } = {}
  ) {
    const progressOperationId = options.progressOperationId ?? delegation.lane;

    if (delegation.lane === "strategist") {
      this.setChatProgress(input.workspacePath, {
        lane: "strategist",
        threadId: input.activeThread.id,
        promptPreview: input.prompt,
        progressSummary: "",
        progressDetails: [],
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
        promptPreview: input.prompt,
        progressSummary: "",
        progressDetails: [],
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
      promptPreview: input.prompt,
      progressSummary: "",
      progressDetails: [],
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
      delegations.map((delegation, index) =>
        this.runOrchestratorWorkerTurn(input, delegation, {
          ...options,
          progressOperationId:
            delegations.length > 1 ? `${delegation.lane}-${index + 1}` : delegation.lane
        })
      )
    );

    return {
      results,
      startedLiveRun: results.some((result) => result.startedLiveRun),
      snapshot: await this.store.getSnapshot(input.workspacePath)
    };
  }

  async importAttachments(request: AttachmentImportRequest): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.store.initProject(workspacePath, await this.resolveProjectDefaults(workspacePath));
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
        "Refresh the workspace context bundle after importing attachments."
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
        "Refresh the workspace context bundle after removing an attachment."
      );
    }

    return await this.store.getSnapshot(workspacePath);
  }

  async beginStrategistSignIn(): Promise<void> {
    await this.chatgptAuthRunner.signIn();
    await this.chatgptAuthRunner.prepareReusableSession?.();
  }

  async sendChatMessage(
    request: ChatRequest,
    options: {
      strategistSessionReady?: boolean;
    } = {}
  ): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    await this.store.initProject(workspacePath, await this.resolveProjectDefaults(workspacePath));

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

    if (this.orchestratorRunner && !override.route) {
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
    const activeAttachmentIds = snapshot.activeThreadAttachments.map((attachment) => attachment.id);

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
        promptPreview: request.prompt,
        progressSummary: "",
        progressDetails: [],
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
            promptPreview: builderDisplayPrompt,
            progressSummary: "",
            progressDetails: [],
            activeCommand: null
          });
          downstreamSnapshot = await this.startBuilderTask({
            workspacePath,
            threadId: activeThread.id,
            prompt: downstreamPrompt,
            displayPrompt: builderDisplayPrompt
          }, {
            consumeAttachmentIds: activeAttachmentIds
          });
        } else if (finalRoute === "mixed") {
          const strategistSnapshot = await this.consultStrategist(
            {
              workspacePath,
              threadId: activeThread.id,
              prompt: downstreamPrompt,
              displayPrompt: request.prompt
            },
            {
              ...options,
              consumeAttachmentIds: activeAttachmentIds
            }
          );

          this.setChatProgress(workspacePath, {
            lane: "builder",
            threadId: activeThread.id,
            promptPreview: request.prompt,
            progressSummary: "",
            progressDetails: [],
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
            {
              ...options,
              consumeAttachmentIds: activeAttachmentIds
            }
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

  private async consultStrategist(
    request: StrategistRequest,
    options: {
      strategistSessionReady?: boolean;
      manageProgress?: boolean;
      progressOperationId?: string;
      consumeAttachmentIds?: string[];
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
        promptPreview: request.displayPrompt ?? request.prompt,
        progressSummary: "",
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
          promptPreview: request.displayPrompt ?? request.prompt,
          progressSummary: "",
          progressDetails: [],
          activeCommand: null,
          operationId: progressOperationId
        });
      }

      const configuredStrategistModel = normalizeStrategistModel(request.model ?? appSettings.strategistModel);
      const project = await this.store.initProject(workspacePath, {
        ...(await this.resolveProjectDefaults(workspacePath)),
        oracleModel: configuredStrategistModel
      });
      if (request.threadId) {
        await this.store.selectThread(workspacePath, request.threadId);
      }
      const currentSnapshot = await this.store.getSnapshot(workspacePath);
      const activeThread = currentSnapshot.activeThread;
      const consumeAttachmentIds =
        options.consumeAttachmentIds ?? currentSnapshot.activeThreadAttachments.map((attachment) => attachment.id);
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

      const strategistSubmission = await this.prepareStrategistSubmission({
        workspacePath,
        prompt: request.prompt,
        displayPrompt: request.displayPrompt,
        snapshot: currentSnapshot,
        activeThread,
        artifactId: decisionPaths.id,
        attachExplicitWorkspaceFiles: request.attachExplicitWorkspaceFiles
      });
      const strategistModel = configuredStrategistModel ?? project.oracleModel;
      const strategistReasoningIntensity = normalizeStrategistThinkingTime(
        request.reasoningIntensity ?? appSettings.strategistReasoningIntensity
      );

      await this.store.appendPromptLog(workspacePath, {
        kind: "strategist.request",
        threadId: activeThread.id,
        prompt: request.prompt,
        displayPrompt: request.displayPrompt,
        model: strategistModel,
        reasoningIntensity: strategistReasoningIntensity,
        oracleSessionSlug: strategistSessionSlug,
        files: strategistSubmission.files,
        rawPrompt: strategistSubmission.oraclePrompt,
        runtimeContext: strategistSubmission.runtimeContext,
        contextPackPath: strategistSubmission.contextPackPath,
        strategistReferenceDigestPath: strategistSubmission.strategistReferenceDigestPath
      });
      if (manageProgress) {
        this.setChatProgress(workspacePath, {
          lane: "strategist",
          threadId: activeThread.id,
          promptPreview: request.displayPrompt ?? request.prompt,
          progressSummary: "",
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
        prompt: strategistSubmission.oraclePrompt,
        model: strategistModel,
        browserThinkingTime: strategistReasoningIntensity,
        files: strategistSubmission.files,
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
          promptPreview: request.displayPrompt ?? request.prompt,
          progressSummary: "",
          progressDetails: [],
          activeCommand: null,
          oracleSessionSlug: result.sessionId ?? strategistSessionSlug,
          stdoutPath: decisionPaths.stdoutPath,
          stderrPath: decisionPaths.stderrPath,
          operationId: progressOperationId
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
        inputFiles: strategistSubmission.files,
        model: strategistModel,
        rawOutput: strategistOutput,
        command: result.command,
        stdoutPath: decisionPaths.stdoutPath,
        stderrPath: decisionPaths.stderrPath,
        outputPath: decisionPaths.outputPath,
        contextPackPath: strategistSubmission.contextPackPath,
        startedAt: result.startedAt,
        exitCode: result.exitCode
      });

      await this.store.writeDecision(workspacePath, decision);
      await this.store.consumeAttachments(workspacePath, consumeAttachmentIds, {
        conversationEntryId: undefined,
        decisionId: decision.id,
        runId: undefined
      });
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
        strategistContextFingerprint: strategistSubmission.strategistContextFingerprint
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

  private async runBuilderTask(
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
      const project = await this.store.initProject(workspacePath, await this.resolveProjectDefaults(workspacePath));
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
          title: prompt.slice(0, 80) || "Workspace task",
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
          promptPreview: displayPrompt,
          progressSummary: "",
          progressDetails: [],
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

      return await this.store.getSnapshot(workspacePath);
    } finally {
      if (manageProgress) {
        this.clearChatProgress(workspacePath, progressThreadId || undefined, progressOperationId);
      }
    }
  }

  private async startBuilderTask(
    request: BuilderRequest,
    options: {
      manageProgress?: boolean;
      progressOperationId?: string;
      consumeAttachmentIds?: string[];
    } = {}
  ): Promise<ProjectSnapshot> {
    const workspacePath = await this.resolveResearchWorkspacePath(request.workspacePath);
    const manageProgress = options.manageProgress ?? true;
    const progressOperationId = options.progressOperationId?.trim() || "builder";
    await this.reconcileStaleBuilderRuns(workspacePath);
    const project = await this.store.initProject(workspacePath, await this.resolveProjectDefaults(workspacePath));
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
        title: prompt.slice(0, 80) || "Workspace task",
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
        promptPreview: displayPrompt,
        progressSummary: "",
        progressDetails: [],
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
    await this.store.consumeAttachments(workspacePath, options.consumeAttachmentIds ?? [], {
      conversationEntryId: undefined,
      decisionId: undefined,
      runId: runPaths.id
    });
    await this.syncThreadFromArtifacts(workspacePath, activeThread, {
      prompt: displayPrompt
    });
    await this.store.appendActivity(workspacePath, `${runPaths.id} started`);

    void liveHandle.done
      .then(async (result) => {
        if (this.runtime.isRunTerminating(runPaths.id)) {
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
        if (this.runtime.isRunTerminating(runPaths.id)) {
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
      })
      .finally(() => {
        if (manageProgress) {
          this.clearChatProgressIfCurrentMatches(
            workspacePath,
            activeThread.id,
            progressOperationId,
            runPaths.stdoutPath,
            runPaths.stderrPath
          );
        }
      });

    return await this.store.getSnapshot(workspacePath);
  }

  private async inspectBuilderRun(request: BuilderRunControlRequest): Promise<BuilderRunInspection | null> {
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
      return toUserFacingChatProgressInspection(inspections[0]);
    }

    return combineParallelChatProgressInspections(
      inspections.map((inspection) => toUserFacingChatProgressInspection(inspection))
    );
  }

  private async inspectSingleChatProgressEntry(
    workspacePath: string,
    progress: ActiveChatProgress
  ): Promise<ChatProgressInspection> {
    const [stdoutTail, stderrTail, oracleLogTail, latestTouchedAt] = await Promise.all([
      progress.stdoutPath ? readTailText(progress.stdoutPath) : Promise.resolve(""),
      progress.stderrPath ? readTailText(progress.stderrPath) : Promise.resolve(""),
      progress.oracleSessionSlug ? readOracleSessionTail(progress.oracleSessionSlug) : Promise.resolve(""),
      resolveChatProgressTouchedAt(progress)
    ]);
    const oracleProgress = extractOracleSessionProgress(oracleLogTail);
    const strategistProgress = progress.lane === "strategist";
    const liveOracleProgress =
      strategistProgress &&
      progress.oracleSessionSlug &&
      !hasMeaningfulStrategistProgress(oracleProgress)
        ? await readLiveOracleSessionProgress(progress.oracleSessionSlug, progress.promptPreview)
        : null;
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

    const inspection = sanitizePromptEchoProgress({
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
    } satisfies ChatProgressInspection, progress.promptPreview);

    this.rememberObservedChatProgress(workspacePath, progress, inspection);

    return inspection;
  }

  private async terminateBuilderRun(request: BuilderRunControlRequest): Promise<ProjectSnapshot> {
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

    this.runtime.markRunTerminating(run.id);
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
                  ? "The app cancelled this task while recovering a detached builder process."
                  : "The app cancelled this task before it finished.",
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
      this.runtime.clearRunTerminating(run.id);
    }

    return await this.store.getSnapshot(workspacePath);
  }

  private async finalizeBuilderRun(
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

    return await this.store.getSnapshot(workspacePath);
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
    return basename(workspacePath);
  }

  private resolveWorkspacePath(workspacePath?: string) {
    return workspacePath?.trim() || this.selectedWorkspacePath.trim();
  }

  private requireWorkspacePath(workspacePath?: string) {
    const resolved = this.resolveWorkspacePath(workspacePath);

    if (!resolved) {
      throw new Error("No workspace is selected.");
    }

    return resolved;
  }

  private async resolveResearchWorkspacePath(workspacePath?: string) {
    return this.requireWorkspacePath(workspacePath);
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

    const controller = this.runtime.peekAutomationController(workspacePath, session.id);

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
            ? "Resuming the in-flight builder and strategist work after the app restarted."
            : "Resuming the in-flight builder step after the app restarted."
      });
      this.scheduleAutomationLoop(workspacePath, refreshedSession.id);
      return;
    }

    if (refreshedRunningSteps.some((step) => step.lane === "strategist")) {
      await this.writeRunningAutomationSession(workspacePath, refreshedSession, {
        currentStepSummary: "Resuming the in-flight strategist step after the app restarted."
      });
      this.scheduleAutomationLoop(workspacePath, refreshedSession.id);
      return;
    }

    if (refreshedSession.mode === "continuous") {
      for (const runningStep of refreshedRunningSteps) {
        if (runningStep.lane === "builder" || runningStep.lane === "strategist") {
          continue;
        }

        await this.completeAutomationStep(workspacePath, refreshedSession, runningStep, {
          status: "failed",
          summary: `Automation resumed after the app restarted while "${runningStep.title}" was still marked in progress.`,
          changedFiles: [],
          evidence: [runningStep.id]
        });
      }

      await this.writeRunningAutomationSession(workspacePath, refreshedSession, {
        currentStepSummary: "Automation resumed after the app restarted."
      });
      this.scheduleAutomationLoop(workspacePath, refreshedSession.id);
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
      currentStepSummary: "Automation was interrupted when the app restarted. Waiting for your direction.",
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
          "The app terminated a detached builder process after restart left it running without an active session.",
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

    const shouldBuildContextPack =
      Boolean(input.artifactId) &&
      (input.lane === "strategist" || this.shouldAttachArtifactContext(input.snapshot, input.lane, input.prompt));

    if (!input.artifactId || !shouldBuildContextPack) {
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

  private async prepareStrategistSubmission(input: {
    workspacePath: string;
    snapshot: ProjectSnapshot;
    activeThread: ThreadRecord;
    artifactId: string;
    prompt: string;
    displayPrompt?: string;
    attachExplicitWorkspaceFiles?: boolean;
  }): Promise<StrategistSubmission> {
    const workspaceContextFingerprint = await this.store.computeWorkspaceContextFingerprint(input.workspacePath);
    const strategistContextFingerprint = buildStrategistContextFingerprint(input.snapshot, {
      workspaceFingerprint: workspaceContextFingerprint
    });
    const strategistContext = await this.prepareModelContext({
      workspacePath: input.workspacePath,
      prompt: input.prompt,
      lane: "strategist",
      snapshot: input.snapshot,
      artifactId: input.artifactId
    });
    const workspaceFiles = await this.store.listWorkspaceFiles(input.workspacePath);
    const threadAttachmentRecords = input.snapshot.attachments.filter(
      (record) => record.threadId === input.activeThread.id
    );
    const latestChangedFiles = input.snapshot.latestRun?.changedFiles ?? [];
    const recentAttachmentPaths = resolveRecentStrategistAttachmentCandidates(
      threadAttachmentRecords,
      input.workspacePath,
      { maxFiles: STRATEGIST_BROWSER_UPLOAD_MAX_FILES }
    );
    const relevantWorkspaceFiles =
      input.attachExplicitWorkspaceFiles === false
        ? []
        : resolveRelevantStrategistWorkspaceFiles({
            prompt: input.prompt,
            displayPrompt: input.displayPrompt,
            workspacePath: input.workspacePath,
            workspaceFiles,
            latestChangedFiles,
            contextHints: [
              input.activeThread.summary,
              input.activeThread.memory ?? "",
              input.snapshot.latestDecision?.summary ?? "",
              input.snapshot.latestTask?.prompt ?? ""
            ],
            maxFiles: STRATEGIST_BROWSER_UPLOAD_MAX_FILES
          });
    const strategistReferenceDigestPath = await this.buildStrategistReferenceDigest({
      workspacePath: input.workspacePath,
      artifactId: input.artifactId,
      prompt: input.prompt,
      displayPrompt: input.displayPrompt,
      latestChangedFiles,
      attachmentRecords: threadAttachmentRecords,
      workspaceFilePaths: relevantWorkspaceFiles
    });
    const uploadPlan = await this.resolveStrategistUploadPlan({
      maxFiles:
        input.attachExplicitWorkspaceFiles === true
          ? STRATEGIST_EXPLICIT_DIRECT_UPLOAD_MAX_FILES
          : STRATEGIST_DEFAULT_DIRECT_UPLOAD_MAX_FILES,
      candidates: [
        {
          path: strategistContext.runtimeContextPath,
          priority: 1_000,
          label: path.relative(input.workspacePath, strategistContext.runtimeContextPath)
        },
        {
          path: strategistReferenceDigestPath,
          priority: 980,
          label: path.relative(input.workspacePath, strategistReferenceDigestPath)
        },
        input.attachExplicitWorkspaceFiles === true && strategistContext.contextPackPath
          ? {
              path: strategistContext.contextPackPath,
              priority: 920,
              label: path.relative(input.workspacePath, strategistContext.contextPackPath)
            }
          : null,
        ...relevantWorkspaceFiles.map((filePath, index) => ({
          path: filePath,
          priority: 880 - index,
          label: path.relative(input.workspacePath, filePath)
        })),
        ...recentAttachmentPaths.map((filePath, index) => ({
          path: filePath,
          priority: 820 - index,
          label: path.relative(input.workspacePath, filePath)
        }))
      ]
    });
    const refreshedRuntimeContext = await this.store.buildRuntimeContext(input.workspacePath, input.prompt, {
      lane: "strategist",
      artifactId: input.artifactId,
      strategistSelectedUploadLines: uploadPlan.selectedUploadLines,
      strategistSkippedUploadLines: uploadPlan.skippedUploadLines
    });

    await this.buildStrategistReferenceDigest({
      workspacePath: input.workspacePath,
      artifactId: input.artifactId,
      prompt: input.prompt,
      displayPrompt: input.displayPrompt,
      latestChangedFiles,
      attachmentRecords: threadAttachmentRecords,
      workspaceFilePaths: relevantWorkspaceFiles,
      selectedUploadLines: uploadPlan.selectedUploadLines,
      skippedUploadLines: uploadPlan.skippedUploadLines
    });

    const prompt = buildStrategistPromptEnvelope({
        prompt: input.prompt,
        displayPrompt: input.displayPrompt,
        latestThreadSummary: input.activeThread.summary,
        latestDecisionSummary: input.snapshot.latestDecision?.summary ?? "",
        latestRunSummary:
          handoffMachineSummary(input.snapshot.latestRun?.handoff) ||
          extractRunSummary(input.snapshot.latestRun?.finalMessage || ""),
        latestChangedFiles,
        recentAttachmentNames: threadAttachmentRecords.map((record) => record.relativePath),
        attachedContextLabels: [
          uploadPlan.files.includes(refreshedRuntimeContext.path) ? "runtime context" : "",
          strategistContext.contextPackPath && uploadPlan.files.includes(strategistContext.contextPackPath)
            ? "full context pack"
            : "",
          uploadPlan.files.includes(strategistReferenceDigestPath) ? "strategist digest" : ""
        ].filter(Boolean),
        attachedRawFileNames: uploadPlan.files
          .filter((filePath) => filePath !== refreshedRuntimeContext.path)
          .filter((filePath) => filePath !== strategistContext.contextPackPath)
          .filter((filePath) => filePath !== strategistReferenceDigestPath)
          .map((filePath) => path.basename(filePath)),
        skippedUploadNotes: uploadPlan.skippedPromptNotes
      });

    return {
      strategistContextFingerprint,
      runtimeContext: refreshedRuntimeContext.content,
      runtimeContextPath: refreshedRuntimeContext.path,
      contextPackPath: strategistContext.contextPackPath,
      strategistReferenceDigestPath,
      files: uploadPlan.files,
      oraclePrompt: prompt
    };
  }

  private async resolveStrategistUploadPlan(input: {
    maxFiles?: number;
    candidates: Array<StrategistUploadPlanCandidate | null>;
  }): Promise<StrategistUploadPlan> {
    const deduped = new Map<string, StrategistUploadPlanCandidate>();

    for (const candidate of input.candidates) {
      if (!candidate) {
        continue;
      }

      const existing = deduped.get(candidate.path);

      if (!existing || candidate.priority > existing.priority) {
        deduped.set(candidate.path, candidate);
      }
    }

    const supported: StrategistUploadPlanCandidate[] = [];
    const skippedUploadLines: string[] = [];

    for (const candidate of deduped.values()) {
      if (!isSupportedStrategistUploadPath(candidate.path)) {
        skippedUploadLines.push(`- ${candidate.label} — unsupported for direct browser upload`);
        continue;
      }

      const metadata = await stat(candidate.path).catch(() => null);

      if (!metadata?.isFile()) {
        skippedUploadLines.push(`- ${candidate.label} — file missing locally at send time`);
        continue;
      }

      if (!isWithinStrategistUploadLimit(candidate.path, metadata.size)) {
        skippedUploadLines.push(`- ${candidate.label} — exceeds the direct upload size limit`);
        continue;
      }

      supported.push(candidate);
    }

    const files = limitStrategistUploadCandidates(supported, {
      maxFiles: input.maxFiles ?? STRATEGIST_BROWSER_UPLOAD_MAX_FILES
    });
    const selectedPaths = new Set(files);

    skippedUploadLines.push(
      ...supported
        .filter((candidate) => !selectedPaths.has(candidate.path))
        .sort(
          (left, right) =>
            right.priority - left.priority ||
            left.label.localeCompare(right.label)
        )
        .map(
          (candidate) =>
            `- ${candidate.label} — omitted from the direct upload set to stay within the browser file cap`
        )
    );

    const selectedUploadLines = files.map((filePath) => {
      const candidate = deduped.get(filePath);
      return `- ${candidate?.label ?? path.basename(filePath)}`;
    });

    return {
      files,
      selectedUploadLines,
      skippedUploadLines,
      skippedPromptNotes: skippedUploadLines
        .slice(0, 4)
        .map((line) => line.replace(/^- /, ""))
    };
  }

  private async buildStrategistReferenceDigest(input: {
    workspacePath: string;
    artifactId: string;
    prompt: string;
    displayPrompt?: string;
    latestChangedFiles: string[];
    attachmentRecords: ProjectSnapshot["attachments"];
    workspaceFilePaths: string[];
    selectedUploadLines?: string[];
    skippedUploadLines?: string[];
  }) {
    const contextDir = this.store.buildPaths(input.workspacePath).contextDir;
    const digestPath = path.join(contextDir, `${input.artifactId}.strategist.digest.md`);
    const recentAttachments = [...input.attachmentRecords]
      .sort(
        (left, right) =>
          Number(Boolean(left.consumedAt)) - Number(Boolean(right.consumedAt)) ||
          right.updatedAt.localeCompare(left.updatedAt)
      )
      .slice(0, 6);
    const attachmentSections = (
      await Promise.all(
        recentAttachments.map(async (record) =>
          await this.renderStrategistAttachmentSection(input.workspacePath, record)
        )
      )
    )
      .filter(Boolean)
      .join("\n\n");
    const workspaceSections = (
      await Promise.all(
        input.workspaceFilePaths.slice(0, 6).map(async (filePath) =>
          await this.renderStrategistReferenceFileSection(input.workspacePath, filePath)
        )
      )
    )
      .filter(Boolean)
      .join("\n\n");
    const digest = [
      "# Strategist Reference Digest",
      `Generated: ${new Date().toISOString()}`,
      "",
      "## Original User Message",
      input.displayPrompt?.trim() || input.prompt.trim() || "none",
      input.displayPrompt?.trim() && input.displayPrompt.trim() !== input.prompt.trim()
        ? ["", "## Clarified Strategist Ask", input.prompt.trim()].join("\n")
        : "",
      input.latestChangedFiles.length
        ? ["", "## Latest Changed Files", input.latestChangedFiles.slice(0, 12).map((file) => `- ${file}`).join("\n")].join(
            "\n"
          )
        : "",
      input.selectedUploadLines?.length
        ? ["", "## Direct Uploads For This Turn", input.selectedUploadLines.join("\n")].join("\n")
        : "",
      input.skippedUploadLines?.length
        ? ["", "## Files Not Uploaded Directly", input.skippedUploadLines.join("\n")].join("\n")
        : "",
      "",
      "## Recent Thread Attachments",
      attachmentSections || "- none",
      "",
      "## Relevant Workspace File Excerpts",
      workspaceSections || "- none"
    ]
      .filter(Boolean)
      .join("\n");

    await mkdir(contextDir, { recursive: true });
    await writeFile(digestPath, digest, "utf8");
    return digestPath;
  }

  private async renderStrategistReferenceFileSection(workspacePath: string, filePath: string) {
    const relativePath = path.relative(workspacePath, filePath);
    const metadata = await stat(filePath).catch(() => null);
    const extension = path.extname(filePath).toLowerCase();

    if (extension === ".zip") {
      const digest = await this.readStrategistArchiveDigest(filePath);

      return [
        `### ${relativePath}`,
        metadata ? `Size: ${metadata.size} bytes` : "",
        digest || "Archive digest: unavailable"
      ]
        .filter(Boolean)
        .join("\n");
    }

    const excerpt = await this.readStrategistReferenceExcerpt(filePath);

    return [
      `### ${relativePath}`,
      metadata ? `Size: ${metadata.size} bytes` : "",
      excerpt
        ? ["Excerpt:", "```text", excerpt, "```"].join("\n")
        : "Excerpt: unavailable or non-text; inspect the raw file directly if it is attached."
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async renderStrategistAttachmentSection(
    workspacePath: string,
    record: ProjectSnapshot["attachments"][number]
  ) {
    const absolutePath = path.join(workspacePath, record.relativePath);
    const metadata = await stat(absolutePath).catch(() => null);
    const extension = path.extname(absolutePath).toLowerCase();

    if (extension === ".zip") {
      const digest = await this.readStrategistArchiveDigest(absolutePath);

      return [
        `### ${record.relativePath}`,
        `Kind: ${record.kind}`,
        `Status: ${record.consumedAt ? `consumed (${record.consumedAt})` : "active"}`,
        metadata ? `Size: ${metadata.size} bytes` : "",
        digest || "Archive digest: unavailable"
      ]
        .filter(Boolean)
        .join("\n");
    }

    const excerpt = await this.readStrategistReferenceExcerpt(absolutePath);

    return [
      `### ${record.relativePath}`,
      `Kind: ${record.kind}`,
      `Status: ${record.consumedAt ? `consumed (${record.consumedAt})` : "active"}`,
      metadata ? `Size: ${metadata.size} bytes` : "",
      excerpt
        ? ["Excerpt:", "```text", excerpt, "```"].join("\n")
        : `Preview: ${record.excerpt || "none"}`
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async readStrategistReferenceExcerpt(filePath: string) {
    const extension = path.extname(filePath).toLowerCase();

    if (
      [
        ".pdf",
        ".doc",
        ".docx",
        ".ppt",
        ".pptx",
        ".xls",
        ".xlsx",
        ".rtf",
        ".odt",
        ".ods",
        ".odp",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".bmp"
      ].includes(extension)
    ) {
      return "";
    }

    const content = await readFile(filePath, "utf8").catch(() => "");
    const excerpt = content
      .split("\n")
      .slice(0, 120)
      .join("\n")
      .trim();

    if (!excerpt) {
      return "";
    }

    return excerpt.length <= 6_000 ? excerpt : `${excerpt.slice(0, 5_999).trimEnd()}…`;
  }

  private async readStrategistArchiveDigest(filePath: string) {
    const zipFile = await openZipFile(filePath).catch(() => null);

    if (!zipFile) {
      return "";
    }

    return await new Promise<string>((resolve) => {
      const entryLines: string[] = [];
      const previewSections: string[] = [];
      let truncatedEntries = 0;
      let finished = false;

      const finish = () => {
        if (finished) {
          return;
        }

        finished = true;
        try {
          zipFile.close();
        } catch {
          // Ignore already-closed archives.
        }

        const digestLines = ["Archive digest:"];

        if (entryLines.length) {
          digestLines.push(...entryLines);
        } else {
          digestLines.push("- none");
        }

        if (previewSections.length) {
          digestLines.push("", "Archive text previews:", ...previewSections);
        }

        if (truncatedEntries > 0) {
          digestLines.push("", `Additional archive entries omitted: ${truncatedEntries}`);
        }

        resolve(digestLines.join("\n"));
      };

      zipFile.on("error", finish);
      zipFile.on("end", finish);
      zipFile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipFile.readEntry();
          return;
        }

        if (entryLines.length >= STRATEGIST_ARCHIVE_DIGEST_MAX_ENTRIES) {
          truncatedEntries += 1;
          zipFile.readEntry();
          return;
        }

        entryLines.push(
          `- ${entry.fileName} (${entry.uncompressedSize} bytes uncompressed, ${entry.compressedSize} bytes compressed)`
        );

        const previewable =
          previewSections.length < STRATEGIST_ARCHIVE_DIGEST_MAX_PREVIEWS &&
          /\.(md|txt|json|ya?ml|xml|csv|tsv|js|jsx|ts|tsx|mjs|cjs|py|rs|go|java|c|cc|cpp|h|hpp|toml|html|css|sh)$/i.test(
            entry.fileName
          ) &&
          entry.uncompressedSize <= STRATEGIST_ARCHIVE_DIGEST_MAX_PREVIEW_BYTES;

        if (!previewable) {
          zipFile.readEntry();
          return;
        }

        zipFile.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            zipFile.readEntry();
            return;
          }

          const chunks: Buffer[] = [];
          let bytesRead = 0;
          let handled = false;

          const complete = () => {
            if (handled) {
              return;
            }

            handled = true;
            const preview = Buffer.concat(chunks)
              .toString("utf8")
              .replace(/\r\n/g, "\n")
              .trim();

            if (preview) {
              previewSections.push(
                [`#### ${entry.fileName}`, "```text", preview.length > 6_000 ? `${preview.slice(0, 5_999).trimEnd()}…` : preview, "```"].join(
                  "\n"
                )
              );
            }

            zipFile.readEntry();
          };

          stream.on("data", (chunk: Buffer) => {
            const remaining = STRATEGIST_ARCHIVE_DIGEST_MAX_PREVIEW_BYTES - bytesRead;

            if (remaining <= 0) {
              stream.destroy();
              return;
            }

            const nextChunk = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
            chunks.push(nextChunk);
            bytesRead += nextChunk.byteLength;
          });
          stream.on("error", () => {
            complete();
          });
          stream.on("end", complete);
          stream.on("close", complete);
        });
      });

      zipFile.readEntry();
    });
  }

  private shouldAttachArtifactContext(
    snapshot: ProjectSnapshot,
    lane: ContextPackLane,
    prompt: string
  ) {
    const hasAttachments = snapshot.activeThreadAttachments.length > 0;

    if (lane === "builder") {
      return hasAttachments || Boolean(snapshot.latestDecision || snapshot.latestAutomationSession);
    }

    return true;
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
      rationale: structured.rationale ?? "Oracle did not return a structured rationale.",
      handoff: structured,
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
    }
  ) {
    const nextTitle = shouldRetitleThread(thread.title) && input.prompt
      ? deriveThreadTitle(input.prompt)
      : undefined;

    await this.store.updateThread(workspacePath, thread.id, {
      title: nextTitle,
      summary: input.summary ?? thread.summary,
      strategistContextFingerprint:
        input.strategistContextFingerprint ?? thread.strategistContextFingerprint
    });
  }

  private async stopLiveProcessesForThread(workspacePath: string, threadId: string) {
    const runs = await this.store.listRuns(workspacePath);

    for (const run of runs.filter((record) => record.threadId === threadId)) {
      if (getLiveProcess(workspacePath, run.id)) {
        stopLiveProcess(workspacePath, run.id);
      }
    }
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
    return this.runtime.getAutomationController(workspacePath, sessionId);
  }

  private cleanupAutomationController(workspacePath: string, sessionId: string) {
    this.runtime.cleanupAutomationController(workspacePath, sessionId);
  }

  private registerActiveAutomationBuilderRun(
    controller: AutomationControllerState,
    stepId: string,
    runId: string | null | undefined
  ) {
    if (!runId) {
      return;
    }

    controller.activeBuilderRuns.set(stepId, runId);
  }

  private clearActiveAutomationBuilderRun(controller: AutomationControllerState, stepId: string) {
    controller.activeBuilderRuns.delete(stepId);
  }

  private listActiveAutomationBuilderRunIds(controller: AutomationControllerState) {
    return Array.from(new Set(controller.activeBuilderRuns.values()));
  }

  private latestActiveAutomationBuilderRunId(controller: AutomationControllerState) {
    const runIds = this.listActiveAutomationBuilderRunIds(controller);
    return runIds.at(-1) ?? null;
  }

  private registerActiveAutomationStrategistSession(
    controller: AutomationControllerState,
    stepId: string,
    strategistSlug: string | null | undefined
  ) {
    if (!strategistSlug) {
      return;
    }

    controller.activeStrategistSessions.set(stepId, strategistSlug);
  }

  private clearActiveAutomationStrategistSession(controller: AutomationControllerState, stepId: string) {
    controller.activeStrategistSessions.delete(stepId);
  }

  private listActiveAutomationStrategistSlugs(controller: AutomationControllerState) {
    return Array.from(new Set(controller.activeStrategistSessions.values()));
  }

  private async terminateActiveAutomationBuilderRuns(
    workspacePath: string,
    controller: AutomationControllerState
  ) {
    const runIds = this.listActiveAutomationBuilderRunIds(controller);

    for (const runId of runIds) {
      await this.terminateBuilderRun({
        workspacePath,
        runId
      });
    }

    controller.activeBuilderRuns.clear();
  }

  private async terminateActiveAutomationStrategistSessions(controller: AutomationControllerState) {
    const strategistSlugs = this.listActiveAutomationStrategistSlugs(controller);

    for (const strategistSlug of strategistSlugs) {
      await this.oracleRunner.terminateSession?.(strategistSlug).catch(() => undefined);
    }

    controller.activeStrategistSessions.clear();
  }

  private resolveAutomationStrategistSlug(step: AutomationStepRecord, fallbackWorkspacePath?: string, fallbackSession?: AutomationSessionRecord) {
    const explicitSlug =
      step.resumeCursor?.trim() ||
      (step.startedSideEffects ?? [])
        .find((entry) => entry.startsWith("oracle-session:"))
        ?.slice("oracle-session:".length)
        .trim();

    if (explicitSlug) {
      return explicitSlug;
    }

    if (!fallbackWorkspacePath || !fallbackSession || step.lane !== "strategist") {
      return "";
    }

    return buildAutomationStrategistSessionSlug(fallbackWorkspacePath, fallbackSession, null, step);
  }

  private async terminatePersistedAutomationWorkers(
    workspacePath: string,
    session: AutomationSessionRecord,
    controller: AutomationControllerState
  ) {
    const runningSteps = await this.listRunningAutomationSteps(workspacePath, session.id);
    const builderRunIds = new Set<string>(this.listActiveAutomationBuilderRunIds(controller));
    const strategistSlugs = new Set<string>(this.listActiveAutomationStrategistSlugs(controller));

    for (const step of runningSteps) {
      if (step.lane === "builder") {
        const runId = step.runId?.trim() || step.resumeCursor?.trim() || "";

        if (runId) {
          builderRunIds.add(runId);
        }
      }

      if (step.lane === "strategist") {
        const strategistSlug = this.resolveAutomationStrategistSlug(step, workspacePath, session);

        if (strategistSlug) {
          strategistSlugs.add(strategistSlug);
        }
      }
    }

    for (const strategistSlug of strategistSlugs) {
      await this.oracleRunner.terminateSession?.(strategistSlug).catch(() => undefined);
    }

    for (const runId of builderRunIds) {
      await this.terminateBuilderRun({
        workspacePath,
        runId
      }).catch(() => undefined);
    }

    for (const step of runningSteps) {
      if (step.lane === "strategist") {
        const strategistSlug = this.resolveAutomationStrategistSlug(step, workspacePath, session);
        const strategistArtifacts = this.resolveStrategistDecisionArtifacts(workspacePath, step, null);
        this.clearStrategistChatProgress(workspacePath, session.threadId, strategistArtifacts);
        this.clearActiveAutomationStrategistSession(controller, step.id);
        await this.completeAutomationStep(workspacePath, session, step, {
          status: "cancelled",
          summary: "Stopped by the user.",
          resumeCursor: strategistSlug || step.resumeCursor,
          changedFiles: [],
          evidence: []
        });
        continue;
      }

      if (step.lane === "builder") {
        const runId = step.runId?.trim() || step.resumeCursor?.trim() || "";
        this.clearActiveAutomationBuilderRun(controller, step.id);
        await this.completeAutomationStep(workspacePath, session, step, {
          status: "cancelled",
          summary: "Stopped by the user.",
          runId: step.runId ?? (runId || undefined),
          resumeCursor: runId || step.resumeCursor,
          completedSideEffects: runId ? [`run:${runId}`] : step.completedSideEffects,
          changedFiles: [],
          evidence: []
        });
      }
    }

    controller.activeBuilderRuns.clear();
    controller.activeStrategistSessions.clear();
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
    const states = new Map<AutomationCycleLaneState["lane"], AutomationCycleLaneState>();

    for (const delegation of delegations) {
      if (states.has(delegation.lane)) {
        continue;
      }

      states.set(delegation.lane, {
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
            : resolveStrategistWorkerMode(delegation.workerMode),
        summary:
          delegation.lane === "builder"
            ? "Waiting for the next builder branch to start."
            : "Waiting for the next strategist branch to start.",
        updatedAt: now
      });
    }

    return [...states.values()];
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

  private async hasRunningBackgroundStrategistStep(
    workspacePath: string,
    sessionId: string,
    excludeStepId?: string
  ) {
    const runningStrategistSteps = await this.listRunningAutomationSteps(workspacePath, sessionId, "strategist");

    return runningStrategistSteps.some(
      (step) =>
        step.id !== excludeStepId &&
        step.workerMode === "async"
    );
  }

  private resolveStrategistDecisionArtifacts(
    workspacePath: string,
    strategistStep: AutomationStepRecord,
    oracleProcess?: ActiveOracleProcess | null
  ) {
    if (oracleProcess) {
      return deriveDecisionArtifactsFromOutputPath(oracleProcess.outputPath);
    }

    const decisionId = (strategistStep.startedSideEffects ?? [])
      .find((entry) => entry.startsWith("decision-artifacts:"))
      ?.slice("decision-artifacts:".length)
      .trim();

    if (!decisionId) {
      return null;
    }

    const decisionsDir = this.store.buildPaths(workspacePath).decisionsDir;

    return {
      id: decisionId,
      outputPath: path.join(decisionsDir, `${decisionId}.output.txt`),
      stdoutPath: path.join(decisionsDir, `${decisionId}.stdout.log`),
      stderrPath: path.join(decisionsDir, `${decisionId}.stderr.log`)
    };
  }

  private async recoverStrategistDecisionIfReady(
    workspacePath: string,
    session: AutomationSessionRecord,
    strategistStep: AutomationStepRecord,
    strategistSlug: string,
    artifacts: ReturnType<AppService["resolveStrategistDecisionArtifacts"]>,
    oracleProcess?: ActiveOracleProcess | null
  ) {
    if (!artifacts) {
      return null;
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

    const strategistModel = oracleProcess?.model ?? snapshot.project?.oracleModel ?? "gpt-5.4-pro";
    const decision = this.buildDecisionRecord({
      id: artifacts.id,
      threadId: session.threadId,
      prompt: strategistStep.prompt,
      displayPrompt: `[Autopilot] ${session.displayObjective ?? session.objective}`,
      inputFiles: oracleProcess?.files ?? [],
      model: strategistModel,
      rawOutput: strategistOutput,
      command:
        oracleProcess?.command ?? {
          command: "oracle",
          args: ["--slug", strategistSlug],
          cwd: workspacePath
        },
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

  private async isAsyncStrategistStalled(
    workspacePath: string,
    strategistStep: AutomationStepRecord,
    artifacts: NonNullable<ReturnType<AppService["resolveStrategistDecisionArtifacts"]>>
  ) {
    const fileStats = await Promise.all(
      [artifacts.outputPath, artifacts.stdoutPath, artifacts.stderrPath].map((filePath) =>
        stat(filePath).catch(() => null)
      )
    );
    const latestActivityMs = Math.max(
      Date.parse(strategistStep.updatedAt || strategistStep.createdAt) || 0,
      ...fileStats.map((entry) => entry?.mtimeMs ?? 0)
    );

    if (!Number.isFinite(latestActivityMs) || latestActivityMs <= 0) {
      return false;
    }

    return Date.now() - latestActivityMs >= ASYNC_STRATEGIST_STALL_MS;
  }

  private resolveAsyncStrategistLaunchConfig(
    strategistStep: AutomationStepRecord,
    activeOracleProcess: ActiveOracleProcess | null | undefined,
    appSettings: AppSettings
  ) {
    const storedModel = readAutomationStepSideEffectValues(strategistStep, "oracle-model")[0];
    const storedThinking = readAutomationStepSideEffectValues(strategistStep, "oracle-thinking")[0];
    const storedFiles = readAutomationStepSideEffectValues(strategistStep, "oracle-file");

    return {
      model: normalizeStrategistModel(
        storedModel || activeOracleProcess?.model || appSettings.strategistModel
      ),
      reasoningIntensity: normalizeStrategistThinkingTime(
        storedThinking || appSettings.strategistReasoningIntensity
      ),
      files: storedFiles.length ? storedFiles : activeOracleProcess?.files ?? []
    };
  }

  private async resolveAsyncStrategistFailureMessage(
    strategistSlug: string,
    strategistArtifacts: ReturnType<AppService["resolveStrategistDecisionArtifacts"]> | null,
    fallback: string
  ) {
    const normalizedSlug = normalizeOracleSessionId(strategistSlug);
    const sessionError = await readOracleSessionError(normalizedSlug).catch(() => "");

    if (sessionError.trim()) {
      return sessionError.trim();
    }

    if (!strategistArtifacts) {
      return fallback;
    }

    const strategistOutput = await readTextFile(strategistArtifacts.outputPath).catch(() => "");
    const strategistOutputIssue = describeIncompleteStrategistOutput(strategistOutput);

    return strategistOutputIssue || fallback;
  }

  private async retryBackgroundStrategistStep(
    workspacePath: string,
    session: AutomationSessionRecord,
    controller: AutomationControllerState,
    strategistStep: AutomationStepRecord,
    strategistSlug: string,
    strategistArtifacts: NonNullable<ReturnType<AppService["resolveStrategistDecisionArtifacts"]>>,
    activeOracleProcess: ActiveOracleProcess | null | undefined,
    failureMessage: string
  ) {
    const requiresVisibleLoginRetry =
      isStrategistLoginRequiredFailure(failureMessage) || isStrategistSessionExpiredFailure(failureMessage);

    if (
      !this.oracleRunner.startConsult ||
      session.mode !== "continuous" ||
      isStrategistBrowserClosedFailure(failureMessage)
    ) {
      return false;
    }

    const nextUsedRetries = session.budget.usedRetries + 1;

    if (nextUsedRetries >= session.budget.maxRetries) {
      return false;
    }

    const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
    const launchConfig = this.resolveAsyncStrategistLaunchConfig(
      strategistStep,
      activeOracleProcess,
      appSettings
    );
    const nextAttempt = readAutomationStrategistAttempt(strategistStep, strategistSlug) + 1;
    const retrySlug = buildAutomationStrategistRetrySessionSlug(strategistSlug, nextAttempt);

    await Promise.all(
      [
        strategistArtifacts.outputPath,
        strategistArtifacts.stdoutPath,
        strategistArtifacts.stderrPath
      ].map((filePath) => writeFile(filePath, "").catch(() => undefined))
    );

    this.setChatProgress(workspacePath, {
      lane: "strategist",
      threadId: session.threadId,
      promptPreview: `[Autopilot] ${session.displayObjective ?? session.objective}`,
      progressSummary: "",
      progressDetails: [],
      activeCommand: null,
      oracleSessionSlug: retrySlug,
      stdoutPath: strategistArtifacts.stdoutPath,
      stderrPath: strategistArtifacts.stderrPath,
      operationId: "automation-strategist"
    });

    try {
      await this.oracleRunner.startConsult({
        workspacePath,
        prompt: strategistStep.prompt,
        model: launchConfig.model,
        browserThinkingTime: launchConfig.reasoningIntensity,
        files: launchConfig.files,
        stdoutPath: strategistArtifacts.stdoutPath,
        stderrPath: strategistArtifacts.stderrPath,
        outputPath: strategistArtifacts.outputPath,
        slug: retrySlug,
        strategistSessionReady: requiresVisibleLoginRetry ? false : appSettings.strategistSessionReady
      });
    } catch (error) {
      this.clearStrategistChatProgress(workspacePath, session.threadId, strategistArtifacts);
      throw error;
    }

    const updatedAt = new Date().toISOString();
    const updatedStep: AutomationStepRecord = {
      ...strategistStep,
      resumeCursor: retrySlug,
      startedSideEffects: Array.from(
        new Set(
          [
            ...(strategistStep.startedSideEffects ?? []),
            ...buildAutomationStrategistLaunchSideEffects({
              sessionSlug: retrySlug,
              decisionArtifactsId: strategistArtifacts.id,
              model: launchConfig.model,
              reasoningIntensity: launchConfig.reasoningIntensity,
              files: launchConfig.files,
              attempt: nextAttempt
            })
          ]
        )
      ),
      updatedAt
    };

    await this.store.writeAutomationStep(workspacePath, updatedStep);
    await this.updateAutomationCycleLaneState(workspacePath, strategistStep.cycleId, strategistStep.lane, {
      stepId: strategistStep.id,
      workerMode: "async",
      summary: "Strategist research is running in the background.",
      resumeCursor: retrySlug,
      updatedAt
    });
    await this.writeRunningAutomationSession(workspacePath, session, {
      activeLaneStepIds: Array.from(new Set([...(session.activeLaneStepIds ?? []), strategistStep.id])),
      latestStepId: strategistStep.id,
      currentStepSummary:
        resolveAutomationUiLanguage([session.displayObjective ?? "", session.objective, failureMessage]) === "ko"
          ? requiresVisibleLoginRetry
            ? "ChatGPT 로그인 상태를 다시 준비하면서 백그라운드 strategist를 자동으로 다시 시도하고 있습니다."
            : "백그라운드 strategist 리서치를 자동으로 다시 시도하고 있습니다."
          : requiresVisibleLoginRetry
            ? "Retrying the background strategist after reopening the ChatGPT login flow."
            : "Retrying the background strategist research automatically.",
      budget: {
        ...session.budget,
        usedRetries: nextUsedRetries
      }
    });
    this.registerActiveAutomationStrategistSession(controller, strategistStep.id, retrySlug);
    await this.store.appendActivity(
      workspacePath,
      `${session.id} auto-restarted background strategist lane ${strategistStep.id} after ${failureMessage}`
    );
    return true;
  }

  private clearStrategistChatProgress(
    workspacePath: string,
    threadId: string,
    artifacts: ReturnType<AppService["resolveStrategistDecisionArtifacts"]> | null
  ) {
    this.clearChatProgressIfCurrentMatches(
      workspacePath,
      threadId,
      "automation-strategist",
      artifacts?.stdoutPath,
      artifacts?.stderrPath
    );
    this.clearChatProgressIfCurrentMatches(
      workspacePath,
      threadId,
      "strategist",
      artifacts?.stdoutPath,
      artifacts?.stderrPath
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
        currentStepSummary: "Resuming the in-flight builder step after the app restarted."
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
      this.registerActiveAutomationBuilderRun(controller, builderStep.id, run.id);
      const completedSnapshot =
        inspection?.run && inspection.run.finalization !== null && inspection.run.status !== "running"
          ? await this.store.getSnapshot(workspacePath)
          : await this.waitForAutomationRun(workspacePath, run.id, controller);
      this.clearActiveAutomationBuilderRun(controller, builderStep.id);
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
      this.clearActiveAutomationBuilderRun(controller, builderStep.id);
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
    const activeOracleProcess = await inspectActiveOracleProcessBySlug(strategistSlug);
    const strategistArtifacts = this.resolveStrategistDecisionArtifacts(
      workspacePath,
      strategistStep,
      activeOracleProcess
    );
    const recoveredDecision = await this.recoverStrategistDecisionIfReady(
      workspacePath,
      session,
      strategistStep,
      strategistSlug,
      strategistArtifacts,
      activeOracleProcess
    );

    if (recoveredDecision) {
      await this.oracleRunner.terminateSession?.(strategistSlug).catch(() => undefined);
      this.clearActiveAutomationStrategistSession(controller, strategistStep.id);
      this.clearStrategistChatProgress(workspacePath, session.threadId, strategistArtifacts);
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

    if (strategistStep.workerMode === "async") {
      if (activeOracleProcess) {
        this.registerActiveAutomationStrategistSession(controller, strategistStep.id, strategistSlug);

        if (
          strategistArtifacts &&
          (await this.isAsyncStrategistStalled(workspacePath, strategistStep, strategistArtifacts))
        ) {
          const failureMessage = await this.resolveAsyncStrategistFailureMessage(
            strategistSlug,
            strategistArtifacts,
            "Background strategist research stalled without producing a usable answer."
          );
          await this.oracleRunner.terminateSession?.(strategistSlug).catch(() => undefined);
          this.clearActiveAutomationStrategistSession(controller, strategistStep.id);
          this.clearStrategistChatProgress(workspacePath, session.threadId, strategistArtifacts);

          if (
            await this.retryBackgroundStrategistStep(
              workspacePath,
              session,
              controller,
              strategistStep,
              strategistSlug,
              strategistArtifacts,
              activeOracleProcess,
              failureMessage
            )
          ) {
            return {
              handled: true,
              shouldStopLoop: false
            };
          }

          await this.completeAutomationStep(workspacePath, session, strategistStep, {
            status: "failed",
            summary: failureMessage,
            changedFiles: [],
            evidence: failureMessage ? [failureMessage] : []
          });
          const language = resolveAutomationUiLanguage([
            session.displayObjective ?? "",
            session.objective,
            failureMessage
          ]);
          await this.writeRunningAutomationSession(workspacePath, session, {
            currentStepSummary: isStrategistBrowserBlockedFailure(failureMessage)
              ? language === "ko"
                ? "다음 strategist 새로고침 전에 백그라운드 strategist 브랜치 점검이 필요합니다."
                : "The background strategist branch needs attention before the next strategist refresh."
              : language === "ko"
                ? "백그라운드 strategist 브랜치가 끝나서 최신 저장 상태로 계속 진행합니다."
                : "The background strategist branch ended. Continuing with the latest saved state."
          });
          await this.store.appendActivity(
            workspacePath,
            `${session.id} background strategist lane ${strategistStep.id} ended: ${failureMessage}`
          );

          return {
            handled: true,
            shouldStopLoop: false
          };
        }

        if (!/background strategist research is still running/i.test(session.currentStepSummary)) {
          await this.writeRunningAutomationSession(workspacePath, session, {
            currentStepSummary: "Background strategist research is still running while automation continues."
          });
        }

        return {
          handled: false,
          shouldStopLoop: false
        };
      }

      const failureMessage = await this.resolveAsyncStrategistFailureMessage(
        strategistSlug,
        strategistArtifacts,
        "Background strategist research ended without producing a usable answer."
      );
      this.clearActiveAutomationStrategistSession(controller, strategistStep.id);
      this.clearStrategistChatProgress(workspacePath, session.threadId, strategistArtifacts);

      if (
        strategistArtifacts &&
        (await this.retryBackgroundStrategistStep(
          workspacePath,
          session,
          controller,
          strategistStep,
          strategistSlug,
          strategistArtifacts,
          activeOracleProcess,
          failureMessage
        ))
      ) {
        return {
          handled: true,
          shouldStopLoop: false
        };
      }

      await this.completeAutomationStep(workspacePath, session, strategistStep, {
        status: "failed",
        summary: failureMessage,
        changedFiles: [],
        evidence: failureMessage ? [failureMessage] : []
      });
      const language = resolveAutomationUiLanguage([
        session.displayObjective ?? "",
        session.objective,
        failureMessage
      ]);
      await this.writeRunningAutomationSession(workspacePath, session, {
        currentStepSummary: isStrategistBrowserBlockedFailure(failureMessage)
          ? language === "ko"
            ? "다음 strategist 새로고침 전에 백그라운드 strategist 브랜치 점검이 필요합니다."
            : "The background strategist branch needs attention before the next strategist refresh."
          : language === "ko"
            ? "백그라운드 strategist 브랜치가 끝나서 최신 저장 상태로 계속 진행합니다."
            : "The background strategist branch ended. Continuing with the latest saved state."
      });
      await this.store.appendActivity(
        workspacePath,
        `${session.id} background strategist lane ${strategistStep.id} ended: ${failureMessage}`
      );

      return {
        handled: true,
        shouldStopLoop: false
      };
    }

    if (!/resuming the in-flight strategist step/i.test(session.currentStepSummary)) {
      await this.writeRunningAutomationSession(workspacePath, session, {
        currentStepSummary: "Resuming the in-flight strategist step after the app restarted."
      });
    }

    if (activeOracleProcess) {
      this.registerActiveAutomationStrategistSession(controller, strategistStep.id, strategistSlug);

      try {
        const waitedDecision = await this.waitForRecoveredStrategistDecision(
          workspacePath,
          session,
          strategistStep,
          controller,
          strategistSlug,
          activeOracleProcess
        );

        if (waitedDecision) {
          this.clearStrategistChatProgress(workspacePath, session.threadId, strategistArtifacts);
          await this.completeAutomationStep(workspacePath, session, strategistStep, {
            status: "completed",
            summary: waitedDecision.summary || "Recovered the interrupted strategist step.",
            decisionId: waitedDecision.id,
            changedFiles: [],
            evidence: waitedDecision.summary ? [waitedDecision.summary] : []
          });

          return {
            handled: true,
            shouldStopLoop: false
          };
        }
      } finally {
        this.clearActiveAutomationStrategistSession(controller, strategistStep.id);
      }
    }

    this.clearStrategistChatProgress(workspacePath, session.threadId, strategistArtifacts);
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
      currentStepSummary: "Retrying the interrupted strategist step after the app restarted."
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
      objective: resolveAutomationActiveInstruction(session, redirectInstruction),
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
      promptPreview: redirectInstruction || session.displayObjective || session.objective,
      progressSummary: "",
      progressDetails: [],
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
      resolveAutomationActiveInstruction(session, redirectInstruction)
    );
    const automationDelegation = delegations.find(
      (delegation): delegation is Extract<OrchestratorDelegationDirective, { lane: "automation" }> =>
        delegation.lane === "automation"
    );
    const plannedWorkerDelegations = delegations.filter(
      (delegation): delegation is AutomationWorkerDelegation =>
        delegation.lane === "builder" || delegation.lane === "strategist"
    );
    const hasRunningBackgroundStrategist = await this.hasRunningBackgroundStrategistStep(
      workspacePath,
      session.id
    );
    const automationSessionPatch = buildAutomationDelegationSessionPatch({
      automationDelegation,
      session: activeSession,
      redirectInstruction
    });

    if (Object.keys(automationSessionPatch).length > 0) {
      activeSession = await this.writeRunningAutomationSession(
        workspacePath,
        activeSession,
        automationSessionPatch
      );
    }

    const explicitCheckpointPause = shouldPauseForAutomationDelegation({
      automationDelegation,
      session: activeSession,
      redirectInstruction
    });
    const refreshStrategistDelegation = buildRequiredAutomationStrategistDelegation({
      existingDelegations: plannedWorkerDelegations,
      hasAutomationDelegation: explicitCheckpointPause,
      hasRunningBackgroundStrategist,
      session: activeSession,
      redirectInstruction,
      languagePreference: appSettings.autopilotPromptLanguage,
      snapshot
    });
    const fallbackStrategistDelegation = buildFallbackAutomationStrategistDelegation({
      automationDelegation,
      existingDelegations: refreshStrategistDelegation
        ? [...plannedWorkerDelegations, refreshStrategistDelegation]
        : plannedWorkerDelegations,
      hasRunningBackgroundStrategist,
      session: activeSession,
      redirectInstruction,
      languagePreference: appSettings.autopilotPromptLanguage,
      snapshot
    });
    const augmentedWorkerDelegations = [
      ...plannedWorkerDelegations,
      ...(refreshStrategistDelegation ? [refreshStrategistDelegation] : []),
      ...(fallbackStrategistDelegation ? [fallbackStrategistDelegation] : [])
    ];
    const workerDelegations = hasRunningBackgroundStrategist
      ? plannedWorkerDelegations.filter(
          (delegation) =>
            delegation.lane !== "strategist" ||
            resolveStrategistWorkerMode(delegation.workerMode) !== "async"
        )
      : augmentedWorkerDelegations;
    const skippedDuplicateBackgroundStrategist =
      hasRunningBackgroundStrategist && workerDelegations.length !== augmentedWorkerDelegations.length;

    const plannerSummary =
      planningReply ||
      summarizeAutomationPlannerResult(workerDelegations, automationDelegation) ||
      "The automation planner did not launch a concrete worker step.";

    await this.completeAutomationStep(workspacePath, activeSession, planningStep, {
      status:
        automationDelegation || workerDelegations.length || skippedDuplicateBackgroundStrategist
          ? "completed"
          : "failed",
      summary: plannerSummary,
      changedFiles: [],
      evidence: planningReply ? [planningReply] : []
    });
    await this.writeAutomationCycle(workspacePath, cycle, {
      plannerReply: planningReply || undefined,
      plannerSessionId: activeSession.plannerSessionId,
      summary: plannerSummary,
      phase: workerDelegations.length || skippedDuplicateBackgroundStrategist ? "workers" : "planning",
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

    if (explicitCheckpointPause && automationDelegation && !workerDelegations.length) {
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

    if (!workerDelegations.length && hasRunningBackgroundStrategist && !explicitCheckpointPause) {
      await this.writeRunningAutomationSession(workspacePath, activeSession, {
        currentStepSummary: "A background strategist branch is still running. Waiting for fresh research before replanning."
      });
      await sleep(ASYNC_STRATEGIST_POLL_INTERVAL_MS);
      return {
        handled: true,
        shouldStopLoop: false
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
    const followupFallbackReply = summarizeAutomationWorkerResultsForConversation(workerTurn.results);
    const followupReportFingerprint = buildAutomationConversationReportFingerprint(workerTurn.results);
    const shouldPublishFollowup = shouldPublishAutomationConversationReport(
      activeSession,
      followupReportFingerprint
    );
    const lastPublishedUpdate = findLatestAutomationConversationUpdate(
      refreshedSnapshot.conversationEntries ?? [],
      activeSession.threadId
    );
    let followupReply = followupFallbackReply;

    if (shouldPublishFollowup) {
      const followupPrompt = buildAutomationOrchestratorFollowupPrompt({
        objective: redirectInstruction || activeSession.displayObjective || activeSession.objective,
        results: workerTurn.results,
        language: resolveConversationLanguageFromEntries(
          refreshedSnapshot.conversationEntries ?? [],
          activeSession.threadId
        ),
        lastPublishedUpdate
      });

      this.setChatProgress(workspacePath, {
        lane: "orchestrator",
        threadId: refreshedThread.id,
        promptPreview: redirectInstruction || activeSession.displayObjective || activeSession.objective,
        progressSummary: "",
        progressDetails: [],
        activeCommand: null,
        stdoutPath: path.join(requestDir, "orchestrator.automation.followup.stdout.log"),
        stderrPath: path.join(requestDir, "orchestrator.automation.followup.stderr.log"),
        operationId: "automation-orchestrator"
      });

      let followupTurn: Awaited<ReturnType<NonNullable<typeof this.orchestratorRunner>["runTurn"]>>;

      try {
        const followupContext = await this.store.buildRuntimeContext(workspacePath, followupPrompt, {
          lane: "builder",
          omitRecentAutomationAssistantEntries: true
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

      followupReply = sanitizeConversationBody(followupTurn.finalMessage) || followupFallbackReply;
    }

    const relatedDecisionId = workerTurn.results.some(
      (result) => result.lane === "strategist" && !result.pending
    )
      ? refreshedSnapshot.latestDecision?.id
      : undefined;
    const relatedRunId = workerTurn.results.some((result) => result.lane === "builder")
      ? refreshedSnapshot.latestRun?.id
      : undefined;

    if (shouldPublishFollowup) {
      const appendedFollowupEntry = await this.appendAutomationAssistantEntry(workspacePath, {
        session: activeSession,
        body: followupReply,
        decisionId: relatedDecisionId,
        runId: relatedRunId,
        cycleId: cycle.id
      });

      if (appendedFollowupEntry) {
        activeSession = await this.persistAutomationConversationReportFingerprint(
          workspacePath,
          activeSession,
          followupReportFingerprint
        );
      }
    }

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

    const backgroundStrategistResult = workerTurn.results.find(
      (result): result is AutomationDelegatedStrategistResult => result.lane === "strategist" && Boolean(result.pending)
    );

    if (backgroundStrategistResult) {
      await this.writeRunningAutomationSession(workspacePath, activeSession, {
        currentStepSummary: "Background strategist research is still running while the automation loop continues."
      });
      await sleep(ASYNC_STRATEGIST_POLL_INTERVAL_MS);
      return {
        handled: true,
        shouldStopLoop: false
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
    const configuredStrategistModel = normalizeStrategistModel(delegation.model ?? appSettings.strategistModel);
    const project = await this.store.initProject(workspacePath, {
      ...(await this.resolveProjectDefaults(workspacePath)),
      oracleModel: configuredStrategistModel
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
    const strategistSubmission = await this.prepareStrategistSubmission({
      workspacePath,
      prompt: delegation.prompt,
      displayPrompt,
      snapshot,
      activeThread,
      artifactId: decisionPaths.id,
      attachExplicitWorkspaceFiles: delegation.attachExplicitWorkspaceFiles
    });
    const strategistModel = configuredStrategistModel ?? project.oracleModel;
    const strategistReasoningIntensity = normalizeStrategistThinkingTime(
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
      files: strategistSubmission.files,
      rawPrompt: strategistSubmission.oraclePrompt,
      runtimeContext: strategistSubmission.runtimeContext,
      contextPackPath: strategistSubmission.contextPackPath,
      strategistReferenceDigestPath: strategistSubmission.strategistReferenceDigestPath
    });

    this.setChatProgress(workspacePath, {
      lane: "strategist",
      threadId: activeThread.id,
      promptPreview: displayPrompt,
      progressSummary: "",
      progressDetails: [],
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
      prompt: strategistSubmission.oraclePrompt,
      model: strategistModel,
      browserThinkingTime: strategistReasoningIntensity,
      files: strategistSubmission.files,
      stdoutPath: decisionPaths.stdoutPath,
      stderrPath: decisionPaths.stderrPath,
      outputPath: decisionPaths.outputPath,
      slug: strategistSlug,
      strategistSessionReady: appSettings.strategistSessionReady
    });

    const updatedStep: AutomationStepRecord = {
      ...strategistStep,
      resumeCursor: strategistSlug,
      startedSideEffects: Array.from(
        new Set(
          [
            ...(strategistStep.startedSideEffects ?? []),
            ...buildAutomationStrategistLaunchSideEffects({
              sessionSlug: strategistSlug,
              decisionArtifactsId: decisionPaths.id,
              model: strategistModel,
              reasoningIntensity: strategistReasoningIntensity,
              files: strategistSubmission.files,
              attempt: 1
            })
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
    const displayPrompt = resolveAutomationActiveInstruction(session, redirectInstruction);

    if (delegation.lane === "strategist") {
      const strategistWorkerMode = resolveStrategistWorkerMode(delegation.workerMode);
      let strategistStep = await this.createAutomationStep(workspacePath, session, {
        cycleId: cycle.id,
        kind: "literature-search",
        lane: "strategist",
        workerMode: strategistWorkerMode,
        title: "Run the next strategist research branch",
        prompt: delegation.prompt
      });
      const strategistDisplayPrompt = `[Autopilot] ${displayPrompt}`;
      const strategistSlug = buildAutomationStrategistSessionSlug(workspacePath, session, cycle, strategistStep);
      const progressOperationId = `automation-strategist-${strategistStep.id}`;

      if (strategistWorkerMode === "async") {
        const startedStrategist = await this.startAutomationStrategistLane(
          workspacePath,
          session,
          cycle,
          strategistStep,
          delegation,
          displayPrompt,
          appSettings,
          progressOperationId
        );
        this.registerActiveAutomationStrategistSession(
          controller,
          startedStrategist.step.id,
          startedStrategist.strategistSlug
        );

        return {
          lane: delegation.lane,
          delegation,
          step: startedStrategist.step,
          decision: null,
          pending: true
        };
      }

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

      this.registerActiveAutomationStrategistSession(controller, strategistStep.id, strategistSlug);

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
        this.clearActiveAutomationStrategistSession(controller, strategistStep.id);
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
    const progressOperationId = `automation-builder-${builderStep.id}`;
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
          ? (this.registerActiveAutomationBuilderRun(controller, builderStep.id, runId),
            await this.waitForAutomationRun(workspacePath, runId, controller))
          : await this.store.getSnapshot(workspacePath);

      this.clearActiveAutomationBuilderRun(controller, builderStep.id);
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
      this.clearActiveAutomationBuilderRun(controller, builderStep.id);
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
      objective: resolveAutomationActiveInstruction(input.session, input.redirectInstruction ?? ""),
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

    this.registerActiveAutomationStrategistSession(
      this.getAutomationController(workspacePath, input.session.id),
      strategizeStep.id,
      strategistSessionSlug
    );

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
          reasoningIntensity: "extended"
        },
        {
          strategistSessionReady: appSettings.strategistSessionReady
        }
      );
    } finally {
      this.clearActiveAutomationStrategistSession(
        this.getAutomationController(workspacePath, input.session.id),
        strategizeStep.id
      );
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
    this.cleanupAutomationController(workspacePath, input.session.id);
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
    const artifacts = this.resolveStrategistDecisionArtifacts(workspacePath, strategistStep, oracleProcess);

    if (!artifacts) {
      return null;
    }

    while (true) {
      if (controller.stopRequested) {
        await this.oracleRunner.terminateSession?.(strategistSlug).catch(() => undefined);
        return null;
      }

      const recoveredDecision = await this.recoverStrategistDecisionIfReady(
        workspacePath,
        session,
        strategistStep,
        strategistSlug,
        artifacts,
        oracleProcess
      );

      if (recoveredDecision) {
        return recoveredDecision;
      }

      if (!(await isProcessAlive(oracleProcess.pid))) {
        break;
      }

      await sleep(900);
    }

    return await this.recoverStrategistDecisionIfReady(
      workspacePath,
      session,
      strategistStep,
      strategistSlug,
      artifacts,
      oracleProcess
    );
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
          await this.terminatePersistedAutomationWorkers(workspacePath, session, controller);
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

        const fallbackCycle = await this.ensureAutomationCycle(workspacePath, session, {
          title: "Automation cycle",
          objective: resolveAutomationActiveInstruction(session, redirectInstruction),
          plannerPrompt: resolveAutomationActiveInstruction(session, redirectInstruction),
          summary: "Continuing with the fallback automation cycle."
        });

        const shouldConsultStrategist = shouldRefreshAutomationStrategist({
          redirectInstruction,
          latestRun: snapshot.latestRun,
          latestCheckpoint: snapshot.latestAutomationCheckpoint,
          latestDecision: snapshot.latestDecision
        });
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
            cycleId: fallbackCycle.id,
            kind: "strategize",
            lane: "strategist",
            workerMode: "async",
            title: "Plan the next bounded research step",
            prompt: strategizePrompt
          });
          const strategistSessionSlug = buildAutomationStrategistSessionSlug(
            workspacePath,
            session,
            fallbackCycle,
            strategizeStep
          );
          strategizeStep = {
            ...strategizeStep,
            resumeCursor: strategistSessionSlug,
            startedSideEffects: [`oracle-session:${strategistSessionSlug}`],
            updatedAt: new Date().toISOString()
          };
          await this.store.writeAutomationStep(workspacePath, strategizeStep);
          this.registerActiveAutomationStrategistSession(controller, strategizeStep.id, strategistSessionSlug);
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
            this.clearActiveAutomationStrategistSession(controller, strategizeStep.id);
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

        const builderDisplayPrompt = resolveAutomationActiveInstruction(session, redirectInstruction);
        const builderPrompt = buildContextDrivenBuilderPrompt(
          builderDisplayPrompt,
          latestDecision,
          appSettings.autopilotPromptLanguage
        );
        let builderStep = await this.createAutomationStep(workspacePath, session, {
          cycleId: fallbackCycle.id,
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
          this.registerActiveAutomationBuilderRun(controller, builderStep.id, runId);
          const completedSnapshot = runId
            ? await this.waitForAutomationRun(workspacePath, runId, controller)
            : await this.store.getSnapshot(workspacePath);
          this.clearActiveAutomationBuilderRun(controller, builderStep.id);
          latestRun = completedSnapshot.latestRun;
          runStatus = latestRun?.status ?? "failed";
          runSummary = handoffMachineSummary(latestRun?.handoff) || extractRunSummary(latestRun?.finalMessage ?? "");
          runChangedFiles = latestRun?.changedFiles ?? [];
          runEvidence = buildAutomationEvidence(latestRun);
          runRisks = latestRun?.handoff?.risks ?? [];
          runActions = latestRun?.handoff?.runActions ?? [];
        } catch (error) {
          this.clearActiveAutomationBuilderRun(controller, builderStep.id);
          runStatus = "failed";
          runSummary = error instanceof Error ? error.message : String(error);
          runChangedFiles = [];
          runEvidence = runSummary ? [runSummary] : [];
          runRisks = runSummary ? [runSummary] : [];
          runActions = [];
        }

        const shouldStopLoop = await this.applyAutomationBuilderOutcome(workspacePath, {
          session,
          cycle: fallbackCycle,
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
        const nextUsedRetries = session.budget.usedRetries + 1;

        if (
          session.mode === "continuous" &&
          isRetryableStrategistControllerFailure(failureMessage) &&
          nextUsedRetries < session.budget.maxRetries
        ) {
          const language = resolveAutomationUiLanguage([
            session.displayObjective ?? "",
            session.objective,
            failureMessage
          ]);
          const retryMessage =
            language === "ko"
              ? "Strategist 브라우저 단계가 빈 응답으로 끝나서 자동으로 한 번 더 다시 시도하고 있습니다. 창은 그대로 두고 잠시만 기다려 주세요."
              : "The strategist browser step ended with an empty reply, so Lithium is retrying it automatically. Please keep the browser window open for a moment.";

          await this.writeRunningAutomationSession(workspacePath, session, {
            currentStepSummary:
              language === "ko"
                ? "Strategist 브라우저 단계를 자동으로 다시 시도하고 있습니다."
                : "Retrying the strategist browser step automatically.",
            budget: {
              ...session.budget,
              usedRetries: nextUsedRetries
            }
          });
          await this.appendAutomationStatusEntry(workspacePath, {
            session,
            body: retryMessage
          });
          await this.store.appendActivity(
            workspacePath,
            `${session.id} automation retry queued after strategist browser produced no usable output`
          );
          shouldRestartAfterFailure = true;
          return;
        }

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
      controller.activeBuilderRuns.clear();
      controller.activeStrategistSessions.clear();
      const latestSession = await this.store.readAutomationSession(workspacePath, sessionId).catch(() => null);

      if (!shouldRestartAfterFailure && latestSession?.status !== "running") {
        this.cleanupAutomationController(workspacePath, sessionId);
      }

      if (shouldRestartAfterFailure) {
        this.scheduleAutomationLoop(workspacePath, sessionId);
      }
    }
  }

  private scheduleAutomationLoop(workspacePath: string, sessionId: string) {
    void this.runAutomationLoop(workspacePath, sessionId).catch(() => undefined);
  }

  private async waitForAutomationRun(
    workspacePath: string,
    runId: string,
    controller: AutomationControllerState
  ) {
    while (true) {
      if (controller.stopRequested) {
        await this.terminateBuilderRun({
          workspacePath,
          runId
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
        this.runtime.markRunTerminating(runId);

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
          this.runtime.clearRunTerminating(runId);
        }
      }

      if (inspection.suggestedStatus === "hung" && inspection.run) {
        this.runtime.markRunTerminating(runId);

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
          this.runtime.clearRunTerminating(runId);
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
    if (nextStep.status !== "running" && (input.decisionId || input.runId)) {
      await this.appendAutomationWorkerHistory(workspacePath, {
        session: currentSession,
        step: nextStep,
        decisionId: input.decisionId,
        runId: input.runId
      });
    }
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
    this.runtime.setChatProgress(workspacePath, input);
  }

  private clearChatProgress(workspacePath: string, threadId?: string, operationId?: string) {
    this.runtime.clearChatProgress(workspacePath, threadId, operationId);
  }

  private clearChatProgressIfCurrentMatches(
    workspacePath: string,
    threadId: string,
    operationId: string,
    stdoutPath?: string,
    stderrPath?: string
  ) {
    this.runtime.clearChatProgressIfCurrentMatches(
      workspacePath,
      threadId,
      operationId,
      stdoutPath,
      stderrPath
    );
  }

  private listChatProgressEntries(workspacePath: string, threadId?: string) {
    return this.runtime.listChatProgressEntries(workspacePath, threadId);
  }

  private getLatestChatProgressEntry(
    workspacePath: string,
    threadId?: string,
    lane?: ActiveChatProgress["lane"]
  ) {
    return this.runtime.getLatestChatProgressEntry(workspacePath, threadId, lane);
  }

  private rememberConversationLanguage(
    workspacePath: string,
    entry: Pick<ConversationEntryRecord, "threadId" | "role" | "body">
  ) {
    this.runtime.rememberConversationLanguage(workspacePath, entry, (body) =>
      resolveConversationLanguageFromBodies([body])
    );
  }

  private async resolveThreadConversationLanguage(
    workspacePath: string,
    threadId?: string
  ): Promise<"ko" | "en"> {
    const normalizedThreadId = threadId?.trim();

    if (!normalizedThreadId) {
      return "en";
    }

    const cached = this.runtime.getConversationLanguage(workspacePath, normalizedThreadId);

    if (cached) {
      return cached;
    }

    const entries = await this.store.listConversationEntries(workspacePath).catch(() => []);
    const language = resolveConversationLanguageFromEntries(entries, normalizedThreadId);
    this.runtime.rememberConversationLanguage(
      workspacePath,
      {
        threadId: normalizedThreadId,
        role: "user",
        body: entries
          .filter((entry) => entry.threadId === normalizedThreadId)
          .map((entry) => entry.body)
          .join("\n")
      },
      () => language
    );
    return language;
  }

  private rememberObservedChatProgress(
    workspacePath: string,
    current: ActiveChatProgress,
    inspection: ChatProgressInspection
  ) {
    if (!hasMeaningfulChatProgressNarration(inspection.progressSummary, inspection.progressDetails)) {
      return;
    }

    this.runtime.rememberObservedChatProgress(workspacePath, current, inspection);
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
  const softened = normalized
    .replace(/^(?:(?:잠깐|잠시|일단|우선|그냥|지금|좀|제발|please|just)\s+)+/i, "")
    .trim();

  if (!normalized) {
    return false;
  }

  return [normalized, softened].some((candidate) => {
    if (!candidate) {
      return false;
    }

    return (
      /^(?:stop|pause|halt|hold|cancel|멈춰|중단|중지|정지|일단 멈춰|그만)(?:\b|$)/i.test(candidate) ||
      /^(?:autopilot|automation|auto(?:\s|-)?research|연구|자동\s*연구|자동연구)(?:를|을|은|는|만)?\s*(?:stop|pause|halt|cancel|멈춰|멈춰줘|중단|중단해|중단해줘|중지|중지해|정지|정지해|그만|꺼|꺼줘)(?:\b|$)/i.test(
        candidate
      ) ||
      /^(?:stop|pause|halt|cancel|멈춰|중단|중지|정지|그만|꺼|꺼줘)\s*(?:the\s+)?(?:autopilot|automation|auto(?:\s|-)?research|연구|자동\s*연구|자동연구)(?:\b|$)/i.test(
        candidate
      )
    );
  });
}

function looksLikeAutomationQuestion(instruction: string) {
  return looksLikeAutomationQuestionWithMode(instruction, {
    loose: true
  });
}

function looksLikeExplicitAutomationQuestion(instruction: string) {
  return looksLikeAutomationQuestionWithMode(instruction, {
    loose: false
  });
}

function looksLikeAutomationQuestionWithMode(
  instruction: string,
  options: {
    loose: boolean;
  }
) {
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

  if (
    /(?:progress|status|update|report|summary|진행사항|현황|상태|보고|업데이트|요약).*(?:알려줘|말해줘|설명해줘|정리해줘)/i.test(
      normalized
    )
  ) {
    return true;
  }

  if (!options.loose) {
    return false;
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

function hasMeaningfulChatProgressNarration(summary: string, details: string[]) {
  const normalizedSummary = summary.trim();
  const normalizedDetails = details
    .map((detail) => detail.trim())
    .filter(Boolean);

  return Boolean(normalizedSummary || normalizedDetails.length);
}

function classifyAutomationChatIntent(instruction: string): "resume" | "redirect" | "question" | "stop" {
  if (looksLikeAutomationStopInstruction(instruction)) {
    return "stop";
  }

  const explicitQuestion = looksLikeExplicitAutomationQuestion(instruction);
  const resumeInstruction = looksLikeAutomationResumeInstruction(instruction);

  if (!explicitQuestion && resumeInstruction) {
    return "resume";
  }

  if (looksLikeAutomationQuestion(instruction)) {
    return "question";
  }

  if (resumeInstruction) {
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
    return [liveFocus, latestResult, liveStepSummary]
      .map((value) => value.trim())
      .filter(Boolean)[0] || input.instruction.trim();
  }

  return input.instruction.trim();
}

export function buildAutomationContinuationAdvisorPrompt(input: {
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
  const latestInstruction = resolveAutomationActiveInstruction(
    input.session,
    input.redirectInstruction
  );
  const latestDecisionSummary =
    handoffMachineSummary(input.latestDecision?.handoff) || input.latestDecision?.summary || "";
  const latestRunSummaryCandidate =
    handoffMachineSummary(input.latestRun?.handoff) ||
    input.runSummary.trim() ||
    extractRunSummary(input.latestRun?.finalMessage || "");
  const latestCheckpointSummary = input.latestCheckpoint?.summary?.trim() || "";
  const strategistPerspective = getStrategistPerspectiveLabel("gpt-5.4-pro");
  const promptLanguage = resolveAutomationPromptLanguage(input.languagePreference, [
    latestInstruction,
    latestDecisionSummary,
    latestRunSummaryCandidate,
    latestCheckpointSummary,
    input.failureMessage
  ]);
  const latestRunSummary =
    humanizeAutomationUiIssue(latestRunSummaryCandidate, promptLanguage) || latestRunSummaryCandidate;

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
      `현재 사용자 목표: ${latestInstruction}`,
      issueSummaryKo,
      latestDecisionSummary ? `현재 최신 전략 요약: ${latestDecisionSummary}` : "",
      latestRunSummary ? `현재 최신 실행 요약: ${latestRunSummary}` : "",
      latestCheckpointSummary ? `직전 체크포인트 요약: ${latestCheckpointSummary}` : "",
      input.runRisks.length ? formatPromptList("Failure risks", input.runRisks) : "",
      input.runActions.length ? formatPromptList("Suggested next actions", input.runActions) : "",
      "이 자동 연구는 continuous 모드이며, 웬만하면 여기서 멈추지 말고 계속 진행해야 합니다.",
      `지금 상황을 큰 분기로 보고 ${strategistPerspective} 관점에서 다음 방향을 하나 정하세요.`,
      "답변 첫 문장을 위 목표 문구의 반복으로 시작하지 말고, 현재 상태 변화와 판단으로 바로 들어가세요.",
      "응답의 맨 앞에는 사용자가 읽을 짧은 진행 보고를 같은 언어로 자연스럽게 적고, 그 뒤에는 왜 그 방향이 맞는지와 바로 실행할 다음 bounded step을 정리하세요.",
      "외부 의존성이나 실제 사용자 선호가 없으면 진행 자체가 불가능한 경우에만 다시 물어보세요. 그때만 needs_user_checkpoint=true 또는 automation_mode=checkpoint/blocked를 쓰세요.",
      "그 외에는 자동으로 계속 진행할 수 있게 방향을 고르고, 이 채팅에 보고한 뒤 바로 이어서 실행 가능한 상태로 넘기세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    `Current user goal: ${latestInstruction}`,
    issueSummary,
    latestDecisionSummary ? `Latest strategy summary: ${latestDecisionSummary}` : "",
    latestRunSummary ? `Latest run summary: ${latestRunSummary}` : "",
    latestCheckpointSummary ? `Latest checkpoint summary: ${latestCheckpointSummary}` : "",
    input.runRisks.length ? formatPromptList("Failure risks", input.runRisks) : "",
    input.runActions.length ? formatPromptList("Suggested next actions", input.runActions) : "",
    "This automation is in continuous mode, so it should keep moving unless there is a truly blocking reason to stop.",
    `Treat the current situation as a major branch and decide the next direction from a ${strategistPerspective} perspective.`,
    "Do not begin by repeating that goal wording verbatim; translate it into the current state change and judgment immediately.",
    "Start your answer with a brief user-facing progress update in the same language as the recent chat, then explain why that direction is right and name the next bounded step that should run immediately.",
    "Only ask the user again if an external dependency or a real preference choice makes progress impossible. Only in that case should you use needs_user_checkpoint=true or automation_mode=checkpoint/blocked.",
    "Otherwise choose a direction that lets automation continue, report it naturally in chat, and hand off the next executable bounded step."
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildAutomationOrchestratorPrompt(input: {
  session: AutomationSessionRecord;
  redirectInstruction: string;
  languagePreference: AppSettings["autopilotPromptLanguage"];
  snapshot: ProjectSnapshot;
}) {
  const latestInstruction = resolveAutomationActiveInstruction(input.session, input.redirectInstruction);
  const visibleGoal = input.session.displayObjective?.trim() || input.session.objective.trim();
  const latestDecisionSummary = input.snapshot.latestDecision?.summary?.trim() || "";
  const latestRunSummary =
    handoffMachineSummary(input.snapshot.latestRun?.handoff) ||
    extractRunSummary(input.snapshot.latestRun?.finalMessage || "");
  const latestCheckpointSummary = input.snapshot.latestAutomationCheckpoint?.summary?.trim() || "";
  const strategistRefreshReason = describeAutomationStrategistRefreshNeed({
    redirectInstruction: input.redirectInstruction,
    latestRun: input.snapshot.latestRun,
    latestCheckpoint: input.snapshot.latestAutomationCheckpoint,
    latestDecision: input.snapshot.latestDecision
  });
  const recentUserMessages = summarizeRecentAutomationUserMessages(input.snapshot, input.session);
  const promptLanguage = resolveAutomationPromptLanguage(input.languagePreference, [
    latestInstruction,
    visibleGoal,
    ...recentUserMessages,
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
      `현재 가장 우선할 사용자 지시: ${latestInstruction}`,
      visibleGoal ? `사용자에게 보이는 목표: ${visibleGoal}` : "",
      recentUserMessages.length ? formatPromptList("최근 사용자 메시지", recentUserMessages) : "",
      budgetSummary,
      latestDecisionSummary ? `최신 전략 요약: ${latestDecisionSummary}` : "",
      latestRunSummary ? `최신 실행 요약: ${latestRunSummary}` : "",
      latestCheckpointSummary ? `직전 체크포인트: ${latestCheckpointSummary}` : "",
      strategistRefreshReason
        ? `전략 새로고침 필요: ${strategistRefreshReason}. 이번 cycle에서는 strategist branch를 async로 포함하는 쪽을 우선하세요.`
        : "",
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
    `Current top-priority user instruction: ${latestInstruction}`,
    visibleGoal ? `Visible goal: ${visibleGoal}` : "",
    recentUserMessages.length ? formatPromptList("Recent user messages", recentUserMessages) : "",
    budgetSummary,
    latestDecisionSummary ? `Latest strategy summary: ${latestDecisionSummary}` : "",
    latestRunSummary ? `Latest run summary: ${latestRunSummary}` : "",
    latestCheckpointSummary ? `Latest checkpoint: ${latestCheckpointSummary}` : "",
    strategistRefreshReason
      ? `Strategist refresh needed: ${strategistRefreshReason}. In this cycle, prefer including an async strategist branch.`
      : "",
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
  results: AutomationDelegatedWorkerResult[];
  language: "ko" | "en";
  lastPublishedUpdate?: string;
}) {
  const sections = [...input.results]
    .sort((left, right) => compareConversationLanePriority(left.lane, right.lane))
    .map((result) => formatAutomationWorkerResultForFollowup(result))
    .filter(Boolean);
  const promptLanguage = input.language;

  if (promptLanguage === "ko") {
    return [
      `자동 연구 목표: ${input.objective.trim()}`,
      input.lastPublishedUpdate ? `직전 사용자용 자동 보고: ${input.lastPublishedUpdate}` : "",
      ...sections,
      "이 답변은 자동 연구의 사용자용 진행 보고입니다.",
      "2~4문장 정도로만 짧게 답하고, 무엇이 달라졌는지, 왜 중요한지, 다음에 무엇을 할지를 쉬운 말로 정리하세요.",
      "직전 사용자용 자동 보고와 비교해 이번에 실제로 바뀐 점부터 먼저 말하세요.",
      "안 바뀐 baseline, gate, hold 문구는 바뀌지 않았다면 다시 길게 풀어쓰지 마세요.",
      "결과를 이해하는 데 꼭 필요한 metric 1개 정도만 넣고, command, env var, 내부 파일 경로, run id, bounded cycle 같은 운영 디테일은 사용자가 직접 요청하지 않은 이상 넣지 마세요.",
      "worker가 직접 말하는 듯한 톤을 피하고, 오케스트레이터가 전체 맥락을 보고 정리하는 한 명의 목소리로 쓰세요.",
      "최신 branch의 실행 play-by-play보다 전체 상태 변화와 우선순위를 먼저 말하세요. research branch가 있으면 그 판단을 framing으로 삼고 execution detail은 뒷받침 1개 정도로만 압축하세요.",
      "같은 요점을 반복하지 마세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    `Automation objective: ${input.objective.trim()}`,
    input.lastPublishedUpdate ? `Last user-facing automation update: ${input.lastPublishedUpdate}` : "",
    ...sections,
    "This reply is a user-facing progress update for the ongoing automation.",
    "Keep it to about 2-4 sentences and explain what changed, why it matters, and what happens next in simple language.",
    "Lead with what actually changed since the last user-facing automation update.",
    "Do not re-explain an unchanged baseline, gate, or hold line unless it changed in this cycle.",
    "Include at most one key metric when it materially helps. Do not include commands, env vars, internal file paths, run ids, or other operational detail unless the user explicitly asked.",
    "Do not sound like the worker speaking directly. Write as the orchestrator giving a single high-level update with the full context in view.",
    "Lead with the overall state change and priority, not the branch play-by-play. When a research branch exists, use it as the framing and compress execution detail to at most one supporting point.",
    "Do not repeat the same point."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatAutomationWorkerResultForFollowup(result: AutomationDelegatedWorkerResult) {
  if (result.lane === "builder") {
    const summary = sanitizeAutomationConversationSummary(result.runSummary);
    const nextAction = sanitizeAutomationConversationSummary(
      summarizeAutomationNextAction(result.runActions)
    );

    return [
      "Execution branch",
      `Status: ${result.runStatus}`,
      summary ? `Summary: ${summary}` : "",
      nextAction ? `Next step candidate: ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const strategistStatus = result.pending ? "running" : "completed";
  const strategistSummary = sanitizeAutomationConversationSummary(
    handoffMachineSummary(result.decision?.handoff) || result.decision?.summary || ""
  );

  return [
    "Research branch",
    `Status: ${strategistStatus}`,
    strategistSummary ? `Summary: ${strategistSummary}` : ""
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
  const strategistCount = delegations.filter((delegation) => delegation.lane === "strategist").length;
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
    ? strategistCount > 1
      ? "다음 실행 판단을 위해 strategist 리서치 분기들을 병렬로 진행하고 있습니다."
      : "다음 실행 판단을 위한 strategist 리서치를 진행하고 있습니다."
    : strategistCount > 1
    ? "Running strategist research branches in parallel for the next execution decision."
    : "Running strategist research for the next execution decision.";
}

export function buildAutomationStrategistPrompt(
  session: AutomationSessionRecord,
  redirectInstruction: string,
  languagePreference: AppSettings["autopilotPromptLanguage"],
  latestRun?: RunRecord | null,
  latestCheckpoint?: AutomationCheckpointRecord | null,
  latestDecision?: DecisionRecord | null
) {
  const latestInstruction = resolveAutomationActiveInstruction(session, redirectInstruction);
  const promptLanguage = resolveAutomationPromptLanguage(languagePreference, [
    latestInstruction,
    handoffMachineSummary(latestRun?.handoff) || extractRunSummary(latestRun?.finalMessage ?? ""),
    ...(latestRun?.handoff?.risks ?? [])
  ]);

  if (!shouldReplanAfterFailedRun(latestRun, latestCheckpoint, latestDecision)) {
    if (promptLanguage === "ko") {
      return [
        `현재 사용자 목표: ${latestInstruction.trim()}`,
        "위 문구를 그대로 반복해 답변을 시작하지 말고, 현재 상태 판단과 다음 bounded step으로 바로 요약하세요.",
        "기본적으로는 개별 실험 카드나 코드 조각의 세부 비교보다, 현재 포트폴리오 흐름, branch 우선순위, decision gate를 먼저 판단하세요.",
        "세부 로그나 코드 단편은 그 큰 흐름 판단을 지지하는 근거로만 짧게 사용하세요."
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    return [
      `Current user goal: ${latestInstruction.trim()}`,
      "Do not begin by repeating that wording verbatim. Translate it into the current state, the key judgment, and the next bounded step.",
      "Default to portfolio-level experiment flow: branch priority, decision gates, and the next bounded cycle rather than one experiment card at a time.",
      "Use detailed logs or code fragments only as supporting evidence for that higher-level judgment."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const failureSummary = handoffMachineSummary(latestRun?.handoff) || extractRunSummary(latestRun?.finalMessage ?? "");
  const failureRisks = latestRun?.handoff?.risks ?? [];

  if (promptLanguage === "ko") {
    return [
      `현재 사용자 목표: ${latestInstruction.trim()}`,
      `직전 builder step이 ${latestRun?.status === "cancelled" ? "취소" : "실패"}되었습니다.`,
      failureSummary ? `직전 실패 요약: ${failureSummary}` : "",
      failureRisks.length ? formatPromptList("Failure risks", failureRisks) : "",
      "답변 첫 문장을 위 목표 문구의 반복으로 시작하지 말고, 실패 진단과 다음 판단으로 바로 들어가세요.",
      "실패를 보더라도 개별 로그 한 줄이나 단일 코드 조각에 매달리기보다, 현재 branch 흐름과 recovery gate를 먼저 판단하세요.",
      "지금은 사용자에게 멈춰서 물어볼 단계가 아니라, 이 실패를 해결 대상으로 보고 원인을 진단한 뒤 다음 bounded recovery step을 하나 정해 진행해야 합니다.",
      "추가 리서치가 필요하면 먼저 하고, 그 다음 가장 가능성 높은 복구 step을 제안하세요.",
      "다만 다음 단계가 사용자 선택에 크게 의존하거나 여러 방향 중 하나를 골라야 한다면, 짧은 질문 하나를 하고 needs_user_checkpoint=true로 표시하세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    `Current user goal: ${latestInstruction.trim()}`,
    `The latest builder step ${latestRun?.status === "cancelled" ? "was cancelled" : "failed"}.`,
    failureSummary ? `Latest failure summary: ${failureSummary}` : "",
    failureRisks.length ? formatPromptList("Failure risks", failureRisks) : "",
    "Do not begin by repeating that goal wording verbatim; move straight into the failure diagnosis and next judgment.",
    "Even on failure, lead with the branch-level recovery gate and broader flow rather than over-indexing on one log fragment or one code edit.",
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

export function shouldRefreshAutomationStrategist(input: {
  redirectInstruction?: string;
  latestRun?: RunRecord | null;
  latestCheckpoint?: AutomationCheckpointRecord | null;
  latestDecision?: DecisionRecord | null;
}) {
  return Boolean(
    describeAutomationStrategistRefreshNeed({
      redirectInstruction: input.redirectInstruction ?? "",
      latestRun: input.latestRun,
      latestCheckpoint: input.latestCheckpoint,
      latestDecision: input.latestDecision
    })
  );
}

function describeAutomationStrategistRefreshNeed(input: {
  redirectInstruction: string;
  latestRun?: RunRecord | null;
  latestCheckpoint?: AutomationCheckpointRecord | null;
  latestDecision?: DecisionRecord | null;
}) {
  if (shouldReplanFromRedirectInstruction(input.redirectInstruction)) {
    return "the active user instruction changed and needs a fresh strategic read";
  }

  if (!input.latestDecision) {
    return "there is no prior strategist judgment yet";
  }

  if (shouldReplanAfterFailedRun(input.latestRun, input.latestCheckpoint, input.latestDecision)) {
    return "the latest builder outcome crossed a failure boundary that needs fresh research";
  }

  const latestRunTimestamp = resolveRunComparableTimestamp(input.latestRun);
  const latestDecisionTimestamp = input.latestDecision.createdAt || "";

  if (latestRunTimestamp && latestDecisionTimestamp && latestRunTimestamp > latestDecisionTimestamp) {
    return "the latest execution result is newer than the latest strategic judgment";
  }

  return "";
}

function resolveRunComparableTimestamp(run?: RunRecord | null) {
  return run?.endedAt || run?.startedAt || run?.createdAt || "";
}

export function buildRequiredAutomationStrategistDelegation(input: {
  existingDelegations: Array<Extract<OrchestratorDelegationDirective, { lane: "builder" | "strategist" }>>;
  hasAutomationDelegation: boolean;
  hasRunningBackgroundStrategist: boolean;
  session: AutomationSessionRecord;
  redirectInstruction: string;
  languagePreference: AppSettings["autopilotPromptLanguage"];
  snapshot: ProjectSnapshot;
}) {
  if (input.hasAutomationDelegation || input.hasRunningBackgroundStrategist) {
    return null;
  }

  if (input.existingDelegations.some((delegation) => delegation.lane === "strategist")) {
    return null;
  }

  if (
    !shouldRefreshAutomationStrategist({
      redirectInstruction: input.redirectInstruction,
      latestRun: input.snapshot.latestRun,
      latestCheckpoint: input.snapshot.latestAutomationCheckpoint,
      latestDecision: input.snapshot.latestDecision
    })
  ) {
    return null;
  }

  return {
    lane: "strategist" as const,
    prompt: buildAutomationStrategistPrompt(
      input.session,
      input.redirectInstruction,
      input.languagePreference,
      input.snapshot.latestRun,
      input.snapshot.latestAutomationCheckpoint,
      input.snapshot.latestDecision
    ),
    workerMode: "async" as const,
    model: "gpt-5.4-pro" as const,
    reasoningIntensity: "extended" as const,
    attachExplicitWorkspaceFiles: false
  };
}

export function buildFallbackAutomationStrategistDelegation(input: {
  automationDelegation?: Extract<OrchestratorDelegationDirective, { lane: "automation" }> | null;
  existingDelegations: Array<Extract<OrchestratorDelegationDirective, { lane: "builder" | "strategist" }>>;
  hasRunningBackgroundStrategist: boolean;
  session: AutomationSessionRecord;
  redirectInstruction: string;
  languagePreference: AppSettings["autopilotPromptLanguage"];
  snapshot: ProjectSnapshot;
}) {
  if (!input.automationDelegation || input.hasRunningBackgroundStrategist) {
    return null;
  }

  if (input.automationDelegation.mode === "checkpoint") {
    return null;
  }

  if (input.existingDelegations.length > 0) {
    return null;
  }

  return {
    lane: "strategist" as const,
    prompt: buildAutomationStrategistPrompt(
      input.session,
      input.redirectInstruction,
      input.languagePreference,
      input.snapshot.latestRun,
      input.snapshot.latestAutomationCheckpoint,
      input.snapshot.latestDecision
    ),
    workerMode: "async" as const,
    model: "gpt-5.4-pro" as const,
    reasoningIntensity: "extended" as const,
    attachExplicitWorkspaceFiles: false
  };
}

function resolveAutomationActiveInstruction(
  session: AutomationSessionRecord,
  redirectInstruction = ""
) {
  return (
    redirectInstruction.trim() ||
    session.queuedUserInstruction?.trim() ||
    session.lastUserInstruction?.trim() ||
    session.displayObjective?.trim() ||
    session.objective.trim()
  );
}

export function buildAutomationDelegationSessionPatch(input: {
  automationDelegation?: Extract<OrchestratorDelegationDirective, { lane: "automation" }> | null;
  session: AutomationSessionRecord;
  redirectInstruction: string;
}) {
  const automationDelegation = input.automationDelegation;

  if (!automationDelegation) {
    return {} satisfies Partial<AutomationSessionRecord>;
  }

  const nextBudget = {
    ...input.session.budget,
    maxSteps: automationDelegation.maxSteps ?? input.session.budget.maxSteps,
    maxRuntimeMinutes:
      automationDelegation.maxRuntimeMinutes ?? input.session.budget.maxRuntimeMinutes,
    maxRetries: automationDelegation.maxRetries ?? input.session.budget.maxRetries
  };
  const resolvedMode = automationDelegation.mode
    ? resolveAutomationConversationMode(
        automationDelegation.mode,
        input.redirectInstruction ||
          input.session.queuedUserInstruction?.trim() ||
          input.session.lastUserInstruction?.trim() ||
          input.session.displayObjective?.trim() ||
          input.session.objective
      )
    : input.session.mode;
  const budgetChanged =
    nextBudget.maxSteps !== input.session.budget.maxSteps ||
    nextBudget.maxRuntimeMinutes !== input.session.budget.maxRuntimeMinutes ||
    nextBudget.maxRetries !== input.session.budget.maxRetries;

  const patch: Partial<AutomationSessionRecord> = {};

  if (resolvedMode !== input.session.mode) {
    patch.mode = resolvedMode;
  }

  if (budgetChanged) {
    patch.budget = nextBudget;
  }

  return patch;
}

function shouldPauseForAutomationDelegation(input: {
  automationDelegation?: Extract<OrchestratorDelegationDirective, { lane: "automation" }> | null;
  session: AutomationSessionRecord;
  redirectInstruction: string;
}) {
  if (!input.automationDelegation || input.automationDelegation.mode !== "checkpoint") {
    return false;
  }

  return (
    resolveAutomationConversationMode(
      input.automationDelegation.mode,
      input.redirectInstruction ||
        input.session.queuedUserInstruction?.trim() ||
        input.session.lastUserInstruction?.trim() ||
        input.session.displayObjective?.trim() ||
        input.session.objective
    ) === "checkpoint"
  );
}

function summarizeRecentAutomationUserMessages(
  snapshot: ProjectSnapshot,
  session: AutomationSessionRecord,
  maxItems = 4
) {
  const activeInstruction = resolveAutomationActiveInstruction(session);
  const visibleGoal = session.displayObjective?.trim() || session.objective.trim();
  const messages = (snapshot.conversationEntries ?? [])
    .filter((entry) => entry.threadId === session.threadId && entry.role === "user")
    .map((entry) => sanitizeConversationBody(entry.body).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const dedupedRecent = messages
    .reverse()
    .filter((message) => {
      const normalized = message.toLowerCase();

      if (!normalized || seen.has(normalized)) {
        return false;
      }

      seen.add(normalized);
      return true;
    })
    .filter((message) => message !== activeInstruction && message !== visibleGoal)
    .slice(0, maxItems)
    .reverse();

  return dedupedRecent;
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
  const visibleRunSummary = humanizeAutomationUiIssue(input.runSummary, input.language);

  if (input.language === "ko") {
    const base =
      input.runStatus === "cancelled"
        ? "직전 단계가 끝나기 전에 중단되었습니다."
        : "직전 단계가 깔끔하게 끝나지 않았습니다.";
    return [base, visibleRunSummary, "자동으로 다음 복구 경로를 정리하고 있습니다."]
      .filter(Boolean)
      .join(" ");
  }

  const base =
    input.runStatus === "cancelled"
      ? "The latest step was cancelled before it finished."
      : "The latest step did not finish cleanly.";
  return [base, visibleRunSummary, "Lithium is already planning the next recovery step."]
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

function shortenAutomationNarration(value: string, maxChars = 220) {
  const normalized = sanitizeAutomationConversationSummary(value);

  if (!normalized) {
    return "";
  }

  const sentenceMatch = normalized.match(/^(.+?[.?!](?:\s|$))/);
  const firstSentence = sentenceMatch?.[1]?.trim() || "";

  if (firstSentence && firstSentence.length <= maxChars) {
    return firstSentence;
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  const slice = normalized.slice(0, maxChars).trim();
  const boundary = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "), slice.lastIndexOf(" "));
  const compact = (boundary >= Math.floor(maxChars * 0.5) ? slice.slice(0, boundary) : slice).trim();
  return `${compact.replace(/[.?!]+$/g, "").trim()}.`;
}

function buildAutomationStrategistUserMessage(
  session: AutomationSessionRecord,
  decision: DecisionRecord | null,
  fallback: string
) {
  const language = resolveAutomationUiLanguage([
    session.displayObjective ?? "",
    session.objective,
    handoffMachineSummary(decision?.handoff) || decision?.summary || "",
    decision?.rationale || ""
  ]);
  const summary = shortenAutomationNarration(
    handoffMachineSummary(decision?.handoff) || decision?.summary || ""
  );
  const rationale = shortenAutomationNarration(decision?.rationale || "", 180);
  const nextAction = shortenAutomationNarration(
    summarizeAutomationNextAction([
      ...(decision?.handoff?.runActions ?? []),
      ...(decision?.handoff?.openQuestions ?? [])
    ]),
    200
  );

  if (language === "ko") {
    return [
      summary ? `전략 판단은 ${summary}` : fallback,
      rationale && rationale !== summary ? `지금은 ${rationale}` : "",
      nextAction ? `다음 bounded step은 ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  return [
    summary ? `The strategist judgment is ${summary}` : fallback,
    rationale && rationale !== summary ? `Right now, ${rationale}` : "",
    nextAction ? `The next bounded step is ${nextAction}` : ""
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function resolveAutomationAdvisorUserMessage(
  session: AutomationSessionRecord,
  decision: DecisionRecord | null,
  fallback: string
) {
  return (
    buildAutomationStrategistUserMessage(session, decision, fallback) ||
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

function describeAutomationControllerFailure(message: string) {
  const trimmed = message.trim() || "Automation failed.";

  if (isStrategistBlockedFailure(trimmed)) {
    return {
      title: "Automation blocked on the strategist run",
      summary: "The strategist browser step needs help before automation can continue.",
      currentStepSummary: "Blocked on the strategist run. Waiting for your direction.",
      nextActions: isStrategistLoginRequiredFailure(trimmed) || isStrategistSessionExpiredFailure(trimmed)
        ? [
            "Log in to ChatGPT in Chrome, confirm the required model is available, then retry the strategist step.",
            "If needed, relaunch the strategist browser visibly so the session can be reattached."
          ]
        : isStrategistBrowserBlockedFailure(trimmed)
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

function buildAutomationStrategistRetrySessionSlug(sessionSlug: string, attempt: number) {
  const words = (normalizeOracleSessionId(sessionSlug).match(/[a-z0-9]+/g) ?? [])
    .slice(0, 5)
    .map((word) => word.slice(0, 10));

  if (!words.length || attempt <= 1) {
    return normalizeOracleSessionId(sessionSlug);
  }

  const lastWordIndex = words.length - 1;
  const baseLastWord = words[lastWordIndex]?.replace(/r\d+$/i, "") || "retry";
  words[lastWordIndex] = `${baseLastWord}r${attempt}`.slice(0, 10);
  return words.join("-");
}

function readAutomationStepSideEffectValues(step: AutomationStepRecord, prefix: string) {
  return (step.startedSideEffects ?? [])
    .filter((entry) => entry.startsWith(`${prefix}:`))
    .map((entry) => entry.slice(prefix.length + 1).trim())
    .filter(Boolean);
}

function readAutomationStrategistAttempt(step: AutomationStepRecord, sessionSlug: string) {
  const storedAttempts = readAutomationStepSideEffectValues(step, "oracle-attempt")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (storedAttempts.length) {
    return Math.max(...storedAttempts);
  }

  const retrySuffix = sessionSlug.match(/-r(\d+)$/i);

  return retrySuffix ? Number(retrySuffix[1]) : 1;
}

function buildAutomationStrategistLaunchSideEffects(input: {
  sessionSlug: string;
  decisionArtifactsId: string;
  model: AppSettings["strategistModel"];
  reasoningIntensity: AppSettings["strategistReasoningIntensity"];
  files: string[];
  attempt: number;
}) {
  return [
    `oracle-session:${input.sessionSlug}`,
    `decision-artifacts:${input.decisionArtifactsId}`,
    `oracle-model:${input.model}`,
    `oracle-thinking:${input.reasoningIntensity}`,
    `oracle-attempt:${input.attempt}`,
    ...input.files.map((filePath) => `oracle-file:${filePath}`)
  ];
}

function isOracleModelValue(value: string | undefined): value is AppSettings["strategistModel"] {
  return value === "gpt-5.4-pro";
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
  const strategistAnswer =
    extractVisibleStrategistMessage(decision?.rawOutput ?? "") || handoffUserMessage(decision?.handoff);
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

export function buildStrategistConversationNarration(decision: DecisionRecord | null | undefined) {
  const summary = shortenAutomationNarration(
    handoffMachineSummary(decision?.handoff) || decision?.summary || ""
  );
  const rationale = shortenAutomationNarration(decision?.rationale || "", 180);
  const nextAction = shortenAutomationNarration(
    summarizeAutomationNextAction([
      ...(decision?.handoff?.runActions ?? []),
      ...(decision?.handoff?.openQuestions ?? [])
    ]),
    180
  );
  const language = resolveAutomationUiLanguage([summary, rationale, nextAction]);

  if (language === "ko") {
    return [
      summary ? `전체적으로는 ${summary}` : "",
      rationale && rationale !== summary ? `이렇게 보는 이유는 ${rationale}` : "",
      nextAction ? `다음 우선순위는 ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  return [
    summary ? `At the portfolio level, ${summary}` : "",
    rationale && rationale !== summary ? `The key reason is ${rationale}` : "",
    nextAction ? `The next priority is ${nextAction}` : ""
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function buildBuilderConversationNarration(run: RunRecord | null | undefined) {
  const summary = shortenAutomationNarration(
    handoffMachineSummary(run?.handoff) || extractRunSummary(run?.finalMessage || "")
  );
  const nextAction = shortenAutomationNarration(
    summarizeAutomationNextAction([...(run?.handoff?.runActions ?? []), ...(run?.handoff?.openQuestions ?? [])]),
    180
  );
  const language = resolveAutomationUiLanguage([summary, nextAction, handoffUserMessage(run?.handoff)]);

  if (language === "ko") {
    return [
      summary ? `실행 쪽에서는 ${summary}` : "",
      nextAction ? `바로 다음 실행 후보는 ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  return [
    summary ? `On execution, ${summary}` : "",
    nextAction ? `The next execution candidate is ${nextAction}` : ""
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function buildOrchestratorWorkerFollowupPrompt(input: {
  originalPrompt: string;
  lane: OrchestratorDelegationLane;
  workerPrompt: string;
  snapshot: ProjectSnapshot;
}) {
  const latestDecision = input.snapshot.latestDecision;
  const latestRun = input.snapshot.latestRun;
  const portfolioSummary = handoffMachineSummary(latestDecision?.handoff) || latestDecision?.summary?.trim() || "";
  const portfolioRationale = latestDecision?.rationale?.trim() || "";
  const workerSummary =
    input.lane === "strategist"
      ? latestDecision?.summary?.trim() || "none"
      : handoffMachineSummary(latestRun?.handoff) || extractRunSummary(latestRun?.finalMessage || "") || "none";
  const nextAction =
    input.lane === "strategist"
      ? summarizeAutomationNextAction([
          ...(latestDecision?.handoff?.runActions ?? []),
          ...(latestDecision?.handoff?.openQuestions ?? [])
        ])
      : summarizeAutomationNextAction([
          ...(latestRun?.handoff?.runActions ?? []),
          ...(latestRun?.handoff?.openQuestions ?? [])
        ]);

  return [
    "The current user request is already available in the thread context. Address it directly without restating it verbatim.",
    input.lane === "strategist" ? "You delegated the research branch." : "You delegated the execution branch.",
    `Delegated task: ${input.workerPrompt.trim()}`,
    input.lane === "builder" && portfolioSummary ? `Portfolio guidance: ${portfolioSummary}` : "",
    input.lane === "builder" && portfolioRationale ? `Portfolio rationale: ${portfolioRationale}` : "",
    `Branch summary: ${workerSummary}`,
    input.lane === "strategist" && portfolioRationale ? `Research rationale: ${portfolioRationale}` : "",
    nextAction ? `Next step candidate: ${nextAction}` : "",
    "Now write the user-facing reply for the thread.",
    "Keep it natural and concise in the user's language.",
    "Do not begin by repeating the user's latest message or steering verbatim.",
    "Lead from the portfolio-level state, not the branch's play-by-play.",
    "If portfolio guidance exists, use it as the framing and keep branch detail to one supporting point.",
    "Use the structured summaries as internal evidence, but speak in the orchestrator's voice.",
    "Do not narrate raw logs, file-by-file edits, or experiment-by-experiment detail unless the user explicitly asked.",
    "Only delegate again if the answer would be materially incomplete without another concrete step."
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildOrchestratorParallelFollowupPrompt(input: {
  originalPrompt: string;
  delegations: Array<Extract<OrchestratorDelegationDirective, { lane: "builder" | "strategist" }>>;
  snapshot: ProjectSnapshot;
}) {
  const strategistDelegations = input.delegations.filter(
    (delegation): delegation is Extract<OrchestratorDelegationDirective, { lane: "strategist" }> =>
      delegation.lane === "strategist"
  );
  const builderDelegations = input.delegations.filter(
    (delegation): delegation is Extract<OrchestratorDelegationDirective, { lane: "builder" }> =>
      delegation.lane === "builder"
  );
  const sections: string[] = [];

  if (strategistDelegations.length > 0) {
    const summary = input.snapshot.latestDecision?.summary?.trim() || "none";
    const rationale = input.snapshot.latestDecision?.rationale?.trim() || "";
    const nextAction = summarizeAutomationNextAction([
      ...(input.snapshot.latestDecision?.handoff?.runActions ?? []),
      ...(input.snapshot.latestDecision?.handoff?.openQuestions ?? [])
    ]);
    const delegatedTasks = strategistDelegations
      .map((delegation) => `- ${delegation.prompt.trim()}`)
      .join("\n");

    sections.push(
      [
        strategistDelegations.length > 1 ? "Research branches" : "Research branch",
        delegatedTasks ? `Delegated tasks:\n${delegatedTasks}` : "",
        `Summary: ${summary}`,
        rationale ? `Rationale: ${rationale}` : "",
        nextAction ? `Next step candidate: ${nextAction}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }

  const executionSummary =
    handoffMachineSummary(input.snapshot.latestRun?.handoff) ||
    extractRunSummary(input.snapshot.latestRun?.finalMessage || "") ||
    "none";
  const executionNextAction = summarizeAutomationNextAction([
    ...(input.snapshot.latestRun?.handoff?.runActions ?? []),
    ...(input.snapshot.latestRun?.handoff?.openQuestions ?? [])
  ]);
  const runStatus = input.snapshot.latestRun?.status || "unknown";

  for (const delegation of builderDelegations) {
    sections.push(
      [
        "Execution branch",
        `Delegated task: ${delegation.prompt.trim()}`,
        `Status: ${runStatus}`,
        `Summary: ${executionSummary}`,
        executionNextAction ? `Next step candidate: ${executionNextAction}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }

  return [
    "The current user request is already available in the thread context. Address it directly without restating it verbatim.",
    "You delegated to multiple workers in parallel.",
    ...sections,
    "Now write the single user-facing reply for the thread.",
    "Keep it natural and concise in the user's language.",
    "Do not begin by repeating the user's latest message or steering verbatim.",
    "Synthesize from above: start with the overall state or decision, then use execution as supporting evidence.",
    "Prefer the research branch as the framing when it exists, and keep branch detail compressed unless the user explicitly asked for detail.",
    "Use the structured summaries as evidence, but do not echo raw verbose logs, control headers, or experiment play-by-play.",
    "Only delegate again if the answer would be materially incomplete without another concrete step."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function sanitizeConversationBody(value: string) {
  const sanitized = stripConversationControlFooters(value)
    .replace(/\n\s*[*_`>~-]*입니다\.?[*_`>~-]*\s*(?=\n|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return dedupeNormalizedParagraphs(sanitized);
}

function summarizeWorkerSnapshotForConversation(
  lane: OrchestratorDelegationLane,
  snapshot: ProjectSnapshot
) {
  if (lane === "strategist") {
    return (
      buildStrategistConversationNarration(snapshot.latestDecision) ||
      "I reviewed the research context and captured the next recommendation."
    );
  }

  return (
    buildBuilderConversationNarration(snapshot.latestRun) ||
    "I finished the workspace step and recorded the latest result."
  );
}

export function summarizeWorkerSnapshotsForConversation(
  delegations: Array<Extract<OrchestratorDelegationDirective, { lane: "builder" | "strategist" }>>,
  snapshot: ProjectSnapshot
) {
  const parts = [...delegations]
    .sort((left, right) => compareConversationLanePriority(left.lane, right.lane))
    .map((delegation) => summarizeWorkerSnapshotForConversation(delegation.lane, snapshot))
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return "I finished the delegated work and captured the latest state.";
  }

  return Array.from(new Set(parts)).join("\n\n");
}

export function summarizeAutomationWorkerResultsForConversation(results: AutomationDelegatedWorkerResult[]) {
  const builderResult = results.find(
    (result): result is AutomationDelegatedBuilderResult => result.lane === "builder"
  );
  const strategistResults = results.filter(
    (result): result is AutomationDelegatedStrategistResult => result.lane === "strategist"
  );
  const language = resolveAutomationUiLanguage(
    results.flatMap((result) =>
      result.lane === "builder"
        ? [result.runSummary, ...result.runActions]
        : [result.decision?.summary ?? "", handoffMachineSummary(result.decision?.handoff) ?? ""]
    )
  );

  const parts: string[] = [];
  const completedStrategistSummaries = strategistResults
    .filter((result) => !result.pending)
    .map((result) =>
      sanitizeAutomationConversationSummary(
        handoffMachineSummary(result.decision?.handoff) || result.decision?.summary || ""
      )
    )
    .filter(Boolean);
  const hasPendingStrategist = strategistResults.some((result) => result.pending);

  if (hasPendingStrategist) {
    parts.push(
      language === "ko"
        ? strategistResults.length > 1
          ? "전체 방향 리서치 분기들이 백그라운드에서 계속 진행 중입니다."
          : "전체 방향 리서치는 백그라운드에서 계속 진행 중입니다."
        : strategistResults.length > 1
        ? "The high-level research branches are still running in the background."
        : "The high-level research branch is still running in the background."
    );
  }

  if (completedStrategistSummaries.length > 0) {
    const strategistSummary = completedStrategistSummaries.join(
      language === "ko" ? " / " : " / "
    );

    parts.push(
      language === "ko"
        ? `전체적으로는 ${strategistSummary}`
        : `At the portfolio level, ${strategistSummary}`
    );
  }

  if (builderResult) {
    const builderSummary = sanitizeAutomationConversationSummary(builderResult.runSummary);
    parts.push(
      builderSummary
        ? language === "ko"
          ? `실행 쪽에서는 ${builderSummary}`
          : `On execution, ${builderSummary}`
        : language === "ko"
          ? "실행 쪽에서는 최근 bounded step을 마쳤습니다."
          : "On execution, the latest bounded step finished."
    );
  }

  if (!parts.length) {
    return language === "ko"
      ? "최근 자동 연구 결과를 정리해 이어서 진행하겠습니다."
      : "I summarized the latest automation state and will keep it moving.";
  }

  return Array.from(new Set(parts.map((part) => part.trim()).filter(Boolean))).join("\n\n");
}

export function buildAutomationConversationReportFingerprint(results: AutomationDelegatedWorkerResult[]) {
  const builderResult = results.find(
    (result): result is AutomationDelegatedBuilderResult => result.lane === "builder"
  );
  const strategistResults = results.filter(
    (result): result is AutomationDelegatedStrategistResult => result.lane === "strategist"
  );
  const completedStrategistSummaries = strategistResults
    .filter((result) => !result.pending)
    .map((result) =>
      sanitizeAutomationConversationSummary(
        handoffMachineSummary(result.decision?.handoff) || result.decision?.summary || ""
      )
    )
    .filter(Boolean)
    .sort();
  const nextStepSummary = summarizeAutomationConversationNextStep(results);

  return createHash("sha1")
    .update(
      JSON.stringify({
        pendingStrategist: strategistResults.some((result) => result.pending),
        strategistSummaries: completedStrategistSummaries,
        builderSummary: sanitizeAutomationConversationSummary(builderResult?.runSummary ?? ""),
        nextStepSummary
      })
    )
    .digest("hex");
}

function summarizeAutomationConversationNextStep(results: AutomationDelegatedWorkerResult[]) {
  const nextActions = results.flatMap((result) => {
    if (result.lane === "builder") {
      return result.runActions ?? [];
    }

    return [
      ...(result.decision?.handoff?.runActions ?? []),
      ...(result.decision?.handoff?.openQuestions ?? [])
    ];
  });

  return sanitizeAutomationConversationSummary(summarizeAutomationNextAction(nextActions));
}

export function shouldPublishAutomationConversationReport(
  session: AutomationSessionRecord,
  fingerprint: string
) {
  return Boolean(fingerprint && session.lastConversationReportFingerprint !== fingerprint);
}

function findLatestAutomationConversationUpdate(
  entries: ConversationEntryRecord[],
  threadId: string
) {
  const latestAutomationEntry = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.threadId === threadId &&
        entry.role !== "user" &&
        (entry.source === "automation" || entry.source === "checkpoint" || entry.source === "system")
    );

  if (!latestAutomationEntry) {
    return "";
  }

  return shortenAutomationNarration(sanitizeConversationBody(latestAutomationEntry.body), 220);
}

function compareConversationLanePriority(
  left: Extract<OrchestratorDelegationLane, "builder" | "strategist">,
  right: Extract<OrchestratorDelegationLane, "builder" | "strategist">
) {
  return resolveConversationLanePriority(left) - resolveConversationLanePriority(right);
}

function resolveConversationLanePriority(lane: Extract<OrchestratorDelegationLane, "builder" | "strategist">) {
  return lane === "strategist" ? 0 : 1;
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

function resolveStrategistWorkerMode(workerMode?: AutomationWorkerMode) {
  return workerMode === "sync" ? "sync" : "async";
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

function extractVisibleStrategistReply(rawOutput: string, maxChars = 2400) {
  const stripped = extractVisibleStrategistMessage(rawOutput)
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
  const latestByLane = new Map<"automation" | "builder", OrchestratorDelegationDirective>();
  const strategists: Extract<OrchestratorDelegationDirective, { lane: "strategist" }>[] = [];
  const seenStrategistPrompts = new Set<string>();

  for (const delegation of delegations) {
    if (delegation.lane === "strategist") {
      const promptKey = delegation.prompt.trim().toLowerCase();

      if (!promptKey || seenStrategistPrompts.has(promptKey)) {
        continue;
      }

      seenStrategistPrompts.add(promptKey);
      strategists.push(delegation);
      continue;
    }

    latestByLane.set(delegation.lane, delegation);
  }

  return [
    latestByLane.get("automation") ?? null,
    latestByLane.get("builder") ?? null,
    ...strategists
  ].filter((delegation): delegation is OrchestratorDelegationDirective => Boolean(delegation));
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
    /^(summary|machine_summary|user_message|next[_ ]task|rationale|files|risks|run_actions|success_criteria|open_questions)\s*:/i.test(
      line
    )
  );
}

function isRedundantBuilderContext(summary: string, answer: string) {
  const normalizedSummary = summary.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedAnswer = answer.replace(/\s+/g, " ").trim().toLowerCase();
  return Boolean(normalizedSummary && normalizedAnswer && normalizedAnswer.includes(normalizedSummary));
}

function combineParallelChatProgressInspections(
  inspections: ChatProgressInspection[]
): ChatProgressInspection {
  const ordered = [...inspections].sort((left, right) => {
    const laneDelta = parallelProgressLanePriority(left.lane) - parallelProgressLanePriority(right.lane);
    if (laneDelta !== 0) {
      return laneDelta;
    }

    return right.updatedAt.localeCompare(left.updatedAt);
  });
  const lines = Array.from(
    new Set(
      ordered.flatMap((inspection) => [
        inspection.progressSummary.trim(),
        ...inspection.progressDetails.map((detail) => detail.trim())
      ])
    ).values()
  ).filter(Boolean);
  const progressSummary = lines[0] || "";
  const progressDetails = lines.slice(1, 5);

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

function parallelProgressLanePriority(lane: ChatProgressInspection["lane"]) {
  if (lane === "builder") {
    return 0;
  }

  if (lane === "strategist") {
    return 1;
  }

  return 2;
}

function toUserFacingChatProgressInspection(
  inspection: ChatProgressInspection
): ChatProgressInspection {
  const lines = mergeProgressDetails(
    [inspection.progressSummary],
    inspection.progressDetails
  )
    .map((line) => stripConversationControlFooters(line).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !/^(exact val_bpb:|eval progress:)\s*/i.test(line));
  const progressSummary = lines[0] || "";
  const progressDetails = lines.slice(1, 5);

  return {
    ...inspection,
    lane: "orchestrator",
    progressSummary,
    progressDetails,
    activeCommand: null
  };
}

function resolveConversationLanguageFromEntries(
  entries: ConversationEntryRecord[],
  threadId: string
): "ko" | "en" {
  const threadEntries = entries
    .filter((entry) => entry.threadId === threadId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latestUserBody = [...threadEntries]
    .reverse()
    .find((entry) => entry.role === "user")
    ?.body;

  return resolveConversationLanguageFromBodies(
    latestUserBody ? [latestUserBody] : threadEntries.map((entry) => entry.body)
  );
}

function resolveConversationLanguageFromBodies(values: string[]): "ko" | "en" {
  return values.some(containsHangul) ? "ko" : "en";
}

function truncateWorkerRawEvidence(value: string, maxChars: number) {
  const normalized = value.replace(/\n{3,}/g, "\n\n").trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatPromptList(label: string, values: string[]) {
  return `${label}:\n${values.map((value) => `- ${value}`).join("\n")}`;
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
            !/^(summary|rationale|files|risks|run_actions|success_criteria|open_questions)\s*:/i.test(
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
  const transcriptSignals = [
    /(?:^|\s)\{"type":"thread\.(?:started|completed)"/m.test(value),
    /(?:^|\s)\{"type":"turn\.(?:started|completed)"/m.test(value),
    /"type":"item\.(?:started|completed|updated)"/.test(value),
    /"type":"(?:agent_message|command_execution|web_search|todo_list)"/.test(value)
  ].filter(Boolean).length;

  if (transcriptSignals >= 3) {
    return true;
  }

  const progress = parseCodexProgressLog(value);
  const hasJsonProgressSignal = Boolean(
    progress.progressSummary || progress.progressDetails.length > 0 || progress.activeCommand
  );

  if (transcriptSignals >= 2 && hasJsonProgressSignal) {
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
      run_actions: [],
      success_criteria: [],
      open_questions: []
    })
  ].join("\n");
}

function setBoundedMapValue<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number) {
  if (map.has(key)) {
    map.delete(key);
  }

  map.set(key, value);

  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    map.delete(oldestKey);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function openZipFile(filePath: string) {
  return new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error(`Could not open archive: ${filePath}`));
        return;
      }

      resolve(zipFile);
    });
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
    automationSessions: [],
    automationSteps: [],
    automationCheckpoints: [],
    latestAutomationSession: null,
    latestAutomationCheckpoint: null,
    logs: []
  };
}
