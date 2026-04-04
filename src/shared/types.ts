export type RecordStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type RunFinalizationMode = "auto" | "manual" | "terminated";

export type CommandSpec = {
  command: string;
  args: string[];
  cwd: string;
};

export type PromptLanguage = "auto" | "ko" | "en";
export type OracleModel = "gpt-5.4-pro";
export type OracleThinkingTime = "extended";
export type BuilderModel = "gpt-5.4" | "gpt-5.3-codex";
export type BuilderReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type AppSettings = {
  promptLanguage: PromptLanguage;
  oracleSessionReady: boolean;
  lastWorkspacePath: string;
  oracleModel: OracleModel;
  oracleThinkingTime: OracleThinkingTime;
  builderModel: BuilderModel;
  builderReasoningEffort: BuilderReasoningEffort;
};

export type AppSettingsUpdate = Partial<AppSettings>;

export const DEFAULT_PROJECT_RESEARCH_GOAL = "Define the next research outcome this project should produce.";
export const PROJECT_SCHEMA_VERSION = 3;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  promptLanguage: "auto",
  oracleSessionReady: false,
  lastWorkspacePath: "",
  oracleModel: "gpt-5.4-pro",
  oracleThinkingTime: "extended",
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
  createdAt: string;
  updatedAt: string;
};

export type ResearchObjectiveStatus = "pending" | "active" | "paused" | "completed" | "failed";
export type ResearchBranchStatus = "candidate" | "active" | "blocked" | "killed" | "pivoted" | "completed";
export type ResearchSourceKind = "workspace" | "paper" | "repo" | "web" | "attachment";
export type ResearchFindingKind = "evidence" | "observation" | "claim";
export type ResearchHypothesisStatus = "open" | "supported" | "unsupported" | "revised";
export type ResearchWorkItemKind =
  | "plan"
  | "discover"
  | "read_synthesize"
  | "build_change"
  | "run_experiment"
  | "evaluate_branch"
  | "arbitrate_branch";
export type ResearchWorkItemLane =
  | "plan"
  | "discover"
  | "synthesis"
  | "build"
  | "experiment"
  | "evaluate"
  | "arbiter";
export type ResearchWorkItemExecutionMode = "sync" | "async" | "isolated";
export type ResearchWorkItemExecutor =
  | "planner"
  | "discoverer"
  | "reader-synthesizer"
  | "builder"
  | "experimenter"
  | "evaluator"
  | "arbiter";
export type ResearchIsolationMode = "none" | "worktree";
export type ResearchWorkItemStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export type ResearchEvaluationVerdict = "continue" | "kill" | "pivot" | "complete";
export type ResearchProjectionStatus = "idle" | "running" | "paused" | "blocked" | "completed";
export type ResearchRunStatus = "pending" | "active" | "blocked" | "paused" | "completed" | "failed";
export type ResearchPatchPromotionStatus = "pending" | "promoted" | "skipped" | "failed";
export type ResearchWorktreeLeaseCleanupStatus = "active" | "released" | "failed";

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
  title: string;
  hypothesis: string;
  status: ResearchBranchStatus;
  score: number;
  baseCommit?: string;
  gitRef?: string;
  headCommit?: string;
  worktreePath?: string;
  promotionHeadCommit?: string;
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
  branchId?: string;
  kind: ResearchSourceKind;
  title: string;
  locator: string;
  provenance: string;
  summary: string;
  excerpt?: string;
  attachmentId?: string;
  artifactPath?: string;
  artifactHash?: string;
  citationStart?: number;
  citationEnd?: number;
  readAt?: string;
  oracleSessionSlug?: string;
  sourceArtifactId?: string;
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
};

export type SourceArtifactRecord = {
  id: string;
  objectiveId: string;
  sourceId: string;
  path: string;
  hash: string;
  contentType?: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type ResearchFindingRecord = {
  id: string;
  objectiveId: string;
  branchId?: string;
  sourceId?: string;
  sourceArtifactId?: string;
  kind: ResearchFindingKind;
  summary: string;
  detail?: string;
  citationStart?: number;
  citationEnd?: number;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
};

export type ResearchTaskDependency = {
  taskId: string;
  reason: string;
};

export type ResearchTaskTimeoutPolicy = {
  wallMs: number;
  silenceMs?: number;
};

export type DiscoverSourceSpec = {
  locator: string;
  title: string;
  kind: Extract<ResearchSourceKind, "paper" | "repo" | "web">;
  summary: string;
  excerpt?: string;
  citationText?: string;
  branchTitle?: string;
};

export type DiscoverTaskPayload = {
  branchId: string;
  goal: string;
  maxResults: number;
  domains?: string[];
};

export type ReadSynthesizeTaskPayload = {
  branchId: string;
  sourceIds: string[];
  questions: string[];
};

export type BuildChangeTaskPayload = {
  branchId: string;
  goal: string;
  constraints: string[];
  verificationCommands: string[];
  successCriteria: string[];
};

export type ExperimentMetricExpectation = {
  name: string;
  value?: number;
  min?: number;
  max?: number;
  baselineDelta?: number;
};

export type RunExperimentTaskPayload = {
  branchId: string;
  commands: string[];
  timeoutMs: number;
  expectedMetrics: ExperimentMetricExpectation[];
};

export type EvaluateBranchTaskPayload = {
  branchId: string;
  compareToBranchId?: string;
  focus: string;
};

export type ArbitrateBranchTaskPayload = {
  branchId: string;
  evaluationId: string;
  candidateTaskId?: string;
};

export type PlannerTaskPayload = {
  objectiveId: string;
  activeBranchId: string;
  goal: string;
};

export type ResearchTaskPayload =
  | PlannerTaskPayload
  | DiscoverTaskPayload
  | ReadSynthesizeTaskPayload
  | BuildChangeTaskPayload
  | RunExperimentTaskPayload
  | EvaluateBranchTaskPayload
  | ArbitrateBranchTaskPayload;

export type ResearchHypothesisRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  statement: string;
  status: ResearchHypothesisStatus;
  confidence: number;
  evidenceIds: string[];
  lastEvaluationId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ResearchWorktreeLeaseRecord = {
  id: string;
  workItemId: string;
  worktreePath: string;
  cleanupStatus: ResearchWorktreeLeaseCleanupStatus;
  createdAt: string;
  updatedAt: string;
  releasedAt?: string;
  cleanupError?: string;
};

export type ResearchWorkItemRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
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
  dependencyRefs?: ResearchTaskDependency[];
  payload?: ResearchTaskPayload;
  timeoutPolicy?: ResearchTaskTimeoutPolicy;
  maxAttempts?: number;
  attemptCount?: number;
  runId?: string;
  oracleSessionSlug?: string;
  worktreePath?: string;
  resultEvaluationId?: string;
  leaseId?: string;
  patchArtifactPath?: string;
  promotionStatus?: ResearchPatchPromotionStatus;
  promotionError?: string;
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
  status: ResearchRunStatus;
  blockedReason?: string;
  stopReason?: string;
  slotBudget: ResearchRunSlotBudget;
  activeWorkItemIds: string[];
  oracleSessionSlugs: string[];
  worktreeLeases: ResearchWorktreeLeaseRecord[];
  dispatchPaused?: boolean;
  lastPlanTaskId?: string;
  lastPlanAt?: string;
  lastPlanSourceCount?: number;
  lastPlanCompletedCount?: number;
  lastPlanBranchScore?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
};

export type EvaluationRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  workItemId: string;
  verdict: ResearchEvaluationVerdict;
  scoreDelta: number;
  summary: string;
  rationale: string;
  followupPrompt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ExperimentSpecRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  workItemId: string;
  title: string;
  prompt: string;
  executor: Extract<ResearchWorkItemExecutor, "experimenter">;
  isolation: ResearchIsolationMode;
  worktreePath?: string;
  createdAt: string;
  updatedAt: string;
};

export type ExperimentManifest = {
  commands: string[];
  exitCode: number | null;
  status: "completed" | "failed" | "cancelled";
  stdoutPath?: string;
  stderrPath?: string;
  outputPath?: string;
  artifacts: string[];
  metrics: Array<{
    name: string;
    value: number;
    unit?: string;
  }>;
  baselineCompare?: Record<string, number>;
  expectations?: ExperimentMetricExpectation[];
};

export type ExperimentResultRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  workItemId: string;
  experimentSpecId: string;
  runId?: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  command?: string;
  stdoutPath?: string;
  stderrPath?: string;
  outputPath?: string;
  worktreePath?: string;
  changedFiles: string[];
  patchArtifactPath?: string;
  manifestPath?: string;
  manifest?: ExperimentManifest;
  createdAt: string;
  updatedAt: string;
};

export type MetricRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  workItemId: string;
  experimentResultId: string;
  name: string;
  value: number;
  unit?: string;
  createdAt: string;
  updatedAt: string;
};

export type ResearchEventRecord = {
  id: string;
  objectiveId?: string;
  branchId?: string;
  workItemId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ResearchProjectionRecord = {
  id: string;
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
  activeSlots: string[];
  lastBranchSwitch?: string;
  lastPatchPromotion?: string;
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
  role: "planner" | "builder";
  summary: string;
  machineSummary?: string;
  rationale?: string;
  result?: "success" | "partial" | "failed";
  files: string[];
  risks: string[];
  runActions: string[];
  successCriteria: string[];
  openQuestions: string[];
  proposedBranches?: Array<{
    title: string;
    hypothesis: string;
  }>;
  researchWorkItems?: Array<{
    title: string;
    prompt: string;
    kind: Exclude<ResearchWorkItemKind, "plan" | "arbitrate_branch">;
    executor?: Exclude<ResearchWorkItemExecutor, "planner" | "arbiter">;
    isolation?: ResearchIsolationMode;
    branchTitle?: string;
  }>;
  confidence?: number;
};

export type WorkerRunRecord = {
  id: string;
  objectiveId: string;
  branchId?: string;
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
  finalization: RunFinalizationMode | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  endedAt?: string;
};

export type AttachmentKind = "text" | "json" | "csv" | "document" | "image" | "other";

export type AttachmentRecord = {
  id: string;
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
  runId?: string;
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
  recentSources: ResearchSourceRecord[];
  recentExperiments: ExperimentResultRecord[];
  latestEvaluation: EvaluationRecord | null;
  latestProjection: ResearchProjectionRecord | null;
  latestWorkerRun: WorkerRunRecord | null;
  blockedReason?: string;
  attachments: AttachmentRecord[];
  activeWorkerProgress: ActiveWorkerProgressRecord[];
  logs: string[];
};

export type AttachmentImportRequest = {
  workspacePath?: string;
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
