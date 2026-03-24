import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MobileApiClient } from "./api";
import type {
  MobileApiError,
  MobileAutoresearchSession,
  MobileBootstrap,
  MobileMessage,
  MobileResearchStatus,
  MobileThread
} from "./types";

const api = new MobileApiClient();
const POLL_INTERVAL_MS = 4_000;
const STICKY_BOTTOM_THRESHOLD_PX = 72;
const MARKDOWN_PLUGINS = [remarkGfm];

const DEFAULT_BOOTSTRAP: MobileBootstrap = {
  appName: "Lithium Mobile",
  connected: false,
  serverTime: new Date().toISOString(),
  selectedWorkspacePath: "",
  selectedThreadId: null,
  threads: [],
  messages: [],
  autoresearch: null
};

export function MobileApp() {
  const [bootstrap, setBootstrap] = useState<MobileBootstrap>(DEFAULT_BOOTSTRAP);
  const [threads, setThreads] = useState<MobileThread[]>([]);
  const [messages, setMessages] = useState<MobileMessage[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [autoresearch, setAutoresearch] = useState<MobileAutoresearchSession | null>(null);
  const [prompt, setPrompt] = useState("");
  const [objective, setObjective] = useState("");
  const [status, setStatus] = useState("Connecting");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setLastSyncAt] = useState<string>(new Date().toISOString());
  const [threadSheetOpen, setThreadSheetOpen] = useState(false);
  const [automationSheetOpen, setAutomationSheetOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const previousThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const next = await api.bootstrap(controller.signal);

        if (cancelled) {
          return;
        }

        startTransition(() => {
          applyBootstrapState(next, {
            setBootstrap,
            setThreads,
            setMessages,
            setSelectedThreadId,
            setAutoresearch,
            setObjective,
            setStatus,
            setError,
            setLastSyncAt
          });
        });
      } catch (nextError) {
        if (cancelled) {
          return;
        }

        setStatus("Offline");
        setError(toErrorMessage(nextError));
      }
    }

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  useLayoutEffect(() => {
    const textarea = composerRef.current;

    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [prompt]);

  useEffect(() => {
    const node = scrollRef.current;

    if (!node) {
      return;
    }

    const handleScroll = () => {
      shouldStickToBottomRef.current = isNearBottom(node);
    };

    handleScroll();
    node.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      node.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useLayoutEffect(() => {
    const node = scrollRef.current;

    if (!node) {
      return;
    }

    const threadChanged = previousThreadIdRef.current !== selectedThreadId;
    previousThreadIdRef.current = selectedThreadId;

    if (!threadChanged && !shouldStickToBottomRef.current) {
      return;
    }

    node.scrollTop = node.scrollHeight;
    shouldStickToBottomRef.current = true;
  }, [messages, selectedThreadId]);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads]
  );
  const canChat = Boolean(selectedThreadId ?? threads[0]?.id);
  const canPause = autoresearch?.status === "running";
  const canResume = autoresearch?.status === "paused" || autoresearch?.status === "blocked";
  const statusTone = resolveResearchTone(autoresearch?.status);
  const activityLabel = resolveActivityLabel(autoresearch, status);

  async function refresh() {
    setBusy(true);
    setError(null);

    try {
      const next = await api.bootstrap();
      startTransition(() => {
        applyBootstrapState(next, {
          setBootstrap,
          setThreads,
          setMessages,
          setSelectedThreadId,
          setAutoresearch,
          setObjective,
          setStatus,
          setError,
          setLastSyncAt
        });
      });
    } catch (nextError) {
      setStatus("Offline");
      setError(toErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function selectThread(threadId: string) {
    setBusy(true);
    setError(null);

    try {
      const next = await api.selectThread({ threadId });
      startTransition(() => {
        applyBootstrapState(next, {
          setBootstrap,
          setThreads,
          setMessages,
          setSelectedThreadId,
          setAutoresearch,
          setObjective,
          setStatus,
          setError,
          setLastSyncAt
        });
      });
      setThreadSheetOpen(false);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function createThread() {
    setBusy(true);
    setError(null);

    try {
      const next = await api.createThread({
        title: `Chat ${threads.length + 1}`
      });
      startTransition(() => {
        applyBootstrapState(next, {
          setBootstrap,
          setThreads,
          setMessages,
          setSelectedThreadId,
          setAutoresearch,
          setObjective,
          setStatus,
          setError,
          setLastSyncAt
        });
      });
      setThreadSheetOpen(false);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function sendPrompt() {
    const text = prompt.trim();
    const threadId = selectedThreadId ?? threads[0]?.id ?? null;

    if (!text || !threadId) {
      return;
    }

    setBusy(true);
    setError(null);

    const optimisticMessage: MobileMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
      status: "sending"
    };

    shouldStickToBottomRef.current = true;
    setMessages((current) => [...current, optimisticMessage]);
    setPrompt("");

    try {
      const nextMessages = await api.sendChat({
        threadId,
        prompt: text
      });

      startTransition(() => {
        setMessages(nextMessages);
        setStatus("Connected");
      });

      await refresh();
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      setMessages((current) =>
        current.map((message) =>
          message.id === optimisticMessage.id
            ? {
                ...message,
                status: "error"
              }
            : message
        )
      );
    } finally {
      setBusy(false);
    }
  }

  async function startAutoresearch() {
    const threadId = selectedThreadId ?? threads[0]?.id ?? null;
    const nextObjective = objective.trim();

    if (!nextObjective) {
      setError("Autoresearch objective is empty.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const next = await api.startAutoresearch({
        threadId: threadId ?? undefined,
        objective: nextObjective
      });
      startTransition(() => {
        applyBootstrapState(next, {
          setBootstrap,
          setThreads,
          setMessages,
          setSelectedThreadId,
          setAutoresearch,
          setObjective,
          setStatus,
          setError,
          setLastSyncAt
        });
      });
      setAutomationSheetOpen(false);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function controlAutoresearch(action: "pause" | "resume" | "interrupt") {
    if (!autoresearch?.id) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const request = { sessionId: autoresearch.id };
      const next =
        action === "pause"
          ? await api.pauseAutoresearch(request)
          : action === "resume"
            ? await api.resumeAutoresearch(request)
            : await api.interruptAutoresearch(request);

      startTransition(() => {
        applyBootstrapState(next, {
          setBootstrap,
          setThreads,
          setMessages,
          setSelectedThreadId,
          setAutoresearch,
          setObjective,
          setStatus,
          setError,
          setLastSyncAt
        });
      });

      if (action !== "pause") {
        setAutomationSheetOpen(false);
      }
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mobile-app-shell">
      <div className="mobile-app-frame">
        <header className="mobile-topbar">
          <button
            aria-label="Open chats"
            className="icon-button"
            onClick={() => setThreadSheetOpen(true)}
            type="button"
          >
            <MenuIcon />
          </button>

          <div className="topbar-center">
            <div className="topbar-status-row">
              <span className="topbar-badge">
                {bootstrap.appName.replace(/\s+Mobile$/i, "") || "Lithium"}
              </span>
              <button
                className={`topbar-activity ${statusTone}`}
                onClick={() => setAutomationSheetOpen(true)}
                type="button"
              >
                {activityLabel}
              </button>
            </div>
            <div className="topbar-title">
              {activeThread?.title || "New chat"}
            </div>
          </div>

          <div className="topbar-actions">
            <button
              aria-label="Autoresearch"
              className="icon-button"
              onClick={() => setAutomationSheetOpen(true)}
              type="button"
            >
              <SparkIcon />
            </button>
            <button
              aria-label="Refresh"
              className="icon-button"
              disabled={busy}
              onClick={() => {
                void refresh();
              }}
              type="button"
            >
              <MoreIcon />
            </button>
          </div>
        </header>

        {error ? <div className="status-banner error">{error}</div> : null}
        {!error && !bootstrap.connected ? (
          <div className="status-banner muted">Trying to reach the local Lithium bridge.</div>
        ) : null}

        <main ref={scrollRef} className="chat-scroll-shell">
          <div className="chat-list">
            {messages.length ? (
              messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))
            ) : (
              <div className="empty-chat">
                <div className="empty-chat-title">Start a new conversation</div>
                <div className="empty-chat-copy">
                  Open the chat list, pick a thread, then send a prompt from here.
                </div>
              </div>
            )}
          </div>
        </main>

        <footer className="composer-shell">
          <button
            aria-label="Open chats"
            className="composer-side-button"
            onClick={() => setThreadSheetOpen(true)}
            type="button"
          >
            <PlusIcon />
          </button>

          <form
            className="composer-form"
            onSubmit={(event) => {
              event.preventDefault();
              void sendPrompt();
            }}
          >
            <textarea
              ref={composerRef}
              className="composer-input"
              disabled={!canChat || busy}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={canChat ? "Lithium에게 메시지 보내기" : "먼저 채팅을 선택하세요"}
              rows={1}
              value={prompt}
            />
            <button
              aria-label="Send"
              className="composer-send"
              disabled={!canChat || busy || !prompt.trim()}
              type="submit"
            >
              <SendIcon />
            </button>
          </form>
        </footer>

      </div>

      {threadSheetOpen ? (
        <SheetBackdrop onClose={() => setThreadSheetOpen(false)}>
          <aside className="thread-sheet" role="dialog" aria-label="Chats">
            <div className="sheet-header">
              <div>
                <div className="sheet-kicker">Chats</div>
                <div className="sheet-title">Current workspace</div>
              </div>
              <button
                aria-label="Close chats"
                className="icon-button"
                onClick={() => setThreadSheetOpen(false)}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>

            <div className="sheet-path">
              {bootstrap.selectedWorkspacePath || "No workspace selected"}
            </div>

            <div className="thread-sheet-list">
              {threads.map((thread) => {
                const active = thread.id === selectedThreadId;

                return (
                  <button
                    key={thread.id}
                    className={active ? "thread-row active" : "thread-row"}
                    disabled={busy}
                    onClick={() => {
                      void selectThread(thread.id);
                    }}
                    type="button"
                  >
                    <span className="thread-row-title">{thread.title}</span>
                    <span className="thread-row-meta">
                      {thread.lastActivityAt ? formatRelativeTime(thread.lastActivityAt) : ""}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="sheet-actions">
              <button
                className="sheet-button primary"
                disabled={busy}
                onClick={() => {
                  void createThread();
                }}
                type="button"
              >
                New chat
              </button>
              <button
                className="sheet-button"
                disabled={busy}
                onClick={() => {
                  void refresh();
                }}
                type="button"
              >
                Sync
              </button>
            </div>
          </aside>
        </SheetBackdrop>
      ) : null}

      {automationSheetOpen ? (
        <SheetBackdrop onClose={() => setAutomationSheetOpen(false)}>
          <section className="automation-sheet" role="dialog" aria-label="Autoresearch controls">
            <div className="sheet-header">
              <div>
                <div className="sheet-kicker">Autoresearch</div>
                <div className="sheet-title">{autoresearch?.status ?? "idle"}</div>
              </div>
              <button
                aria-label="Close autoresearch"
                className="icon-button"
                onClick={() => setAutomationSheetOpen(false)}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>

            <label className="sheet-field">
              <span className="sheet-label">Objective</span>
              <textarea
                onChange={(event) => setObjective(event.target.value)}
                rows={4}
                value={objective}
              />
            </label>

            <div className="automation-summary">
              <div className="automation-summary-label">Current step</div>
              <div className="automation-summary-body">
                {autoresearch?.currentStep || "No active autoresearch step yet."}
              </div>
            </div>

            {autoresearch?.nextActions.length ? (
              <div className="automation-summary">
                <div className="automation-summary-label">Next actions</div>
                <ul className="automation-list">
                  {autoresearch.nextActions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="sheet-actions">
              <button
                className="sheet-button primary"
                disabled={busy || !objective.trim()}
                onClick={() => {
                  void startAutoresearch();
                }}
                type="button"
              >
                Start
              </button>
              <button
                className="sheet-button"
                disabled={busy || !canPause}
                onClick={() => {
                  void controlAutoresearch("pause");
                }}
                type="button"
              >
                Pause
              </button>
              <button
                className="sheet-button"
                disabled={busy || !canResume}
                onClick={() => {
                  void controlAutoresearch("resume");
                }}
                type="button"
              >
                Resume
              </button>
              <button
                className="sheet-button destructive"
                disabled={busy || !autoresearch}
                onClick={() => {
                  void controlAutoresearch("interrupt");
                }}
                type="button"
              >
                Stop
              </button>
            </div>
          </section>
        </SheetBackdrop>
      ) : null}
    </div>
  );
}

function isNearBottom(node: HTMLDivElement) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= STICKY_BOTTOM_THRESHOLD_PX;
}

function ChatMessage({ message }: { message: MobileMessage }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  return (
    <article className={isUser ? "message-row user" : "message-row assistant"}>
      {isUser ? (
        <div className="user-bubble">
          <div className="user-bubble-copy">{message.content}</div>
        </div>
      ) : (
        <div className={isSystem ? "assistant-copy system" : "assistant-copy"}>
          <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
            {message.content}
          </ReactMarkdown>
        </div>
      )}

      <div className="message-meta">
        <span>{formatRelativeTime(message.createdAt)}</span>
        {message.status && message.status !== "done" ? (
          <span className={`message-status ${message.status}`}>{message.status}</span>
        ) : null}
      </div>
    </article>
  );
}

function SheetBackdrop({
  children,
  onClose
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      {children}
    </div>
  );
}

function applyBootstrapState(
  next: MobileBootstrap,
  setters: {
    setBootstrap: (value: MobileBootstrap) => void;
    setThreads: (value: MobileThread[]) => void;
    setMessages: (value: MobileMessage[]) => void;
    setSelectedThreadId: (value: string | null) => void;
    setAutoresearch: (value: MobileAutoresearchSession | null) => void;
    setObjective: React.Dispatch<React.SetStateAction<string>>;
    setStatus: (value: string) => void;
    setError: (value: string | null) => void;
    setLastSyncAt: (value: string) => void;
  }
) {
  setters.setBootstrap(next);
  setters.setThreads(next.threads);
  setters.setMessages(next.messages);
  setters.setSelectedThreadId(next.selectedThreadId);
  setters.setAutoresearch(next.autoresearch);
  setters.setObjective((current) => next.autoresearch?.objective ?? current);
  setters.setStatus(next.connected ? "Connected" : "API not connected");
  setters.setError(null);
  setters.setLastSyncAt(next.serverTime);
}

function resolveActivityLabel(
  autoresearch: MobileAutoresearchSession | null,
  connectionStatus: string
) {
  if (autoresearch?.status === "running") {
    return "Autoresearch";
  }

  if (autoresearch?.status === "paused" || autoresearch?.status === "blocked") {
    return "Paused";
  }

  if (autoresearch?.status === "failed") {
    return "Needs review";
  }

  if (!autoresearch) {
    return connectionStatus === "Offline" ? "Offline" : "Ready";
  }

  return "Ready";
}

function resolveResearchTone(status?: MobileResearchStatus | null) {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    default:
      return "idle";
  }
}

function formatRelativeTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "just now";
  }

  const diffSeconds = Math.max(1, Math.round((Date.now() - date.getTime()) / 1000));

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.round(diffSeconds / 60);

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);

  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  return `${Math.round(diffHours / 24)}d ago`;
}

function toErrorMessage(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as MobileApiError).message === "string"
  ) {
    return (error as MobileApiError).message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function MenuIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M4 7h16M4 12h12M4 17h16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M20 4 10 14M20 4l-6 16-4-6-6-4 16-6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="m6 6 12 12M18 6 6 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}
