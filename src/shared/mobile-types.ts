export type MobileThread = {
  id: string;
  title: string;
  lastActivityAt?: string;
  unreadCount?: number;
};

export type MobileMessageRole = "user" | "assistant" | "system";

export type MobileMessage = {
  id: string;
  role: MobileMessageRole;
  content: string;
  createdAt: string;
  status?: "sending" | "streaming" | "done" | "error";
};

export type MobileResearchStatus =
  | "idle"
  | "running"
  | "paused"
  | "blocked"
  | "failed"
  | "completed";

export type MobileAutoresearchSession = {
  id: string;
  objective: string;
  status: MobileResearchStatus;
  currentStep?: string;
  lastUpdate?: string;
  nextActions: string[];
  threadId?: string;
  startedAt?: string;
  updatedAt?: string;
};

export type MobileBootstrap = {
  appName: string;
  connected: boolean;
  serverTime: string;
  selectedWorkspacePath: string;
  selectedThreadId: string | null;
  threads: MobileThread[];
  messages: MobileMessage[];
  autoresearch: MobileAutoresearchSession | null;
};

export type MobileThreadCreateRequest = {
  title?: string;
};

export type MobileThreadSelectRequest = {
  threadId: string;
};

export type MobileChatRequest = {
  threadId: string;
  prompt: string;
};

export type MobileAutoresearchStartRequest = {
  threadId?: string;
  objective: string;
};

export type MobileAutoresearchControlRequest = {
  sessionId: string;
};

export type MobileApiError = {
  message: string;
  status: number;
};
