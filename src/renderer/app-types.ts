import type { ArtifactKind, ProjectSnapshot, WorkspaceFileKind } from "../shared/types";

export type ChatItem = {
  id: string;
  role: "system" | "user" | "assistant";
  body: string;
  timestamp: string;
  order: number;
  pending?: boolean;
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
  automationSessions: [],
  automationSteps: [],
  automationCheckpoints: [],
  latestAutomationSession: null,
  latestAutomationCheckpoint: null,
  logs: []
};
