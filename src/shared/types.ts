export type RecordStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type RunFinalizationMode = "auto" | "manual" | "terminated";

export type CommandSpec = {
  command: string;
  args: string[];
  cwd: string;
};

export type AutomationPromptLanguage = "auto" | "ko" | "en";
export type OracleModel = "gpt-5.4-pro";
export type OracleThinkingTime = "extended";
export type BuilderModel = "gpt-5.4" | "gpt-5.3-codex";
export type BuilderReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type AppSettings = {
  autopilotPromptLanguage: AutomationPromptLanguage;
  strategistSessionReady: boolean;
  lastWorkspacePath: string;
  strategistModel: OracleModel;
  strategistReasoningIntensity: OracleThinkingTime;
  builderModel: BuilderModel;
  builderReasoningEffort: BuilderReasoningEffort;
};

export type AppSettingsUpdate = Partial<AppSettings>;

export const DEFAULT_PROJECT_RESEARCH_GOAL = "Define the next research outcome this project should produce.";

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autopilotPromptLanguage: "auto",
  strategistSessionReady: false,
  lastWorkspacePath: "",
  strategistModel: "gpt-5.4-pro",
  strategistReasoningIntensity: "extended",
  builderModel: "gpt-5.4",
  builderReasoningEffort: "xhigh"
};

export type ProjectRecord = {
  id: string;
  name: string;
  workspacePath: string;
  oracleModel: OracleModel;
  codexModel: string;
  defaultThreadId: string;
  activeThreadId: string;
  createdAt: string;
  updatedAt: string;
};

export type ThreadRecord = {
  id: string;
  title: string;
  summary: string;
  memory?: string;
  conversationOrchestratorSessionId?: string;
  conversationOrchestratorUpdatedAt?: string;
  strategistContextFingerprint?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectMemoryPreferences = {
  strategistStyle: string;
  builderStyle: string;
};

export type ProjectNarrativeMemoryRecord = {
  northStar: string;
  activeStory: string;
  collaborationContract: string[];
  currentFocus: string;
  recentDirections: string[];
  constraints: string[];
};

export type ProjectModelMemoryRecord = {
  openQuestions: string[];
  activeHypotheses: string[];
  stableFacts: string[];
  keyDecisions: string[];
  metrics: string[];
  learnedPatterns: string[];
};

export type ProjectExecutionJournalMemoryRecord = {
  sessionSummary: string;
  activeAutomationSummary: string;
  recentArtifacts: string[];
  recentCommands: string[];
  recentLogs: string[];
  recoveryNotes: string[];
};

export type ProjectMemoryLayer = {
  summary: string;
  bullets: string[];
};

export type ProjectMemoryMap = {
  narrative: ProjectMemoryLayer;
  knowledge: ProjectMemoryLayer;
  execution: ProjectMemoryLayer;
};

export type ProjectMemoryRecord = {
  projectBrief: string;
  researchGoal: string;
  constraints: string[];
  preferences: ProjectMemoryPreferences;
  openQuestions: string[];
  activeHypotheses: string[];
  sessionSummary: string;
  layers: {
    narrative: ProjectNarrativeMemoryRecord;
    projectModel: ProjectModelMemoryRecord;
    executionJournal: ProjectExecutionJournalMemoryRecord;
  };
  memoryMap: ProjectMemoryMap;
  updatedAt: string;
};

export type ContextPackLane = "strategist" | "builder";

export type AutomationMode = "checkpoint" | "continuous";
export type AutomationStatus = "idle" | "running";
export type AutomationWorkerMode = "planner" | "sync" | "async" | "live";
export type AutomationStepKind =
  | "strategize"
  | "code-edit"
  | "experiment-run"
  | "result-analysis"
  | "literature-search"
  | "checkpoint";
export type AutomationStepLane = "controller" | "strategist" | "builder" | "researcher" | "writer" | "critic";
export type AutomationCycleStatus = "planned" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type AutomationCyclePhase = "planning" | "workers" | "reporting";
export type AutomationBudget = {
  maxSteps: number;
  maxRuntimeMinutes: number;
  maxRetries: number;
  usedSteps: number;
  usedRetries: number;
};
export type AutomationCycleLaneState = {
  lane: AutomationStepLane;
  title: string;
  status: "pending" | RecordStatus;
  workerMode: AutomationWorkerMode;
  summary: string;
  stepId?: string;
  idempotencyKey?: string;
  resumeCursor?: string;
  updatedAt: string;
};
export type AutomationProposedStep = {
  kind: AutomationStepKind;
  title: string;
  prompt: string;
  requiresReview?: boolean;
};
export type AutomationCycleRecord = {
  id: string;
  sessionId: string;
  threadId: string;
  title: string;
  objective: string;
  plannerPrompt: string;
  plannerReply?: string;
  plannerSessionId?: string;
  status: AutomationCycleStatus;
  phase: AutomationCyclePhase;
  summary: string;
  laneStates: AutomationCycleLaneState[];
  activeLaneStepIds?: string[];
  completedLaneStepIds?: string[];
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt?: string;
};
export type AutomationSessionRecord = {
  id: string;
  threadId: string;
  objective: string;
  displayObjective?: string;
  plannerSessionId?: string;
  plannerUpdatedAt?: string;
  mode: AutomationMode;
  status: AutomationStatus;
  allowedActions: AutomationStepKind[];
  evidenceMode: "strict" | "pragmatic";
  budget: AutomationBudget;
  latestCycleId?: string;
  activeCycleId?: string;
  activeLaneStepIds?: string[];
  latestStepId?: string;
  latestCheckpointId?: string;
  currentStepSummary: string;
  lastConversationReportFingerprint?: string;
  lastUserInstruction?: string;
  queuedUserInstruction?: string;
  stopReason?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
};
export type AutomationStepRecord = {
  id: string;
  sessionId: string;
  threadId: string;
  cycleId?: string;
  kind: AutomationStepKind;
  lane: AutomationStepLane;
  workerMode?: AutomationWorkerMode;
  title: string;
  prompt: string;
  status: RecordStatus;
  summary: string;
  idempotencyKey?: string;
  startedSideEffects?: string[];
  completedSideEffects?: string[];
  resumeCursor?: string;
  decisionId?: string;
  runId?: string;
  changedFiles: string[];
  evidence: string[];
  checkpointRequired: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};
export type AutomationCheckpointStatus = "pending" | "approved" | "dismissed";
export type AutomationCheckpointRecord = {
  id: string;
  sessionId: string;
  threadId: string;
  status: AutomationCheckpointStatus;
  title: string;
  summary: string;
  whatChanged: string[];
  evidence: string[];
  risks: string[];
  nextActions: string[];
  userResponse?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
};

export type LithiumHandoff = {
  schemaVersion: "lithium_handoff_v1";
  role: ContextPackLane;
  summary: string;
  machineSummary?: string;
  userMessage?: string;
  rationale?: string;
  result?: "success" | "partial" | "failed";
  files: string[];
  risks: string[];
  runActions: string[];
  successCriteria: string[];
  openQuestions: string[];
  automationMode?: "continue" | "checkpoint" | "blocked" | "done";
  proposedSteps?: AutomationProposedStep[];
  needsUserCheckpoint?: boolean;
  confidence?: number;
};

export type DecisionRecord = {
  id: string;
  threadId: string;
  prompt: string;
  displayPrompt?: string;
  inputFiles?: string[];
  rawOutput: string;
  summary: string;
  rationale: string;
  handoff?: LithiumHandoff;
  model: string;
  engine: "browser";
  status: RecordStatus;
  command: CommandSpec;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  contextPackPath?: string;
  createdAt: string;
};

export type TaskRecord = {
  id: string;
  threadId: string;
  sourceDecisionId?: string;
  title: string;
  prompt: string;
  status: RecordStatus;
  createdAt: string;
  updatedAt: string;
};

export type RunRecord = {
  id: string;
  threadId: string;
  taskId: string;
  prompt: string;
  displayPrompt?: string;
  model: string;
  status: RecordStatus;
  exitCode: number | null;
  pid: number | null;
  command: CommandSpec;
  stdoutPath: string;
  stderrPath: string;
  finalMessagePath: string;
  finalMessage: string;
  handoff?: LithiumHandoff | null;
  changedFiles: string[];
  contextPackPath?: string;
  finalization: RunFinalizationMode | null;
  createdAt: string;
  startedAt: string;
  endedAt?: string;
};

export type BuilderRunControlRequest = {
  workspacePath?: string;
  runId?: string;
};

export type ChatProgressRequest = {
  workspacePath?: string;
  threadId?: string;
};

export type BuilderRunInspection = {
  run: RunRecord | null;
  active: boolean;
  pid: number | null;
  stdoutTail: string;
  stderrTail: string;
  outputText: string;
  changedFiles: string[];
  progressSummary: string;
  progressDetails: string[];
  activeCommand: string | null;
  suggestedStatus: "idle" | "running" | "awaiting-finalization" | "hung";
  quietForMs: number;
};

export type ChatProgressInspection = {
  active: boolean;
  lane: "orchestrator" | "router" | "strategist" | "builder";
  threadId?: string;
  progressSummary: string;
  progressDetails: string[];
  activeCommand: string | null;
  stdoutTail: string;
  stderrTail: string;
  updatedAt: string;
};

export type AttachmentKind = "text" | "json" | "csv" | "document" | "image" | "other";

export type AttachmentRecord = {
  id: string;
  threadId: string;
  name: string;
  relativePath: string;
  sourcePath: string;
  kind: AttachmentKind;
  sizeBytes: number;
  excerpt: string;
  importedAt: string;
  updatedAt: string;
  consumedAt?: string;
  conversationEntryId?: string;
  decisionId?: string;
  runId?: string;
};

export type ConversationEntryRole = "user" | "assistant" | "system";
export type ConversationEntrySource =
  | "user"
  | "orchestrator"
  | "automation"
  | "checkpoint"
  | "system";

export type ConversationEntryRecord = {
  id: string;
  threadId: string;
  role: ConversationEntryRole;
  source: ConversationEntrySource;
  body: string;
  createdAt: string;
  attachmentIds?: string[];
  decisionId?: string;
  runId?: string;
  automationSessionId?: string;
  automationCycleId?: string;
  automationStepId?: string;
  automationCheckpointId?: string;
};

export type ProjectSnapshot = {
  project: ProjectRecord | null;
  memory: ProjectMemoryRecord | null;
  threads: ThreadRecord[];
  activeThreadId: string | null;
  activeThread: ThreadRecord | null;
  conversationEntries?: ConversationEntryRecord[];
  latestConversationEntry?: ConversationEntryRecord | null;
  attachments: AttachmentRecord[];
  activeThreadAttachments: AttachmentRecord[];
  decisions: DecisionRecord[];
  tasks: TaskRecord[];
  runs: RunRecord[];
  routerTraces?: RouterTraceRecord[];
  latestDecision: DecisionRecord | null;
  latestTask: TaskRecord | null;
  latestRun: RunRecord | null;
  latestRouterTrace?: RouterTraceRecord | null;
  automationSessions?: AutomationSessionRecord[];
  automationCycles?: AutomationCycleRecord[];
  automationSteps?: AutomationStepRecord[];
  automationCheckpoints?: AutomationCheckpointRecord[];
  latestAutomationSession?: AutomationSessionRecord | null;
  latestAutomationCycle?: AutomationCycleRecord | null;
  latestAutomationCheckpoint?: AutomationCheckpointRecord | null;
  logs: string[];
};

export type ArtifactKind =
  | "code"
  | "text"
  | "json"
  | "csv"
  | "image"
  | "document"
  | "log"
  | "other";

export type WorkspaceFileKind = "code" | "artifact";

export type WorkspaceFileRecord = {
  path: string;
  relativePath: string;
  name: string;
  kind: WorkspaceFileKind;
  artifactKind?: ArtifactKind;
};

export type StrategistRequest = {
  workspacePath?: string;
  threadId?: string;
  prompt: string;
  displayPrompt?: string;
  attachExplicitWorkspaceFiles?: boolean;
  sessionSlug?: string;
  model?: OracleModel;
  reasoningIntensity?: OracleThinkingTime;
};

export type BuilderRequest = {
  workspacePath?: string;
  threadId?: string;
  prompt: string;
  displayPrompt?: string;
  model?: BuilderModel;
  reasoningEffort?: BuilderReasoningEffort;
};

export type ChatRequest = {
  workspacePath?: string;
  threadId?: string;
  prompt: string;
};

export type ChatRoute = "strategist" | "builder" | "mixed";

export type ChatRouteDecision = {
  route: ChatRoute;
  rewrittenPrompt: string;
  reasonShort: string;
};

export type RouterTraceRecord = {
  id: string;
  threadId: string;
  prompt: string;
  normalizedPrompt: string;
  rewrittenPrompt: string;
  requestedRoute: ChatRoute | null;
  route: ChatRoute;
  finalRoute: ChatRoute;
  reasonShort: string;
  rawOutput: string;
  command: CommandSpec;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  downstreamDecisionId?: string;
  downstreamRunId?: string;
  downstreamTaskId?: string;
  downstreamError?: string;
  createdAt: string;
  decidedAt: string;
  completedAt: string;
};

export type AttachmentImportRequest = {
  workspacePath?: string;
  threadId?: string;
  filePaths: string[];
};

export type AttachmentDeleteRequest = {
  workspacePath?: string;
  attachmentId: string;
};

export type ThreadSelectionRequest = {
  workspacePath?: string;
  threadId: string;
};

export type ThreadCreateRequest = {
  workspacePath?: string;
  title?: string;
};

export type AutomationSessionCreateRequest = {
  workspacePath?: string;
  threadId?: string;
  objective: string;
  displayObjective?: string;
  mode?: AutomationMode;
  maxSteps?: number;
  maxRuntimeMinutes?: number;
  maxRetries?: number;
};

export type AutomationSessionControlRequest = {
  workspacePath?: string;
  sessionId: string;
};

export type AutomationInterruptRequest = AutomationSessionControlRequest & {
  instruction: string;
  stopNow?: boolean;
};
