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
export const PROJECT_SCHEMA_VERSION = 2;

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
  schemaVersion: number;
  name: string;
  workspacePath: string;
  oracleModel: OracleModel;
  codexModel: string;
  activeObjectiveId?: string;
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

export type ResearchObjectiveStatus = "pending" | "active" | "paused" | "completed" | "failed";
export type ResearchBranchStatus = "candidate" | "active" | "blocked" | "killed" | "pivoted" | "completed";
export type ResearchSourceKind = "workspace" | "paper" | "repo" | "web" | "decision" | "run" | "conversation";
export type ResearchFindingKind = "evidence" | "observation" | "claim";
export type ResearchHypothesisStatus = "open" | "supported" | "unsupported" | "revised";
export type ResearchWorkItemKind = "planner" | "deep-research" | "code-edit" | "experiment" | "evaluation";
export type ResearchWorkItemLane = "planner" | "research" | "builder" | "experiment" | "evaluator";
export type ResearchWorkItemExecutionMode = "sync" | "async" | "isolated";
export type ResearchWorkItemExecutor =
  | "oracle-planner"
  | "oracle-research"
  | "builder-edit"
  | "experiment-run"
  | "evaluator";
export type ResearchIsolationMode = "none" | "worktree";
export type ResearchWorkItemStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export type ResearchEvaluationVerdict = "continue" | "kill" | "pivot" | "complete";
export type ResearchProjectionStatus = "idle" | "running" | "paused" | "blocked" | "completed";
export type ResearchRunStatus = "pending" | "active" | "blocked" | "paused" | "completed" | "failed";

export type ResearchPriorityScore = {
  objectiveAlignment: number;
  expectedInformationGain: number;
  feasibility: number;
  estimatedCost: number;
  branchFreshness: number;
  duplicationPenalty: number;
  reproducibilityPriority: number;
  total: number;
};

export type ResearchObjectiveRecord = {
  id: string;
  threadId: string;
  automationSessionId?: string;
  title: string;
  objective: string;
  summary: string;
  status: ResearchObjectiveStatus;
  successCriteria: string[];
  activeBranchId?: string;
  activeRunId?: string;
  sourceIds: string[];
  branchIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type ResearchBranchRecord = {
  id: string;
  objectiveId: string;
  threadId: string;
  title: string;
  hypothesis: string;
  status: ResearchBranchStatus;
  score: number;
  blocker?: string;
  nextWorkItemId?: string;
  lastFailureReason?: string;
  evidenceIds: string[];
  sourceIds: string[];
  findingIds: string[];
  workItemIds: string[];
  createdAt: string;
  updatedAt: string;
  lastUpdatedAt: string;
};

export type ResearchSourceRecord = {
  id: string;
  objectiveId: string;
  threadId: string;
  branchId?: string;
  kind: ResearchSourceKind;
  title: string;
  locator: string;
  summary: string;
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
};

export type ResearchFindingRecord = {
  id: string;
  objectiveId: string;
  threadId: string;
  branchId?: string;
  sourceId?: string;
  kind: ResearchFindingKind;
  summary: string;
  detail?: string;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
};

export type ResearchHypothesisRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  threadId: string;
  statement: string;
  status: ResearchHypothesisStatus;
  confidence: number;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type ResearchWorkItemRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  threadId: string;
  kind: ResearchWorkItemKind;
  lane: ResearchWorkItemLane;
  executor?: ResearchWorkItemExecutor;
  title: string;
  prompt: string;
  status: ResearchWorkItemStatus;
  executionMode: ResearchWorkItemExecutionMode;
  isolation?: ResearchIsolationMode;
  priorityScore: ResearchPriorityScore;
  sourceIds: string[];
  dependsOnIds: string[];
  decisionId?: string;
  runId?: string;
  oracleSessionSlug?: string;
  worktreePath?: string;
  resultEvaluationId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type ResearchRunSlotBudget = {
  codexSlots: number;
  oracleSlots: number;
  maxTotalWorkItems: number;
  completedWorkItems: number;
};

export type ResearchRunRecord = {
  id: string;
  objectiveId: string;
  threadId: string;
  status: ResearchRunStatus;
  blockedReason?: string;
  stopReason?: string;
  slotBudget: ResearchRunSlotBudget;
  activeWorkItemIds: string[];
  oracleSessionSlugs: string[];
  worktreeLeases: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
};

export type EvaluationRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  threadId: string;
  workItemId: string;
  verdict: ResearchEvaluationVerdict;
  scoreDelta: number;
  summary: string;
  rationale: string;
  followupPrompt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ResearchEventRecord = {
  id: string;
  threadId: string;
  objectiveId?: string;
  branchId?: string;
  workItemId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ResearchProjectionRecord = {
  id: string;
  threadId: string;
  objectiveId: string;
  objectiveTitle: string;
  status: ResearchProjectionStatus;
  summary: string;
  currentFocus: string;
  activeBranchTitle: string;
  queueDepth: number;
  topNextActions: string[];
  recentEvidence: string[];
  latestEvaluationSummary?: string;
  activeRunId?: string;
  activeRunStatus?: ResearchRunStatus;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
  lastUpdatedAt: string;
};

export type ActiveWorkerProgressRecord = {
  runId: string;
  workItemId: string;
  objectiveId: string;
  title: string;
  executor: ResearchWorkItemExecutor;
  status: ResearchWorkItemStatus | ResearchRunStatus;
  summary: string;
  oracleSessionSlug?: string;
  worktreePath?: string;
  updatedAt: string;
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
  proposedBranches?: Array<{
    title: string;
    hypothesis: string;
  }>;
  researchWorkItems?: Array<{
    title: string;
    prompt: string;
    kind: ResearchWorkItemKind;
    executor?: ResearchWorkItemExecutor;
    isolation?: ResearchIsolationMode;
    branchTitle?: string;
  }>;
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
  objectiveId?: string;
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
  researchObjectives?: ResearchObjectiveRecord[];
  researchBranches?: ResearchBranchRecord[];
  researchSources?: ResearchSourceRecord[];
  researchFindings?: ResearchFindingRecord[];
  researchHypotheses?: ResearchHypothesisRecord[];
  researchWorkItems?: ResearchWorkItemRecord[];
  researchEvaluations?: EvaluationRecord[];
  latestResearchObjective?: ResearchObjectiveRecord | null;
  latestResearchBranch?: ResearchBranchRecord | null;
  latestResearchWorkItem?: ResearchWorkItemRecord | null;
  latestResearchEvaluation?: EvaluationRecord | null;
  latestResearchProjection?: ResearchProjectionRecord | null;
  logs: string[];
};

export type WorkspaceSnapshot = {
  project: ProjectRecord | null;
  activeObjectiveId: string | null;
  activeObjective: ResearchObjectiveRecord | null;
  objectives: ResearchObjectiveRecord[];
  activeRun: ResearchRunRecord | null;
  runs: ResearchRunRecord[];
  branches: ResearchBranchRecord[];
  queue: ResearchWorkItemRecord[];
  recentFindings: ResearchFindingRecord[];
  latestEvaluation: EvaluationRecord | null;
  latestProjection: ResearchProjectionRecord | null;
  latestBuilderRun: RunRecord | null;
  attachments: AttachmentRecord[];
  activeWorkerProgress: ActiveWorkerProgressRecord[];
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
  executionWorkspacePath?: string;
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
  objectiveId?: string;
  filePaths: string[];
};

export type ObjectiveCreateRequest = {
  workspacePath?: string;
  title?: string;
  objective: string;
  successCriteria?: string[];
};

export type ObjectiveSelectionRequest = {
  workspacePath?: string;
  objectiveId: string;
};

export type ObjectiveRunControlRequest = {
  workspacePath?: string;
  runId?: string;
  objectiveId?: string;
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
