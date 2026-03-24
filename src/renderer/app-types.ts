import type {
  ArtifactKind,
  PaperSyncTarget,
  ProjectSnapshot,
  WorkspaceFileKind
} from "../shared/types";

export type DrawerTab = "none" | "memory" | "paper";
export type SurfaceMode = "chat" | Exclude<DrawerTab, "none">;
export type ResizeTarget = "sidebar" | "code-canvas" | "paper-preview" | null;

export type ChatItem = {
  id: string;
  role: "system" | "user" | "assistant";
  variant: "neutral" | "research" | "build" | "trace";
  statusTone?: "neutral" | "running" | "paused" | "failed" | "blocked" | "recorded" | "approved";
  title: string;
  body: string;
  timestamp: string;
  order: number;
  pending?: boolean;
  badges?: string[];
  details?: string[];
  artifacts?: ChatArtifactRef[];
};

export type ChatArtifactRef = {
  id: string;
  path: string;
  relativePath: string;
  label: string;
  kind: WorkspaceFileKind;
  artifactKind?: ArtifactKind;
};

export type ChatArtifactDiffStat = {
  added: number;
  removed: number;
  status: "modified" | "added" | "deleted" | "untracked" | "binary" | "clean" | "unavailable";
};

export type MemoryDraft = {
  projectBrief: string;
  researchGoal: string;
  openQuestions: string;
  activeHypotheses: string;
};

export type ThreadMemoryDraft = {
  memory: string;
};

export type ExplorerRow = {
  id: string;
  kind: "dir" | "file";
  label: string;
  depth: number;
  path: string;
  collapsed?: boolean;
  changed?: boolean;
};

export type PaperOutlineRow = {
  id: string;
  kind: "group" | "file";
  label: string;
  path: string;
  tone?: "main" | "section" | "reference";
  lineNumber?: number;
};

export type CodeTab = {
  path: string;
  label: string;
  filePath: string | null;
  draft: string;
  dirty: boolean;
  isPreview: boolean;
  loaded: boolean;
  isUntitled: boolean;
};

export type PaperPreviewJump = {
  nonce: number;
  target: PaperSyncTarget;
};

export const emptySnapshot: ProjectSnapshot = {
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

export const emptyMemoryDraft: MemoryDraft = {
  projectBrief: "",
  researchGoal: "",
  openQuestions: "",
  activeHypotheses: ""
};

export const emptyThreadMemoryDraft: ThreadMemoryDraft = {
  memory: ""
};
