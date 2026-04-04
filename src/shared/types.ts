export const PROJECT_SCHEMA_VERSION = 4;

export type PromptLanguage = "auto" | "ko" | "en";
export type OracleModel = "gpt-5.4-pro";
export type OracleThinkingTime = "extended";
export type BuilderModel = "gpt-5.4" | "gpt-5.3-codex";
export type BuilderReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type RecordStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type RunFinalizationMode = "auto" | "manual" | "terminated";

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

export const DEFAULT_APP_SETTINGS: AppSettings = {
  promptLanguage: "auto",
  oracleSessionReady: false,
  lastWorkspacePath: "",
  oracleModel: "gpt-5.4-pro",
  oracleThinkingTime: "extended",
  builderModel: "gpt-5.4",
  builderReasoningEffort: "high"
};

export type CommandSpec = {
  command: string;
  args: string[];
  cwd: string;
};

export type WorkspaceRecord = {
  id: string;
  schemaVersion: number;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type ProjectRecord = WorkspaceRecord;

export type ObjectiveStatus = "draft" | "active" | "completed" | "failed" | "archived";
export type BranchStatus = "candidate" | "active" | "completed" | "killed" | "pivoted";
export type ResearchTaskKind =
  | "plan"
  | "discover"
  | "read_synthesize"
  | "build_change"
  | "run_experiment"
  | "evaluate_branch";
export type TaskExecutor = "strategist" | "builder" | "experimenter" | "evaluator";
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "needs-human";
export type TaskTerminalStatus = Extract<TaskStatus, "completed" | "failed" | "cancelled" | "needs-human">;
export type RunStatus = "idle" | "active" | "paused" | "completed" | "failed" | "stopped" | "needs-human";
export type RecoveryAction = "reattach" | "retryable" | "needs-human";
export type EvaluationVerdict = "continue" | "kill" | "pivot" | "complete";
export type DependencyCondition = "success" | "failed" | "terminal";
export type SourceKind = "file" | "web" | "repo" | "paper" | "attachment";
export type ArtifactKind =
  | "patch"
  | "stdout"
  | "stderr"
  | "output"
  | "manifest"
  | "source-body"
  | "source-text"
  | "source-chunk"
  | "attachment"
  | "daemon-log";
export type WorkerProvider = "strategist" | "builder" | "experimenter" | "evaluator";

export type RunBudget = {
  planning: number;
  discovery: number;
  build: number;
  experiment: number;
  evaluation: number;
  wallClockMs: number;
  maxBranches: number;
  maxCostUsd?: number;
};

export type RunBudgetUsage = {
  planning: number;
  discovery: number;
  build: number;
  experiment: number;
  evaluation: number;
  totalCostUsd?: number;
  startedAt: string;
};

export type TaskBudgetBucket = "planning" | "discovery" | "build" | "experiment" | "evaluation";

export type TaskDependency = {
  taskId: string;
  on: DependencyCondition;
};

export type PriorityScore = {
  objectiveAlignment: number;
  expectedInfoGain: number;
  feasibility: number;
  estimatedCost: number;
  evidenceStrength: number;
  duplicationPenalty: number;
  total: number;
};

export type ObjectiveRecord = {
  id: string;
  title: string;
  objective: string;
  summary: string;
  status: ObjectiveStatus;
  successCriteria: string[];
  branchIds: string[];
  activeBranchId?: string;
  activeRunId?: string;
  createdAt: string;
  updatedAt: string;
};

export type BranchRecord = {
  id: string;
  objectiveId: string;
  title: string;
  hypothesis: string;
  status: BranchStatus;
  score: number;
  baseCommit?: string;
  gitRef?: string;
  headCommit?: string;
  worktreePath?: string;
  promotionHeadCommit?: string;
  sourceIds: string[];
  findingIds: string[];
  taskIds: string[];
  latestEvaluationId?: string;
  lastFailureReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactRef = {
  id: string;
  kind: ArtifactKind;
  path: string;
  hash?: string;
  contentType?: string;
  sizeBytes?: number;
  createdAt: string;
};

export type SourceRecord = {
  id: string;
  objectiveId: string;
  branchId?: string;
  kind: SourceKind;
  title: string;
  locator: string;
  canonicalLocator: string;
  summary: string;
  bodyArtifactRef?: ArtifactRef;
  textArtifactRef?: ArtifactRef;
  contentHash?: string;
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
};

export type SourceChunkRecord = {
  id: string;
  sourceId: string;
  objectiveId: string;
  branchId?: string;
  chunkIndex: number;
  text: string;
  textArtifactRef?: ArtifactRef;
  hash: string;
  createdAt: string;
  updatedAt: string;
};

export type FindingRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  sourceId?: string;
  sourceChunkIds: string[];
  summary: string;
  detail?: string;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
};

export type MetricExpectation = {
  name: string;
  value?: number;
  min?: number;
  max?: number;
  baselineDelta?: number;
};

export type MetricMeasurement = {
  name: string;
  value: number;
  unit?: string;
};

export type ExperimentManifest = {
  commands: string[];
  exitCode: number | null;
  status: TaskTerminalStatus;
  stdoutPath?: string;
  stderrPath?: string;
  outputPath?: string;
  artifacts: string[];
  metrics: MetricMeasurement[];
  expectations: MetricExpectation[];
  baselineCompare?: Record<string, number>;
};

export type ExperimentRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  taskId: string;
  status: TaskTerminalStatus;
  summary: string;
  manifestRef?: ArtifactRef;
  stdoutRef?: ArtifactRef;
  stderrRef?: ArtifactRef;
  patchArtifactRef?: ArtifactRef;
  changedFiles: string[];
  metrics: MetricMeasurement[];
  createdAt: string;
  updatedAt: string;
};

export type MetricRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  taskId: string;
  experimentId: string;
  name: string;
  value: number;
  unit?: string;
  createdAt: string;
  updatedAt: string;
};

export type EvaluationRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  taskId: string;
  verdict: EvaluationVerdict;
  scoreDelta: number;
  summary: string;
  rationale: string;
  followupPrompt?: string;
  createdAt: string;
  updatedAt: string;
};

export type RunRecord = {
  id: string;
  objectiveId: string;
  status: RunStatus;
  budget: RunBudget;
  budgetUsage: RunBudgetUsage;
  activeTaskIds: string[];
  stopReason?: string;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
};

export type WorktreeLeaseRecord = {
  id: string;
  taskId: string;
  branchId: string;
  worktreePath: string;
  tempDir: string;
  status: "active" | "released" | "failed";
  createdAt: string;
  updatedAt: string;
  releasedAt?: string;
  cleanupError?: string;
};

export type TaskProposal = {
  title: string;
  prompt: string;
  kind: Exclude<ResearchTaskKind, "evaluate_branch"> | "evaluate_branch";
  branchTitle?: string;
  expectedInfoGain: number;
  estimatedCost: number;
  evidenceNeeded: string[];
  successRubric: string[];
  stopCondition: string;
  dependencyMode: DependencyCondition;
  branchUpdateIntent: "advance" | "branch" | "verify" | "kill";
  sourceIds?: string[];
  verificationCommands?: string[];
  questions?: string[];
  commands?: string[];
};

export type PlannerProposal = {
  summary: string;
  rationale: string;
  proposedBranches: Array<{
    title: string;
    hypothesis: string;
  }>;
  proposedTasks: TaskProposal[];
};

export type DiscoveredSourceSpec = {
  locator: string;
  title: string;
  kind: Extract<SourceKind, "web" | "repo" | "paper">;
  summary: string;
  excerpt?: string;
  branchTitle?: string;
};

export type SynthesizedFindingSpec = {
  summary: string;
  detail?: string;
  sourceLocator: string;
  citationText?: string;
};

export type EvaluationInput = {
  branchId: string;
  subjectTaskId: string;
  subjectTaskStatus: TaskTerminalStatus;
  workerRunId?: string;
  patchArtifactRef?: ArtifactRef;
  changedFiles: string[];
  experimentResultIds: string[];
  metricRefs: string[];
  sourceRefs: string[];
  successCriteria: string[];
  baselineRefs: string[];
  focus: string;
};

export type PlanTaskPayload = {
  objectiveId: string;
  activeBranchId: string;
  goal: string;
};

export type DiscoverTaskPayload = {
  branchId: string;
  goal: string;
  maxResults: number;
  domains?: string[];
};

export type ReadTaskPayload = {
  branchId: string;
  sourceIds: string[];
  questions: string[];
};

export type BuildTaskPayload = {
  branchId: string;
  goal: string;
  constraints: string[];
  verificationCommands: string[];
  successCriteria: string[];
};

export type ExperimentTaskPayload = {
  branchId: string;
  commands: string[];
  timeoutMs: number;
  expectedMetrics: MetricExpectation[];
};

export type EvaluateTaskPayload = EvaluationInput;

export type TaskPayload =
  | PlanTaskPayload
  | DiscoverTaskPayload
  | ReadTaskPayload
  | BuildTaskPayload
  | ExperimentTaskPayload
  | EvaluateTaskPayload;

export type TaskRecord = {
  id: string;
  objectiveId: string;
  branchId: string;
  runId: string;
  kind: ResearchTaskKind;
  executor: TaskExecutor;
  status: TaskStatus;
  title: string;
  prompt: string;
  payload: TaskPayload;
  dependencies: TaskDependency[];
  priority: PriorityScore;
  attemptCount: number;
  maxAttempts: number;
  workerRunId?: string;
  evaluationId?: string;
  recoveryAction?: RecoveryAction;
  summary?: string;
  changedFiles?: string[];
  artifactRefs?: ArtifactRef[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type WorkerRunRecord = {
  id: string;
  taskId: string;
  runId: string;
  objectiveId: string;
  branchId: string;
  provider: WorkerProvider;
  command: CommandSpec;
  status: "running" | TaskTerminalStatus;
  pid: number | null;
  model?: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath?: string;
  worktreePath?: string;
  tempDir?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  endedAt?: string;
};

export type TaskOutcome = {
  status: TaskTerminalStatus;
  summary: string;
  failureReason?: string;
  retryability: RecoveryAction;
  artifactRefs: ArtifactRef[];
  changedFiles: string[];
  metrics: MetricMeasurement[];
  providerMetadata?: Record<string, unknown>;
  plan?: PlannerProposal;
  discoveredSources?: DiscoveredSourceSpec[];
  findings?: SynthesizedFindingSpec[];
  evaluation?: Omit<EvaluationRecord, "id" | "objectiveId" | "branchId" | "taskId" | "createdAt" | "updatedAt">;
  experimentManifest?: ExperimentManifest;
};

export type EventRecord<T extends Record<string, unknown> = Record<string, unknown>> = {
  sequence?: number;
  id: string;
  type: string;
  objectiveId?: string;
  branchId?: string;
  runId?: string;
  taskId?: string;
  createdAt: string;
  payload: T;
};

export type WorkspaceProjection = {
  workspace: WorkspaceRecord | null;
  objectives: ObjectiveRecord[];
  activeObjective: ObjectiveRecord | null;
  branches: BranchRecord[];
  tasks: TaskRecord[];
  runs: RunRecord[];
  sources: SourceRecord[];
  sourceChunks: SourceChunkRecord[];
  findings: FindingRecord[];
  evaluations: EvaluationRecord[];
  experiments: ExperimentRecord[];
  metrics: MetricRecord[];
  workerRuns: WorkerRunRecord[];
  leases: WorktreeLeaseRecord[];
};

export type StatusSnapshot = {
  workspacePath: string;
  schemaVersion: number;
  daemon: {
    running: boolean;
    pid?: number;
    socketPath: string;
  };
  activeObjective: ObjectiveRecord | null;
  activeRun: RunRecord | null;
  branches: BranchRecord[];
  queue: TaskRecord[];
  activeTasks: TaskRecord[];
  recentEvaluations: EvaluationRecord[];
  recentFindings: FindingRecord[];
};

export type RpcMethod =
  | "daemon.status"
  | "daemon.stop"
  | "status.snapshot"
  | "objective.create"
  | "objective.list"
  | "objective.show"
  | "run.start"
  | "run.pause"
  | "run.resume"
  | "run.stop"
  | "source.add";

export type RpcRequest = {
  id: string;
  method: RpcMethod;
  params?: Record<string, unknown>;
};

export type RpcResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type ObjectiveCreateInput = {
  title?: string;
  objective: string;
  successCriteria?: string[];
};

export type SourceAddInput = {
  objectiveId?: string;
  branchId?: string;
  inputs: string[];
};

export type DaemonStatus = {
  running: boolean;
  pid?: number;
  socketPath: string;
  workspacePath: string;
};

export type WorkspaceArchiveResult = {
  archivedPath: string;
};
