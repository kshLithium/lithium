export type ViewerKind = "none" | "memory" | "code" | "paper";

export type RecordStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type RunFinalizationMode = "auto" | "manual" | "terminated";

export type CommandSpec = {
  command: string;
  args: string[];
  cwd: string;
};

export type RuntimeAppState = {
  platform: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  cwd: string;
  selectedWorkspacePath: string;
  selectedWorkspaceLabel: string;
  selectedWorkspaceKind: WorkspaceTransportKind;
  selectedWorkspaceRemoteHost: string | null;
  selectedWorkspaceRemotePath: string | null;
  oracleReady: boolean;
  codexReady: boolean;
  oracleChromePath: string | null;
  discordBotStatus: DiscordBotRuntimeStatus;
  mobileWebStatus?: MobileWebRuntimeStatus;
  settings: AppSettings;
};

export type ThemePreference = "system" | "light" | "dark";
export type AutomationPromptLanguage = "auto" | "ko" | "en";
export type ResolvedTheme = Exclude<ThemePreference, "system">;
export type InitialThemeState = {
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  systemTheme: ResolvedTheme;
};
export type OracleModel = "gpt-5.4" | "gpt-5.4-pro";
export type OracleThinkingTime = "light" | "standard" | "extended" | "heavy";
export type BuilderModel = "gpt-5.4" | "gpt-5.3-codex";
export type BuilderReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type WorkspaceTransportKind = "local" | "ssh" | "container";
export type TerminalConnectionProfile = {
  id: string;
  name: string;
  command: string;
  description?: string;
};
export type RemoteWorkspaceProfile = {
  id: string;
  name: string;
  kind: Exclude<WorkspaceTransportKind, "local">;
  host: string;
  username: string;
  remotePath: string;
  description?: string;
  port?: number;
  privateKeyPath?: string;
  hostFingerprint?: string;
  shell?: string;
  bootstrapCommand?: string;
  containerName?: string;
  containerWorkspacePath?: string;
  devcontainerConfigPath?: string;
  dockerContext?: string;
};

export type DiscordBotSettings = {
  enabled: boolean;
  token: string;
  workspacePath: string;
  allowedUserIds: string[];
  allowedChannelIds: string[];
};

export type DiscordBotConnectionState = "disabled" | "connecting" | "connected" | "error";

export type DiscordBotRuntimeStatus = {
  state: DiscordBotConnectionState;
  botTag: string;
  botUserId: string;
  lastError: string | null;
  workspacePath: string;
};

export type MobileWebRuntimeState = "disabled" | "starting" | "running" | "error";

export type MobileWebRuntimeStatus = {
  state: MobileWebRuntimeState;
  host: string;
  port: number | null;
  authToken: string;
  localUrl: string;
  networkUrl: string;
  staticReady: boolean;
  lastError: string | null;
};

export type AppSettings = {
  themePreference: ThemePreference;
  autopilotPromptLanguage: AutomationPromptLanguage;
  onboardingDismissed: boolean;
  strategistSessionReady: boolean;
  lastWorkspacePath: string;
  sidebarWidth: number;
  codeCanvasWidth: number;
  paperPreviewWidth: number;
  strategistModel: OracleModel;
  strategistReasoningIntensity: OracleThinkingTime;
  builderModel: BuilderModel;
  builderReasoningEffort: BuilderReasoningEffort;
  discordBot: DiscordBotSettings;
  terminalConnectionProfiles: TerminalConnectionProfile[];
  remoteWorkspaceProfiles: RemoteWorkspaceProfile[];
};

export type AppSettingsUpdate = Partial<AppSettings>;

export const DEFAULT_PROJECT_RESEARCH_GOAL = "Define the next research outcome this project should produce.";

export const DEFAULT_APP_SETTINGS: AppSettings = {
  themePreference: "system",
  autopilotPromptLanguage: "auto",
  onboardingDismissed: false,
  strategistSessionReady: false,
  lastWorkspacePath: "",
  sidebarWidth: 220,
  codeCanvasWidth: 540,
  paperPreviewWidth: 780,
  strategistModel: "gpt-5.4",
  strategistReasoningIntensity: "heavy",
  builderModel: "gpt-5.4",
  builderReasoningEffort: "xhigh",
  discordBot: {
    enabled: false,
    token: "",
    workspacePath: "",
    allowedUserIds: [],
    allowedChannelIds: []
  },
  terminalConnectionProfiles: [],
  remoteWorkspaceProfiles: []
};

export type ProjectRecord = {
  id: string;
  name: string;
  workspacePath: string;
  lithiumPath: string;
  manuscriptPath: string;
  oracleModel: OracleModel;
  codexModel: string;
  oracleChromePath?: string;
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
  strategistContextFingerprint?: string;
  strategistLastContextAttachedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectMemoryPreferences = {
  strategistStyle: string;
  builderStyle: string;
  manuscriptStyle: string;
};

export type ProjectMemoryRecord = {
  projectBrief: string;
  researchGoal: string;
  constraints: string[];
  preferences: ProjectMemoryPreferences;
  openQuestions: string[];
  activeHypotheses: string[];
  sessionSummary: string;
  updatedAt: string;
};

export type ContextPackLane = "strategist" | "builder" | "paper";

export type AutomationMode = "checkpoint" | "continuous";
export type AutomationStatus = "idle" | "running";
export type AutomationStepKind =
  | "strategize"
  | "code-edit"
  | "experiment-run"
  | "result-analysis"
  | "paper-sync"
  | "literature-search"
  | "checkpoint";
export type AutomationStepLane = "controller" | "strategist" | "builder" | "researcher" | "writer" | "critic";
export type AutomationBudget = {
  maxSteps: number;
  maxRuntimeMinutes: number;
  maxRetries: number;
  usedSteps: number;
  usedRetries: number;
};
export type AutomationProposedStep = {
  kind: AutomationStepKind;
  title: string;
  prompt: string;
  requiresReview?: boolean;
};
export type AutomationSessionRecord = {
  id: string;
  threadId: string;
  objective: string;
  displayObjective?: string;
  mode: AutomationMode;
  status: AutomationStatus;
  allowedActions: AutomationStepKind[];
  paperWriteEnabled: boolean;
  evidenceMode: "strict" | "pragmatic";
  budget: AutomationBudget;
  latestStepId?: string;
  latestCheckpointId?: string;
  currentStepSummary: string;
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
  kind: AutomationStepKind;
  lane: AutomationStepLane;
  title: string;
  prompt: string;
  status: RecordStatus;
  summary: string;
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
  nextTask?: string;
  rationale?: string;
  result?: "success" | "partial" | "failed";
  files: string[];
  risks: string[];
  paperActions: string[];
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
  rawOutput: string;
  summary: string;
  nextTask?: string;
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
  lane: "router" | "strategist" | "builder";
  progressSummary: string;
  progressDetails: string[];
  activeCommand: string | null;
  stdoutTail: string;
  stderrTail: string;
  updatedAt: string;
};

export type TerminalSessionRecord = {
  id: string;
  threadId: string;
  workspacePath: string;
  shell: string;
  cwd: string;
  status: RecordStatus;
  exitCode: number | null;
  pid: number | null;
  transcriptPath: string;
  stdoutPath?: string;
  stderrPath?: string;
  cols: number;
  rows: number;
  startedAt: string;
  endedAt?: string;
};

export type TerminalSessionRequest = {
  workspacePath?: string;
  sessionId: string;
};

export type TerminalSessionState = TerminalSessionRecord & {
  active: boolean;
  output: string;
};

export type TerminalSessionSummary = TerminalSessionRecord & {
  output: string;
};

export type AttachmentKind = "text" | "json" | "csv" | "pdf" | "image" | "other";

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
};

export type ManuscriptSectionRecord = {
  section: "results";
  path: string;
  content: string;
  updatedAt: string;
};

export type ProjectSnapshot = {
  project: ProjectRecord | null;
  memory: ProjectMemoryRecord | null;
  threads: ThreadRecord[];
  activeThreadId: string | null;
  activeThread: ThreadRecord | null;
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
  terminalSessions: TerminalSessionSummary[];
  latestTerminalSession: TerminalSessionSummary | null;
  manuscript: ManuscriptSectionRecord | null;
  automationSessions?: AutomationSessionRecord[];
  automationSteps?: AutomationStepRecord[];
  automationCheckpoints?: AutomationCheckpointRecord[];
  latestAutomationSession?: AutomationSessionRecord | null;
  latestAutomationCheckpoint?: AutomationCheckpointRecord | null;
  logs: string[];
};

export type ArtifactKind =
  | "code"
  | "text"
  | "json"
  | "csv"
  | "image"
  | "pdf"
  | "tex"
  | "bib"
  | "log"
  | "other";

export type WorkspaceFileKind = "code" | "paper" | "artifact";

export type WorkspaceFileRecord = {
  path: string;
  relativePath: string;
  name: string;
  kind: WorkspaceFileKind;
  artifactKind?: ArtifactKind;
};

export type WorkspaceFileContent = WorkspaceFileRecord & {
  content: string;
};

export type WorkspaceSelectionResult = {
  selectedWorkspacePath: string;
};

export type RemoteWorkspaceConnectRequest = {
  profileId: string;
};

export type RemoteWorkspaceSyncRequest = {
  workspacePath?: string;
};

export type StrategistRequest = {
  workspacePath?: string;
  threadId?: string;
  prompt: string;
  displayPrompt?: string;
  attachExplicitWorkspaceFiles?: boolean;
  model?: OracleModel;
  reasoningIntensity?: OracleThinkingTime;
};

export type StrategistBrowserProbeRequest = {
  workspacePath?: string;
  threadId?: string;
  prompt?: string;
  model: OracleModel;
  reasoningIntensity?: OracleThinkingTime;
};

export type StrategistBrowserProbeAppObservation = {
  pid: number;
  name: string;
  visible: boolean;
  frontmost: boolean;
  windowCount: number;
};

export type StrategistBrowserProbeSample = {
  timestamp: string;
  rootPids: number[];
  rootCommands: string[];
  sawHeadlessFlag: boolean;
  applications: StrategistBrowserProbeAppObservation[];
};

export type StrategistBrowserProbeLaunch = {
  engine: "api" | "browser";
  browserVisible: boolean;
  browserHeadless: boolean;
  keepBrowser: boolean;
  manualLogin: boolean;
  strategistSessionReady: boolean;
  chatgptUrl?: string;
};

export type StrategistBrowserProbeReport = {
  workspacePath: string;
  prompt: string;
  model: OracleModel;
  reasoningIntensity: OracleThinkingTime;
  strategistSessionReady: boolean;
  launch: StrategistBrowserProbeLaunch;
  chromePath: string | null;
  startedAt: string;
  endedAt: string;
  sampleIntervalMs: number;
  sampleCount: number;
  observedBrowserProcess: boolean;
  observedHeadlessProcess: boolean;
  observedVisibleWindow: boolean;
  observedFrontmostWindow: boolean;
  reportPath: string;
  error?: string;
  samples: StrategistBrowserProbeSample[];
};

export type StrategistBrowserProbeResponse = {
  ok: boolean;
  error?: string;
  snapshot: ProjectSnapshot;
  probe: StrategistBrowserProbeReport;
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

export type WorkspaceFileRequest = {
  workspacePath?: string;
  path: string;
};

export type WorkspaceDiffRequest = WorkspaceFileRequest & {
  contextLines?: number;
};

export type WorkspaceFileDiffStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "binary"
  | "clean"
  | "unavailable";

export type WorkspaceFileDiff = {
  path: string;
  relativePath: string;
  status: WorkspaceFileDiffStatus;
  diffText: string;
};

export type WorkspaceFileWriteRequest = {
  workspacePath?: string;
  path: string;
  content: string;
};

export type PaperSyncTargetRequest = {
  workspacePath?: string;
  pdfPath: string;
  sourcePath: string;
  lineNumber: number;
};

export type PaperSyncTarget = {
  pageNumber: number;
  yRatio: number | null;
};

export type PaperSourceTargetRequest = {
  workspacePath?: string;
  pdfPath: string;
  pageNumber: number;
  yRatio: number;
};

export type PaperSourceTarget = {
  sourcePath: string;
  lineNumber: number;
};

export type TerminalSessionCreateRequest = {
  workspacePath?: string;
  threadId?: string;
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  forceNew?: boolean;
  bootstrapCommand?: string;
};

export type TerminalSessionInputRequest = TerminalSessionRequest & {
  data: string;
};

export type TerminalSessionResizeRequest = TerminalSessionRequest & {
  cols: number;
  rows: number;
};

export type TerminalEvent =
  | {
      type: "data";
      workspacePath: string;
      sessionId: string;
      data: string;
    }
  | {
      type: "cwd";
      workspacePath: string;
      sessionId: string;
      cwd: string;
    }
  | {
      type: "exit";
      workspacePath: string;
      sessionId: string;
      status: RecordStatus;
      exitCode: number | null;
      endedAt: string;
    };

export type ThreadSelectionRequest = {
  workspacePath?: string;
  threadId: string;
};

export type ThreadCreateRequest = {
  workspacePath?: string;
  title?: string;
};

export type ThreadRenameRequest = {
  workspacePath?: string;
  threadId: string;
  title: string;
};

export type ThreadMemoryUpdateRequest = {
  workspacePath?: string;
  threadId?: string;
  memory: string;
};

export type ThreadDeleteRequest = {
  workspacePath?: string;
  threadId: string;
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
  paperWriteEnabled?: boolean;
};

export type AutomationSessionControlRequest = {
  workspacePath?: string;
  sessionId: string;
};

export type AutomationInterruptRequest = AutomationSessionControlRequest & {
  instruction: string;
  stopNow?: boolean;
};

export type AutomationCheckpointApprovalRequest = AutomationSessionControlRequest & {
  checkpointId?: string;
  response?: string;
};

export type AppCommand =
  | "open-workspace"
  | "save-current-surface"
  | "open-new-thread"
  | "new-code-file"
  | "open-settings"
  | "toggle-sidebar"
  | "toggle-terminal";

export type ProjectMemoryUpdate = {
  workspacePath?: string;
  projectBrief?: string;
  researchGoal?: string;
  constraints?: string[];
  openQuestions?: string[];
  activeHypotheses?: string[];
  preferences?: Partial<ProjectMemoryPreferences>;
  sessionSummary?: string;
};

export type LithiumApi = {
  getInitialThemeState: () => InitialThemeState;
  onThemeStateChange: (listener: (themeState: InitialThemeState) => void) => () => void;
  getAppState: () => Promise<RuntimeAppState>;
  pickWorkspace: () => Promise<WorkspaceSelectionResult>;
  connectRemoteWorkspace: (request: RemoteWorkspaceConnectRequest) => Promise<WorkspaceSelectionResult>;
  syncRemoteWorkspace: (request?: RemoteWorkspaceSyncRequest) => Promise<WorkspaceSelectionResult>;
  pickAttachmentFiles: (workspacePath?: string) => Promise<string[]>;
  initProject: (workspacePath?: string) => Promise<ProjectSnapshot>;
  getProjectSnapshot: (workspacePath?: string) => Promise<ProjectSnapshot>;
  createThread: (request?: ThreadCreateRequest) => Promise<ProjectSnapshot>;
  selectThread: (request: ThreadSelectionRequest) => Promise<ProjectSnapshot>;
  renameThread: (request: ThreadRenameRequest) => Promise<ProjectSnapshot>;
  updateThreadMemory: (request: ThreadMemoryUpdateRequest) => Promise<ProjectSnapshot>;
  deleteThread: (request: ThreadDeleteRequest) => Promise<ProjectSnapshot>;
  getProjectMemory: (workspacePath?: string) => Promise<ProjectMemoryRecord | null>;
  updateProjectMemory: (request: ProjectMemoryUpdate) => Promise<ProjectSnapshot>;
  createAutomationSession: (request: AutomationSessionCreateRequest) => Promise<ProjectSnapshot>;
  startAutomationSession: (request: AutomationSessionControlRequest) => Promise<ProjectSnapshot>;
  pauseAutomationSession: (request: AutomationSessionControlRequest) => Promise<ProjectSnapshot>;
  resumeAutomationSession: (request: AutomationSessionControlRequest) => Promise<ProjectSnapshot>;
  interruptAutomationSession: (request: AutomationInterruptRequest) => Promise<ProjectSnapshot>;
  approveAutomationCheckpoint: (request: AutomationCheckpointApprovalRequest) => Promise<ProjectSnapshot>;
  beginStrategistSignIn: () => Promise<AppSettings>;
  sendChatMessage: (request: ChatRequest) => Promise<ProjectSnapshot>;
  consultStrategist: (request: StrategistRequest) => Promise<ProjectSnapshot>;
  inspectChatProgress: (request?: ChatProgressRequest) => Promise<ChatProgressInspection | null>;
  runStrategistBrowserProbe: (
    request: StrategistBrowserProbeRequest
  ) => Promise<StrategistBrowserProbeResponse>;
  startBuilderTask: (request: BuilderRequest) => Promise<ProjectSnapshot>;
  runBuilderTask: (request: BuilderRequest) => Promise<ProjectSnapshot>;
  inspectBuilderRun: (request: BuilderRunControlRequest) => Promise<BuilderRunInspection | null>;
  terminateBuilderRun: (request: BuilderRunControlRequest) => Promise<ProjectSnapshot>;
  finalizeBuilderRun: (request: BuilderRunControlRequest) => Promise<ProjectSnapshot>;
  updateManuscript: (workspacePath?: string) => Promise<ProjectSnapshot>;
  compilePaper: (workspacePath?: string) => Promise<ProjectSnapshot>;
  importAttachments: (request: AttachmentImportRequest) => Promise<ProjectSnapshot>;
  removeAttachment: (request: AttachmentDeleteRequest) => Promise<ProjectSnapshot>;
  listWorkspaceFiles: (workspacePath?: string) => Promise<WorkspaceFileRecord[]>;
  readWorkspaceFile: (request: WorkspaceFileRequest) => Promise<WorkspaceFileContent>;
  readWorkspaceFileBytes: (request: WorkspaceFileRequest) => Promise<Uint8Array>;
  readWorkspaceDiff: (request: WorkspaceDiffRequest) => Promise<WorkspaceFileDiff | null>;
  saveWorkspaceFile: (request: WorkspaceFileWriteRequest) => Promise<WorkspaceFileContent>;
  resolvePaperSyncTarget: (request: PaperSyncTargetRequest) => Promise<PaperSyncTarget | null>;
  resolvePaperSourceTarget: (request: PaperSourceTargetRequest) => Promise<PaperSourceTarget | null>;
  createTerminalSession: (request: TerminalSessionCreateRequest) => Promise<TerminalSessionState>;
  getTerminalSession: (request: TerminalSessionRequest) => Promise<TerminalSessionState | null>;
  writeTerminalInput: (request: TerminalSessionInputRequest) => Promise<boolean>;
  resizeTerminalSession: (request: TerminalSessionResizeRequest) => Promise<TerminalSessionState | null>;
  closeTerminalSession: (request: TerminalSessionRequest) => Promise<TerminalSessionState | null>;
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => () => void;
  onAppCommand: (listener: (command: AppCommand) => void) => () => void;
  updateAppSettings: (request: AppSettingsUpdate) => Promise<AppSettings>;
  toggleFullscreen: () => Promise<boolean>;
};
