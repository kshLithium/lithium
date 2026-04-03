import type { ChatProgressInspection, ConversationEntryRecord } from "../../shared/types";

const MAX_CONVERSATION_LANGUAGE_CACHE_ENTRIES = 256;
const MAX_CHAT_PROGRESS_ENTRIES_PER_WORKSPACE = 64;

export type ActiveChatProgress = {
  operationId: string;
  lane: "orchestrator" | "router" | "strategist" | "builder";
  threadId: string;
  promptPreview?: string;
  progressSummary: string;
  progressDetails: string[];
  activeCommand: string | null;
  oracleSessionSlug?: string;
  stdoutPath?: string;
  stderrPath?: string;
  updatedAt: string;
};

export type AutomationControllerState = {
  running: boolean;
  pauseRequested: boolean;
  stopRequested: boolean;
  redirectInstruction: string;
  activeBuilderRuns: Map<string, string>;
  activeStrategistSessions: Map<string, string>;
};

export class RuntimeRegistry {
  private readonly terminatingRunIds = new Set<string>();
  private readonly activeChatProgressByKey = new Map<string, ActiveChatProgress>();
  private readonly conversationLanguageByThread = new Map<string, "ko" | "en">();
  private readonly automationControllers = new Map<string, AutomationControllerState>();
  private readonly orchestratorTurnLocks = new Map<string, Promise<void>>();

  markRunTerminating(runId: string) {
    this.terminatingRunIds.add(runId);
  }

  clearRunTerminating(runId: string) {
    this.terminatingRunIds.delete(runId);
  }

  isRunTerminating(runId: string) {
    return this.terminatingRunIds.has(runId);
  }

  getAutomationController(workspacePath: string, sessionId: string) {
    const key = automationControllerKey(workspacePath, sessionId);
    const existing = this.automationControllers.get(key);

    if (existing) {
      return existing;
    }

    const created: AutomationControllerState = {
      running: false,
      pauseRequested: false,
      stopRequested: false,
      redirectInstruction: "",
      activeBuilderRuns: new Map(),
      activeStrategistSessions: new Map()
    };
    this.automationControllers.set(key, created);
    return created;
  }

  peekAutomationController(workspacePath: string, sessionId: string) {
    return this.automationControllers.get(automationControllerKey(workspacePath, sessionId)) ?? null;
  }

  cleanupAutomationController(workspacePath: string, sessionId: string) {
    const key = automationControllerKey(workspacePath, sessionId);
    const controller = this.automationControllers.get(key);

    if (!controller || controller.running) {
      return;
    }

    controller.pauseRequested = false;
    controller.stopRequested = false;
    controller.redirectInstruction = "";
    controller.activeBuilderRuns.clear();
    controller.activeStrategistSessions.clear();
    this.automationControllers.delete(key);
  }

  setChatProgress(
    workspacePath: string,
    input: Omit<ActiveChatProgress, "updatedAt" | "operationId"> & { operationId?: string }
  ) {
    const operationId = input.operationId?.trim() || input.lane;
    const key = chatProgressKey(workspacePath, input.threadId, operationId);

    this.activeChatProgressByKey.set(key, {
      ...input,
      operationId,
      updatedAt: new Date().toISOString()
    });
    pruneWorkspaceChatProgress(this.activeChatProgressByKey, workspacePath);
  }

  clearChatProgress(workspacePath: string, threadId?: string, operationId?: string) {
    if (threadId?.trim()) {
      if (operationId?.trim()) {
        this.activeChatProgressByKey.delete(chatProgressKey(workspacePath, threadId, operationId));
        return;
      }

      const threadPrefix = `${workspacePath}::${threadId}::`;

      for (const key of this.activeChatProgressByKey.keys()) {
        if (key.startsWith(threadPrefix)) {
          this.activeChatProgressByKey.delete(key);
        }
      }
      return;
    }

    const prefix = `${workspacePath}::`;

    for (const key of this.activeChatProgressByKey.keys()) {
      if (key === workspacePath || key.startsWith(prefix)) {
        this.activeChatProgressByKey.delete(key);
      }
    }
  }

  clearChatProgressIfCurrentMatches(
    workspacePath: string,
    threadId: string,
    operationId: string,
    stdoutPath?: string,
    stderrPath?: string
  ) {
    const key = chatProgressKey(workspacePath, threadId, operationId);
    const current = this.activeChatProgressByKey.get(key);

    if (!current) {
      return;
    }

    if (
      (stdoutPath && current.stdoutPath && current.stdoutPath !== stdoutPath) ||
      (stderrPath && current.stderrPath && current.stderrPath !== stderrPath)
    ) {
      return;
    }

    this.activeChatProgressByKey.delete(key);
  }

  listChatProgressEntries(workspacePath: string, threadId?: string) {
    if (threadId?.trim()) {
      const threadPrefix = `${workspacePath}::${threadId}::`;
      return Array.from(this.activeChatProgressByKey.entries())
        .filter(([key]) => key.startsWith(threadPrefix))
        .map(([, value]) => value)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    const prefix = `${workspacePath}::`;
    const candidates = Array.from(this.activeChatProgressByKey.entries())
      .filter(([key]) => key === workspacePath || key.startsWith(prefix))
      .map(([, value]) => value)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const latestThreadId = candidates[0]?.threadId;

    if (!latestThreadId) {
      return [];
    }

    return candidates.filter((candidate) => candidate.threadId === latestThreadId);
  }

  getLatestChatProgressEntry(
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

  rememberObservedChatProgress(
    workspacePath: string,
    current: ActiveChatProgress,
    inspection: ChatProgressInspection
  ) {
    const key = chatProgressKey(workspacePath, current.threadId, current.operationId);
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

    this.activeChatProgressByKey.set(key, nextProgress);
  }

  rememberConversationLanguage(
    workspacePath: string,
    entry: Pick<ConversationEntryRecord, "threadId" | "role" | "body">,
    resolveLanguage: (body: string) => "ko" | "en"
  ) {
    if (entry.role !== "user") {
      return;
    }

    setBoundedMapValue(
      this.conversationLanguageByThread,
      conversationLanguageKey(workspacePath, entry.threadId),
      resolveLanguage(entry.body),
      MAX_CONVERSATION_LANGUAGE_CACHE_ENTRIES
    );
  }

  getConversationLanguage(workspacePath: string, threadId: string) {
    return this.conversationLanguageByThread.get(conversationLanguageKey(workspacePath, threadId)) ?? null;
  }

  async runSerialized<T>(workspacePath: string, scopeKey: string, task: () => Promise<T>) {
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
}

function automationControllerKey(workspacePath: string, sessionId: string) {
  return `${workspacePath}::${sessionId}`;
}

function conversationLanguageKey(workspacePath: string, threadId: string) {
  return `${workspacePath}::${threadId}`;
}

function chatProgressKey(workspacePath: string, threadId: string, operationId: string) {
  return `${workspacePath}::${threadId}::${operationId}`;
}

function pruneWorkspaceChatProgress(
  map: Map<string, ActiveChatProgress>,
  workspacePath: string
) {
  const prefix = `${workspacePath}::`;
  const keys = Array.from(map.entries())
    .filter(([key]) => key.startsWith(prefix))
    .sort((left, right) => left[1].updatedAt.localeCompare(right[1].updatedAt))
    .map(([key]) => key);

  while (keys.length > MAX_CHAT_PROGRESS_ENTRIES_PER_WORKSPACE) {
    const oldestKey = keys.shift();

    if (!oldestKey) {
      break;
    }

    map.delete(oldestKey);
  }
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
