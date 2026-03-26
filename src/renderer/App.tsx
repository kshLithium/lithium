import {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from "react";
import type {
  ChatProgressInspection,
  ProjectSnapshot,
  RuntimeAppState
} from "../shared/types";
import type { ChatItem } from "./app-types";
import { emptySnapshot } from "./app-types";
import { ChatFeed } from "./ChatFeed";
import { stabilizeChatProgress } from "./chat-progress";
import { Composer } from "./Composer";
import {
  buildAppStateRevision,
  buildSnapshotRevision,
  isPendingChatVisible,
  summarizeWorkspacePath,
  UNASSIGNED_PENDING_THREAD_ID
} from "./app-shell-utils";
import {
  buildChatItems,
  formatLiveProgressBody,
  formatThreadLabel,
  mergeTransientChatItems,
  toErrorMessage
} from "./app-utils";
import { usePollingTask } from "./usePollingTask";

const SIDEBAR_WIDTH = "var(--sidebar-width-open)";

export default function App() {
  const [appState, setAppState] = useState<RuntimeAppState | null>(null);
  const [snapshot, setSnapshot] = useState<ProjectSnapshot>(emptySnapshot);
  const [composerValue, setComposerValue] = useState("");
  const [pendingChatItems, setPendingChatItems] = useState<ChatItem[]>([]);
  const [pendingChatThreadId, setPendingChatThreadId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [chatProgress, setChatProgress] = useState<ChatProgressInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastChatScrollKeyRef = useRef("");
  const shellReadySentRef = useRef(false);
  const busyActionTokenRef = useRef(0);
  const appStateRevisionRef = useRef("");
  const snapshotRevisionRef = useRef(buildSnapshotRevision(emptySnapshot));
  const hasBridge =
    typeof window !== "undefined" &&
    typeof window.lithium !== "undefined" &&
    typeof window.lithium.getAppState === "function";

  const workspacePath = appState?.selectedWorkspacePath ?? "";
  const projectReady = Boolean(snapshot.project);
  const activeThreadId = snapshot.activeThreadId ?? snapshot.threads[0]?.id ?? null;
  const activeAutomationSession = snapshot.latestAutomationSession ?? null;
  const automationActive = activeAutomationSession?.status === "running" || Boolean(busyAction);
  const chatItems = useMemo(() => buildChatItems(snapshot, workspacePath), [snapshot, workspacePath]);
  const visiblePendingChatItems = useMemo(
    () => (isPendingChatVisible(pendingChatThreadId, activeThreadId) ? pendingChatItems : []),
    [activeThreadId, pendingChatItems, pendingChatThreadId]
  );
  const visibleChatItems = useMemo(
    () =>
      mergeTransientChatItems(chatItems, visiblePendingChatItems, {
        activeThreadId,
        busyAction,
        busyBody: busyAction ? formatLiveProgressBody(chatProgress) : "",
        chatProgress,
        workspacePath
      }),
    [activeThreadId, busyAction, chatItems, chatProgress, visiblePendingChatItems, workspacePath]
  );
  const latestChatItemKey = visibleChatItems[visibleChatItems.length - 1]?.id ?? "";
  const workspaceShellStyle = useMemo(
    () => ({ ["--sidebar-width" as string]: sidebarCollapsed ? "0rem" : SIDEBAR_WIDTH }),
    [sidebarCollapsed]
  );

  const refreshProgress = useEffectEvent(async (nextWorkspacePath?: string) => {
    if (!hasBridge || typeof window.lithium.inspectChatProgress !== "function") {
      setChatProgress(null);
      return;
    }

    const progress = await window.lithium.inspectChatProgress({
      workspacePath: nextWorkspacePath || undefined
    });
    setChatProgress((current) => stabilizeChatProgress(current, progress));
  });

  const refreshSnapshot = useEffectEvent(async (nextWorkspacePath?: string) => {
    if (!hasBridge) {
      return emptySnapshot;
    }

    const nextSnapshot = await window.lithium.getProjectSnapshot(nextWorkspacePath || undefined);
    const nextRevision = buildSnapshotRevision(nextSnapshot);

    if (nextRevision !== snapshotRevisionRef.current) {
      snapshotRevisionRef.current = nextRevision;
      startTransition(() => {
        setSnapshot(nextSnapshot);
      });
    }

    return nextSnapshot;
  });

  const refreshAppState = useEffectEvent(async () => {
    if (!hasBridge) {
      return null;
    }

    const nextAppState = await window.lithium.getAppState();
    const nextRevision = buildAppStateRevision(nextAppState);

    if (nextRevision !== appStateRevisionRef.current) {
      appStateRevisionRef.current = nextRevision;
      setAppState(nextAppState);
    }

    return nextAppState;
  });

  const refreshAll = useEffectEvent(async (nextWorkspacePath?: string, nextSnapshot?: ProjectSnapshot) => {
    const nextAppState = await refreshAppState();
    const resolvedWorkspacePath = nextWorkspacePath ?? nextAppState?.selectedWorkspacePath ?? "";

    if (nextSnapshot) {
      const nextRevision = buildSnapshotRevision(nextSnapshot);

      if (nextRevision !== snapshotRevisionRef.current) {
        snapshotRevisionRef.current = nextRevision;
        startTransition(() => {
          setSnapshot(nextSnapshot);
        });
      }
    } else {
      await refreshSnapshot(resolvedWorkspacePath);
    }

    if (activeAutomationSession?.status === "running" || busyAction) {
      await refreshProgress(resolvedWorkspacePath);
    } else {
      setChatProgress(null);
    }
  });

  const notifyShellReady = useEffectEvent(async () => {
    if (
      shellReadySentRef.current ||
      !hasBridge ||
      typeof window.lithium.notifyShellReady !== "function"
    ) {
      return;
    }

    shellReadySentRef.current = true;

    try {
      await window.lithium.notifyShellReady();
    } catch {
      // Ignore shell-ready failures in dev or during teardown.
    }
  });

  const handleAppCommand = useEffectEvent((command: string) => {
    if (command === "open-workspace") {
      void handlePickWorkspace();
      return;
    }

    if (command === "open-new-thread") {
      void handleCreateThread();
      return;
    }

    if (command === "toggle-sidebar") {
      setSidebarCollapsed((current) => !current);
    }
  });

  useEffect(() => {
    if (!hasBridge) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        await refreshAll();
      } finally {
        if (!cancelled) {
          await notifyShellReady();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasBridge, notifyShellReady, refreshAll]);

  usePollingTask({
    deps: [workspacePath, activeThreadId, activeAutomationSession?.id ?? "", automationActive],
    enabled: hasBridge && Boolean(workspacePath) && automationActive,
    initialDelayMs: 8000,
    task: async () => {
      await refreshSnapshot(workspacePath || undefined);
      return 20000;
    }
  });

  usePollingTask({
    deps: [workspacePath, activeThreadId, activeAutomationSession?.id ?? "", automationActive],
    enabled: hasBridge && Boolean(workspacePath) && automationActive,
    initialDelayMs: 1500,
    task: async () => {
      await refreshProgress(workspacePath || undefined);
      return 4000;
    }
  });

  useEffect(() => {
    if (!automationActive) {
      setChatProgress(null);
    }
  }, [automationActive]);

  useEffect(() => {
    if (!hasBridge || typeof window.lithium.onAppCommand !== "function") {
      return;
    }

    return window.lithium.onAppCommand(handleAppCommand);
  }, [handleAppCommand, hasBridge]);

  useEffect(() => {
    const scrollContainer = chatScrollRef.current;

    if (!scrollContainer || !latestChatItemKey || latestChatItemKey === lastChatScrollKeyRef.current) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const distanceFromBottom =
        scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
      const shouldStickToBottom = !lastChatScrollKeyRef.current || distanceFromBottom <= 160;

      if (!shouldStickToBottom) {
        lastChatScrollKeyRef.current = latestChatItemKey;
        return;
      }

      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior: "auto"
      });
      lastChatScrollKeyRef.current = latestChatItemKey;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [latestChatItemKey]);

  async function withBusy<T>(label: string, task: () => Promise<T>) {
    const busyActionToken = busyActionTokenRef.current + 1;
    busyActionTokenRef.current = busyActionToken;
    setBusyAction(label);
    setError(null);

    try {
      return await task();
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      throw nextError;
    } finally {
      if (busyActionTokenRef.current === busyActionToken) {
        setBusyAction(null);
      }
    }
  }

  async function handlePickWorkspace() {
    if (!hasBridge || typeof window.lithium.pickWorkspace !== "function") {
      return;
    }

    await withBusy("Choosing workspace", async () => {
      const result = await window.lithium.pickWorkspace();
      await refreshAll(result.selectedWorkspacePath);
    }).catch(() => undefined);
  }

  async function handleCreateThread() {
    if (!hasBridge || !projectReady) {
      return;
    }

    await withBusy("Creating thread", async () => {
      const nextSnapshot = await window.lithium.createThread({
        workspacePath,
        title: undefined
      });
      await refreshAll(workspacePath, nextSnapshot);
    }).catch(() => undefined);
  }

  async function handleToggleFullscreen() {
    if (!hasBridge || typeof window.lithium.toggleFullscreen !== "function") {
      return;
    }

    try {
      await window.lithium.toggleFullscreen();
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function handleSelectThread(threadId: string) {
    if (!hasBridge || !workspacePath) {
      return;
    }

    await withBusy("Switching thread", async () => {
      const nextSnapshot = await window.lithium.selectThread({
        workspacePath,
        threadId
      });
      await refreshAll(workspacePath, nextSnapshot);
    }).catch(() => undefined);
  }

  async function handlePickAttachments() {
    if (
      !hasBridge ||
      !workspacePath ||
      !activeThreadId ||
      typeof window.lithium.pickAttachmentFiles !== "function"
    ) {
      return;
    }

    await withBusy("Picking attachments", async () => {
      const filePaths = await window.lithium.pickAttachmentFiles(workspacePath);

      if (!filePaths.length) {
        return;
      }

      const nextSnapshot = await window.lithium.importAttachments({
        workspacePath,
        threadId: activeThreadId,
        filePaths
      });
      await refreshAll(workspacePath, nextSnapshot);
    }).catch(() => undefined);
  }

  async function handleDropAttachments(filePaths: string[]) {
    if (!hasBridge || !workspacePath || !activeThreadId || filePaths.length === 0) {
      return;
    }

    await withBusy("Importing attachments", async () => {
      const nextSnapshot = await window.lithium.importAttachments({
        workspacePath,
        threadId: activeThreadId,
        filePaths
      });
      await refreshAll(workspacePath, nextSnapshot);
    }).catch(() => undefined);
  }

  async function handleRemoveAttachment(attachmentId: string) {
    if (!hasBridge || !workspacePath) {
      return;
    }

    await withBusy("Removing attachment", async () => {
      const nextSnapshot = await window.lithium.removeAttachment({
        workspacePath,
        attachmentId
      });
      await refreshAll(workspacePath, nextSnapshot);
    }).catch(() => undefined);
  }

  async function handleSend() {
    const prompt = composerValue.trim();

    if (!hasBridge || !prompt) {
      return;
    }

    const optimisticMessage: ChatItem = {
      id: `pending:${Date.now()}`,
      role: "user",
      body: prompt,
      timestamp: new Date().toISOString(),
      order: visibleChatItems.length
    };

    setComposerValue("");
    setPendingChatItems([optimisticMessage]);
    setPendingChatThreadId(activeThreadId ?? UNASSIGNED_PENDING_THREAD_ID);

    await withBusy("Running chat", async () => {
      const nextSnapshot = await window.lithium.sendChatMessage({
        workspacePath: workspacePath || undefined,
        threadId: activeThreadId ?? undefined,
        prompt
      });
      setPendingChatItems([]);
      setPendingChatThreadId(null);
      await refreshAll(workspacePath || undefined, nextSnapshot);
    }).catch(() => {
      setComposerValue(prompt);
      setPendingChatItems([]);
      setPendingChatThreadId(null);
    });
  }
  const canAttachFiles = Boolean(workspacePath && activeThreadId);
  const chatPlaceholder = projectReady
    ? "Ask, steer, or continue the work."
    : "Choose a folder or ask to start the work.";
  const railProjectTitle = snapshot.project?.name?.trim() || summarizeWorkspacePath(workspacePath);

  return (
    <div
      className={`workspace-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${appState?.platform ? ` platform-${appState.platform}` : ""}`}
      style={workspaceShellStyle}
    >
      <aside className={sidebarCollapsed ? "chat-sidebar collapsed" : "chat-sidebar"}>
        <div className="chat-sidebar-header">
          {railProjectTitle ? (
            <div className="chat-sidebar-project">
              <div className="chat-sidebar-project-name" title={railProjectTitle}>
                {railProjectTitle}
              </div>
            </div>
          ) : null}
        </div>
        <div className="chat-sidebar-body">
          {projectReady ? (
            snapshot.threads.length ? (
              <div className="thread-list" role="tree" aria-label="Chat list">
                {snapshot.threads.map((thread, index) => {
                  const isActive = thread.id === activeThreadId;
                  const label = formatThreadLabel(thread, index, isActive ? thread.title : undefined);

                  return (
                    <div key={thread.id} className={isActive ? "thread-row active" : "thread-row"}>
                      <button
                        className="thread-row-main"
                        onClick={() => void handleSelectThread(thread.id)}
                        type="button"
                      >
                        <span className="thread-row-title">{label}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="chat-sidebar-empty">
                <div className="chat-sidebar-empty-title">No chats yet</div>
                <div className="chat-sidebar-empty-copy">
                  Send the first message and the chat thread will appear here.
                </div>
              </div>
            )
          ) : (
            <div className="chat-sidebar-empty">
              <div className="chat-sidebar-empty-title">Main Chat</div>
              <div className="chat-sidebar-empty-copy">
                Choose a folder to start and keep the work in one chat.
              </div>
            </div>
          )}
        </div>
      </aside>
      {!sidebarCollapsed ? <div aria-hidden="true" className="sidebar-divider" /> : null}

      <main className="content-shell">
        <section className="main-shell">
          <header
            aria-hidden="true"
            className="window-drag-strip"
            onDoubleClick={() => void handleToggleFullscreen()}
          />
          <section className="chat-panel">
            <section className="chat-column">
              <div ref={chatScrollRef} className="chat-scroll">
                {error ? (
                  <article className="message system">
                    <div className="message-body plain">{error}</div>
                  </article>
                ) : null}

                {visibleChatItems.length ? (
                  <ChatFeed items={visibleChatItems} workspacePath={workspacePath} />
                ) : (
                  <div className={!projectReady ? "chat-empty-state compact" : "chat-empty-state"}>
                    <div className="chat-empty-kicker">Main Chat</div>
                    <h1 className="chat-empty-title">
                      {projectReady ? "Start the thread." : "Start with a workspace."}
                    </h1>
                    <p className="chat-empty-copy">
                      {projectReady
                        ? "Use the main chat to guide the run, inspect outputs, and keep the loop moving."
                        : "Choose a folder or send the first message to initialize the local workspace state."}
                    </p>
                    {!projectReady && hasBridge ? (
                      <div className="chat-empty-actions">
                        <button className="rail-button" onClick={() => void handlePickWorkspace()} type="button">
                          Choose Folder
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              <Composer
                allowWhileBusy={activeAutomationSession?.status === "running"}
                attachments={snapshot.activeThreadAttachments}
                busy={Boolean(busyAction)}
                canAttachFiles={canAttachFiles}
                canCreateThread={projectReady}
                canOpenWorkspace={hasBridge}
                onCreateThread={() => void handleCreateThread()}
                onDropFiles={(filePaths) => {
                  void handleDropAttachments(filePaths);
                }}
                onOpenWorkspace={() => void handlePickWorkspace()}
                onPickFiles={() => void handlePickAttachments()}
                onRemoveAttachment={(attachmentId) => {
                  void handleRemoveAttachment(attachmentId);
                }}
                onSend={() => {
                  void handleSend();
                }}
                onValueChange={setComposerValue}
                placeholder={chatPlaceholder}
                value={composerValue}
              />
            </section>
          </section>
        </section>
      </main>
    </div>
  );
}
