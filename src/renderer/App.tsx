import {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { DEFAULT_APP_SETTINGS } from "../shared/types";
import type {
  BuilderRunInspection,
  ChatProgressInspection,
  ProjectSnapshot,
  RuntimeAppState,
  StrategistBrowserProbeResponse,
  ThreadRecord,
  WorkspaceFileRecord
} from "../shared/types";
import {
  type ChatItem,
  type DrawerTab,
  type MemoryDraft,
  type PaperPreviewJump,
  type ResizeTarget,
  type SurfaceMode,
  emptyMemoryDraft,
  emptyThreadMemoryDraft,
  emptySnapshot
} from "./app-types";
import {
  buildChatItems,
  buildExplorerRows,
  selectPreferredCodePath,
  clamp,
  formatLiveProgressBody,
  formatPaperLabel,
  formatThreadLabel,
  normalizePath,
  resolveAutomationCheckpointTone,
  resolveInitialSurface,
  resolvePdfPreviewPath,
  resolveThreadTitle,
  resolveWorkspaceSurfaceTitle,
  selectPaperWorkbenchFiles,
  selectPreferredPaperPath,
  sortCodeExplorerFiles,
  sortPaperExplorerFiles,
  toErrorMessage,
  toLines,
  toMemoryDraft
} from "./app-utils";
import { ArtifactInspector } from "./ArtifactInspector";
import { ChatFeed } from "./ChatFeed";
import { CodeWorkbench } from "./CodeWorkbench";
import { Composer } from "./Composer";
import { ContextWorkbench } from "./ContextWorkbench";
import { OnboardingPanel } from "./OnboardingPanel";
import { PaperWorkbench } from "./PaperWorkbench";
import { SettingsPanel } from "./SettingsPanel";
import {
  canSubmitComposerPrompt,
  describeBusyChatState,
  UNASSIGNED_PENDING_THREAD_ID,
  isPendingChatVisible,
  promptRequestsCodeSurface,
  promptRequestsPaperSurface,
  resolveAutomationObjective,
  resolveLatestTaskPrompt,
  shouldAutoOpenCodeSurface,
  shouldAutoOpenPaperSurface
} from "./chat-surface";
import { useAppPreferences } from "./useAppPreferences";
import { useCodeWorkbenchState } from "./useCodeWorkbenchState";
import { TERMINAL_FEATURE_ENABLED, WORKBENCH_SURFACES_ENABLED } from "../shared/feature-flags";

const INITIAL_SURFACE = resolveInitialSurface();
const THREAD_MENU_WIDTH = 168;
const INITIAL_DRAWER_TAB: DrawerTab =
  INITIAL_SURFACE === "chat" ? "none" : !WORKBENCH_SURFACES_ENABLED && INITIAL_SURFACE === "paper" ? "none" : INITIAL_SURFACE;

export default function App() {
  const [appState, setAppState] = useState<RuntimeAppState | null>(null);
  const [snapshot, setSnapshot] = useState<ProjectSnapshot>(emptySnapshot);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileRecord[]>([]);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>(INITIAL_DRAWER_TAB);
  const [codeCanvasOpen, setCodeCanvasOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [composerValue, setComposerValue] = useState("");
  const [pendingChatItems, setPendingChatItems] = useState<ChatItem[]>([]);
  const [pendingChatThreadId, setPendingChatThreadId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft>(emptyMemoryDraft);
  const [threadMemoryDraft, setThreadMemoryDraft] = useState(emptyThreadMemoryDraft);
  const [contextBundlePreview, setContextBundlePreview] = useState("");
  const [selectedPaperPath, setSelectedPaperPath] = useState("");
  const [paperDraft, setPaperDraft] = useState("");
  const [paperDirty, setPaperDirty] = useState(false);
  const [paperFocusLine, setPaperFocusLine] = useState<number | undefined>(undefined);
  const [paperPreviewJump, setPaperPreviewJump] = useState<PaperPreviewJump | null>(null);
  const [pdfPreviewBytes, setPdfPreviewBytes] = useState<Uint8Array | null>(null);
  const [pdfPreviewVersion, setPdfPreviewVersion] = useState(0);
  const [builderInspection, setBuilderInspection] = useState<BuilderRunInspection | null>(null);
  const [chatProgress, setChatProgress] = useState<ChatProgressInspection | null>(null);
  const [strategistProbeResult, setStrategistProbeResult] = useState<StrategistBrowserProbeResponse | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_APP_SETTINGS.sidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [threadMenuOpenId, setThreadMenuOpenId] = useState<string | null>(null);
  const [threadMenuPosition, setThreadMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [codeCanvasWidth, setCodeCanvasWidth] = useState(DEFAULT_APP_SETTINGS.codeCanvasWidth);
  const [paperPreviewWidth, setPaperPreviewWidth] = useState(DEFAULT_APP_SETTINGS.paperPreviewWidth);
  const [resizeTarget, setResizeTarget] = useState<ResizeTarget>(null);
  const [inspectorPath, setInspectorPath] = useState("");
  const [threadSeenState, setThreadSeenState] = useState<Record<string, string>>({});
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastChatScrollKeyRef = useRef("");
  const paperDraftRef = useRef("");
  const paperDirtyRef = useRef(false);
  const paperLoadRequestRef = useRef(0);
  const sidebarWidthRef = useRef(DEFAULT_APP_SETTINGS.sidebarWidth);
  const hasBridge =
    typeof window !== "undefined" &&
    typeof window.lithium !== "undefined" &&
    typeof window.lithium.getAppState === "function";

  const workspacePath = appState?.selectedWorkspacePath ?? "";
  const projectReady = Boolean(snapshot.project);
  const surfaceTitle = resolveWorkspaceSurfaceTitle(snapshot.project?.name, appState);
  const canUseChatRouter = Boolean(hasBridge && typeof window.lithium.sendChatMessage === "function");
  const surfaceMode: SurfaceMode =
    drawerTab === "none" || (!WORKBENCH_SURFACES_ENABLED && drawerTab === "paper") ? "chat" : drawerTab;
  const activeThreadId = snapshot.activeThreadId ?? snapshot.threads[0]?.id ?? null;
  const {
    appSettings,
    closeSettings,
    dismissOnboarding,
    onboardingVisible,
    openSettings,
    reopenOnboarding,
    resolvedTheme,
    settingsOpen,
    updateAppSettings
  } = useAppPreferences({
    appState,
    hasBridge,
    setAppState
  });

  const codeFiles = useMemo(
    () => workspaceFiles.filter((file) => file.kind === "code"),
    [workspaceFiles]
  );
  const paperFiles = useMemo(
    () => workspaceFiles.filter((file) => file.kind === "paper"),
    [workspaceFiles]
  );
  const paperWorkbenchFiles = useMemo(
    () => selectPaperWorkbenchFiles(paperFiles),
    [paperFiles]
  );
  const chatItems = useMemo(
    () => buildChatItems(snapshot, workspaceFiles, workspacePath, builderInspection),
    [builderInspection, snapshot, workspaceFiles, workspacePath]
  );
  const visiblePendingChatItems = useMemo(
    () => (isPendingChatVisible(pendingChatThreadId, activeThreadId) ? pendingChatItems : []),
    [activeThreadId, pendingChatItems, pendingChatThreadId]
  );
  const visibleChatItems = useMemo(() => {
    const items = [...chatItems, ...visiblePendingChatItems];
    const liveProgressBody = formatLiveProgressBody(chatProgress);

    if (busyAction && visiblePendingChatItems.length) {
      items.push({
        id: `busy:${busyAction}:${visiblePendingChatItems[0]?.id ?? "chat"}`,
        role: "assistant",
        variant: "neutral",
        title: "Lithium",
        body: liveProgressBody || describeBusyChatState(busyAction),
        timestamp: new Date().toISOString(),
        order: items.length,
        pending: true
      });
    } else if (chatProgress?.active && liveProgressBody) {
      items.push({
        id: `live-progress:${workspacePath || activeThreadId || "chat"}:${chatProgress.lane}`,
        role: "assistant",
        variant: "neutral",
        title: "Lithium",
        body: liveProgressBody,
        timestamp: chatProgress.updatedAt,
        order: items.length,
        pending: true
      });
    }

    return items;
  }, [activeThreadId, busyAction, chatItems, chatProgress, visiblePendingChatItems, workspacePath]);
  const pdfPreviewPath = useMemo(
    () => resolvePdfPreviewPath(selectedPaperPath, paperWorkbenchFiles),
    [paperWorkbenchFiles, selectedPaperPath]
  );
  const threadTitle = useMemo(() => resolveThreadTitle(snapshot), [snapshot]);
  const latestChatItemKey = visibleChatItems[visibleChatItems.length - 1]?.id ?? "";
  const changedFiles = useMemo(
    () => builderInspection?.changedFiles ?? snapshot.latestRun?.changedFiles ?? [],
    [builderInspection?.changedFiles, snapshot.latestRun?.changedFiles]
  );
  const codeExplorerFiles = useMemo(
    () => sortCodeExplorerFiles(codeFiles),
    [codeFiles]
  );
  const paperExplorerFiles = useMemo(
    () => sortPaperExplorerFiles(paperWorkbenchFiles),
    [paperWorkbenchFiles]
  );
  const visiblePaperFiles = useMemo(
    () => paperExplorerFiles.filter((file) => !normalizePath(file.relativePath).toLowerCase().endsWith(".pdf")),
    [paperExplorerFiles]
  );
  const {
    activeCodeTab,
    codeTabs,
    collapsedCodeFolders,
    createUntitledCodeTab,
    handleCloseCodeTab,
    handleSaveCode,
    openCodeFile,
    resetCodeWorkbench,
    selectedCodePath,
    setSelectedCodePath,
    toggleCodeFolder,
    updateCodeDraft
  } = useCodeWorkbenchState({
    enabled: WORKBENCH_SURFACES_ENABLED,
    changedFiles,
    codeExplorerFiles,
    codeFiles,
    onOpenCanvas: () => setCodeCanvasOpen(true),
    onRefreshWorkspace: refreshWorkspace,
    onReportError: setError,
    onRequestWorkspace: async () => await requestWorkspaceForUnsavedFile(),
    withBusy,
    workspacePath
  });
  const codeExplorerRows = useMemo(
    () => buildExplorerRows(codeExplorerFiles, changedFiles, collapsedCodeFolders),
    [changedFiles, codeExplorerFiles, collapsedCodeFolders]
  );
  const paperSurfaceStyle = useMemo<CSSProperties>(
    () => ({ ["--paper-preview-width" as string]: `${paperPreviewWidth}px` }),
    [paperPreviewWidth]
  );
  const workspaceShellStyle = useMemo<CSSProperties>(
    () => ({ ["--sidebar-width" as string]: `${sidebarCollapsed ? 0 : sidebarWidth}px` }),
    [sidebarCollapsed, sidebarWidth]
  );
  const codeWorkbenchStyle = useMemo<CSSProperties>(
    () => ({ ["--code-canvas-width" as string]: `${codeCanvasWidth}px` }),
    [codeCanvasWidth]
  );
  const codeDraft = activeCodeTab?.draft ?? "";
  const codeDirty = activeCodeTab?.dirty ?? false;
  const selectedPaperFile = useMemo(
    () => paperExplorerFiles.find((file) => file.path === selectedPaperPath) ?? null,
    [paperExplorerFiles, selectedPaperPath]
  );
  const paperTitle = useMemo(
    () => (selectedPaperFile ? formatPaperLabel(selectedPaperFile.relativePath) : "Manuscript"),
    [selectedPaperFile]
  );
  const selectedInspectorFile = useMemo(
    () => workspaceFiles.find((file) => file.path === inspectorPath) ?? null,
    [inspectorPath, workspaceFiles]
  );
  const latestAutomationSession =
    snapshot.latestAutomationSession?.threadId === activeThreadId
      ? snapshot.latestAutomationSession
      : null;
  const latestAutomationCheckpoint =
    snapshot.latestAutomationCheckpoint?.threadId === activeThreadId
      ? snapshot.latestAutomationCheckpoint
      : null;
  const automationStatus = latestAutomationSession?.status ?? "idle";
  const automationCheckpointPending = Boolean(
    latestAutomationSession &&
      latestAutomationCheckpoint &&
      latestAutomationSession.latestCheckpointId === latestAutomationCheckpoint.id &&
      latestAutomationCheckpoint.status === "pending"
  );
  const automationObjective = resolveAutomationObjective(snapshot);
  const inspectorOpen = WORKBENCH_SURFACES_ENABLED && Boolean(selectedInspectorFile);
  const automationRunning = automationStatus === "running";
  const automationInteractive = automationRunning || automationCheckpointPending;
  const composerStartsAutomation = !automationInteractive;
  const automationCheckpointTone =
    automationCheckpointPending && latestAutomationCheckpoint
      ? resolveAutomationCheckpointTone(latestAutomationCheckpoint, latestAutomationSession ?? undefined)
      : undefined;
  const showAutomationHeaderAction = automationRunning || automationCheckpointPending;
  const terminalOpen = WORKBENCH_SURFACES_ENABLED && TERMINAL_FEATURE_ENABLED && logsOpen;
  const composerPlaceholder = automationRunning
    ? "Ask for status or steer the next step."
    : automationCheckpointPending && automationCheckpointTone === "blocked"
    ? "Resolve the strategist blocker and say what autopilot should do next."
    : automationCheckpointPending && automationCheckpointTone === "failed"
    ? "Review the failure and say what autopilot should do next."
    : automationCheckpointPending
    ? "Reply to resume or redirect autopilot."
    : "Ask, steer, or inspect.";
  const railHeading = resolveRailHeading();

  const handleAppCommand = useEffectEvent((command: string) => {
    if (command === "open-workspace") {
      void handlePickWorkspace();
      return;
    }

    if (command === "open-new-thread") {
      void handleCreateThread();
      return;
    }

    if (command === "new-code-file") {
      void handleNewCodeFile();
      return;
    }

    if (command === "toggle-sidebar") {
      handleToggleSidebar();
      return;
    }

    if (command === "toggle-terminal") {
      if (TERMINAL_FEATURE_ENABLED) {
        handleToggleTerminal();
      }
      return;
    }

    if (command === "open-settings") {
      openSettings();
      return;
    }

    if (command === "save-current-surface") {
      void handleSaveCurrentSurface();
    }
  });

  useEffect(() => {
    if (!pendingChatItems.length || !isPendingChatVisible(pendingChatThreadId, activeThreadId)) {
      return;
    }

    const pendingBodies = new Set(
      pendingChatItems
        .map((item) => item.body.trim())
        .filter(Boolean)
    );

    const hasPersistedMatch = chatItems.some(
      (item) => item.role === "user" && pendingBodies.has(item.body.trim())
    );

    if (hasPersistedMatch) {
      setPendingChatItems([]);
      setPendingChatThreadId(null);
    }
  }, [activeThreadId, chatItems, pendingChatItems, pendingChatThreadId]);

  useEffect(() => {
    if (!pendingChatThreadId) {
      return;
    }

    if (pendingChatThreadId === UNASSIGNED_PENDING_THREAD_ID && activeThreadId) {
      setPendingChatThreadId(activeThreadId);
      return;
    }

    const threadStillExists = snapshot.threads.some((thread) => thread.id === pendingChatThreadId);

    if (!threadStillExists && pendingChatThreadId !== UNASSIGNED_PENDING_THREAD_ID) {
      setPendingChatItems([]);
      setPendingChatThreadId(null);
    }
  }, [activeThreadId, pendingChatThreadId, snapshot.threads]);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!workspacePath || typeof window === "undefined") {
      setThreadSeenState({});
      return;
    }

    const storageKey = buildThreadSeenStorageKey(workspacePath);

    try {
      const raw = window.localStorage.getItem(storageKey);

      if (!raw) {
        const seeded = Object.fromEntries(
          snapshot.threads.map((thread) => [thread.id, thread.updatedAt] as const)
        );
        setThreadSeenState(seeded);
        return;
      }

      const parsed = JSON.parse(raw) as Record<string, string>;
      const merged = { ...parsed };

      for (const thread of snapshot.threads) {
        if (!merged[thread.id]) {
          merged[thread.id] = thread.updatedAt;
        }
      }

      setThreadSeenState(merged);
    } catch {
      const fallback = Object.fromEntries(
        snapshot.threads.map((thread) => [thread.id, thread.updatedAt] as const)
      );
      setThreadSeenState(fallback);
    }
  }, [workspacePath, snapshot.project?.id]);

  useEffect(() => {
    if (!workspacePath || typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(buildThreadSeenStorageKey(workspacePath), JSON.stringify(threadSeenState));
    } catch {
      // ignore local persistence failures
    }
  }, [threadSeenState, workspacePath]);

  useEffect(() => {
    if (!workspacePath || !snapshot.threads.length) {
      return;
    }

    setThreadSeenState((current) => {
      let changed = false;
      const next = { ...current };

      for (const thread of snapshot.threads) {
        if (!next[thread.id]) {
          next[thread.id] = thread.updatedAt;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [snapshot.threads, workspacePath]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    document.title = surfaceTitle === "Lithium" ? "Lithium" : `${surfaceTitle} · Lithium`;
  }, [surfaceTitle]);

  useEffect(() => {
    const activeThread = snapshot.activeThread;

    if (!workspacePath || !activeThread) {
      return;
    }

    setThreadSeenState((current) => {
      if ((current[activeThread.id] ?? "") === activeThread.updatedAt) {
        return current;
      }

      return {
        ...current,
        [activeThread.id]: activeThread.updatedAt
      };
    });
  }, [snapshot.activeThread?.id, snapshot.activeThread?.updatedAt, workspacePath]);

  useEffect(() => {
    if (surfaceMode !== "chat" || !latestChatItemKey) {
      return;
    }

    const scrollContainer = chatScrollRef.current;

    if (!scrollContainer) {
      return;
    }

    const behavior: ScrollBehavior = lastChatScrollKeyRef.current ? "smooth" : "auto";

    const frameId = window.requestAnimationFrame(() => {
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior
      });
      lastChatScrollKeyRef.current = latestChatItemKey;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [latestChatItemKey, surfaceMode]);

  useEffect(() => {
    lastChatScrollKeyRef.current = "";
  }, [snapshot.activeThreadId]);

  useEffect(() => {
    if (!appState) {
      return;
    }

    setSidebarWidth(clamp(appSettings.sidebarWidth, 180, 320));
  }, [appSettings.sidebarWidth, appState]);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (!appState) {
      return;
    }

    setCodeCanvasWidth(clamp(appSettings.codeCanvasWidth, 320, 960));
  }, [appSettings.codeCanvasWidth, appState]);

  useEffect(() => {
    if (!appState) {
      return;
    }

    setPaperPreviewWidth(clamp(appSettings.paperPreviewWidth, 420, 1280));
  }, [appSettings.paperPreviewWidth, appState]);

  useEffect(() => {
    setThreadMenuOpenId(null);
    setThreadMenuPosition(null);
  }, [sidebarCollapsed, snapshot.activeThreadId, surfaceMode]);

  useEffect(() => {
    if (!threadMenuOpenId) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      if (event.target.closest(".thread-row-meta-shell")) {
        return;
      }

      if (event.target.closest(".thread-row-menu-popover")) {
        return;
      }

      setThreadMenuOpenId(null);
      setThreadMenuPosition(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setThreadMenuOpenId(null);
        setThreadMenuPosition(null);
      }
    };

    const handleViewportChange = () => {
      setThreadMenuOpenId(null);
      setThreadMenuPosition(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [threadMenuOpenId]);

  useEffect(() => {
    if (!hasBridge) {
      return;
    }

    return window.lithium.onAppCommand((command) => {
      handleAppCommand(command as string);
    });
  }, [hasBridge]);

  useEffect(() => {
    if (!workspacePath) {
      setWorkspaceFiles([]);
      return;
    }

    void loadWorkspaceFiles(workspacePath);
  }, [workspacePath]);

  useEffect(() => {
    if (!WORKBENCH_SURFACES_ENABLED) {
      setSelectedPaperPath("");
      setPaperFocusLine(undefined);
      return;
    }

    if (!selectedPaperPath || !paperWorkbenchFiles.some((file) => file.path === selectedPaperPath)) {
      setSelectedPaperPath(selectPreferredPaperPath(paperExplorerFiles, Boolean(snapshot.latestRun)));
      setPaperFocusLine(undefined);
    }
  }, [paperExplorerFiles, paperWorkbenchFiles, selectedPaperPath, snapshot.latestRun]);

  useEffect(() => {
    setMemoryDraft(toMemoryDraft(snapshot.memory));
  }, [snapshot.memory?.updatedAt, snapshot.project?.id]);

  useEffect(() => {
    setThreadMemoryDraft({
      memory: snapshot.activeThread?.memory ?? ""
    });
  }, [snapshot.activeThread?.id, snapshot.activeThread?.memory, snapshot.activeThread?.updatedAt]);

  useEffect(() => {
    paperDirtyRef.current = paperDirty;
  }, [paperDirty]);

  useEffect(() => {
    if (!WORKBENCH_SURFACES_ENABLED) {
      paperLoadRequestRef.current += 1;
      setPaperDraft("");
      paperDraftRef.current = "";
      setPaperDirty(false);
      return;
    }

    if (!workspacePath || !selectedPaperPath) {
      paperLoadRequestRef.current += 1;
      setPaperDraft("");
      paperDraftRef.current = "";
      setPaperDirty(false);
      return;
    }

    let cancelled = false;
    const requestId = paperLoadRequestRef.current + 1;
    paperLoadRequestRef.current = requestId;

    void window.lithium
      .readWorkspaceFile({ workspacePath, path: selectedPaperPath })
      .then((file) => {
        if (!cancelled && paperLoadRequestRef.current === requestId && !paperDirtyRef.current) {
          setPaperDraft(file.content);
          paperDraftRef.current = file.content;
          setPaperDirty(false);
        }
      })
      .catch((nextError: unknown) => {
        if (!cancelled && paperLoadRequestRef.current === requestId) {
          setError(toErrorMessage(nextError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPaperPath, workspacePath]);

  useEffect(() => {
    if (!WORKBENCH_SURFACES_ENABLED) {
      setPdfPreviewBytes(null);
      return;
    }

    if (surfaceMode !== "paper" || !workspacePath || !pdfPreviewPath) {
      setPdfPreviewBytes(null);
      return;
    }

    let cancelled = false;

    void window.lithium
      .readWorkspaceFileBytes({ workspacePath, path: pdfPreviewPath })
      .then((bytes) => {
        if (!cancelled) {
          setPdfPreviewBytes(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        }
      })
      .catch((nextError: unknown) => {
        if (!cancelled) {
          setPdfPreviewBytes(null);
          setError(toErrorMessage(nextError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    pdfPreviewPath,
    pdfPreviewVersion,
    surfaceMode,
    workspacePath
  ]);

  useEffect(() => {
    if (!workspacePath || !snapshot.latestRun) {
      setBuilderInspection(null);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const poll = async () => {
      try {
        const inspection = await window.lithium.inspectBuilderRun({
          workspacePath,
          runId: snapshot.latestRun?.id
        });

        if (cancelled || !inspection) {
          return;
        }

        setBuilderInspection(inspection);

        const finalized =
          inspection.run?.status !== snapshot.latestRun?.status ||
          inspection.run?.finalization !== snapshot.latestRun?.finalization;

        if (finalized) {
          await refreshWorkspace(workspacePath);
        }

        if (inspection.active || inspection.suggestedStatus !== "idle") {
          timer = window.setTimeout(() => {
            void poll();
          }, 900);
        }
      } catch {
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void poll();
          }, 2_000);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [
    snapshot.latestRun?.finalization,
    snapshot.latestRun?.id,
    snapshot.latestRun?.status,
    workspacePath
  ]);

  useEffect(() => {
    if (
      !hasBridge ||
      ((!busyAction || !pendingChatItems.length) && !automationRunning) ||
      typeof window.lithium.inspectChatProgress !== "function"
    ) {
      setChatProgress(null);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const poll = async () => {
      try {
        const inspection = await window.lithium.inspectChatProgress({
          workspacePath: workspacePath || undefined
        });

        if (cancelled) {
          return;
        }

        setChatProgress(inspection);

        if (inspection?.active || !inspection) {
          timer = window.setTimeout(() => {
            void poll();
          }, 700);
        }
      } catch {
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void poll();
          }, 1_200);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [automationRunning, busyAction, hasBridge, pendingChatItems.length, workspacePath]);

  useEffect(() => {
    if (
      !workspacePath ||
      !latestAutomationSession ||
      !automationRunning
    ) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const poll = async () => {
      try {
        await refreshProjectSnapshot(workspacePath);

        if (cancelled) {
          return;
        }

        timer = window.setTimeout(() => {
          void poll();
        }, 1400);
      } catch {
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void poll();
          }, 2200);
        }
      }
    };

    timer = window.setTimeout(() => {
      void poll();
    }, 1200);

    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [automationRunning, latestAutomationSession?.id, workspacePath]);

  useEffect(() => {
    if (!workspacePath) {
      setContextBundlePreview("");
      return;
    }

    if (surfaceMode !== "memory") {
      return;
    }

    let cancelled = false;

    void window.lithium
      .readWorkspaceFile({ workspacePath, path: ".lithium/context/current-context.md" })
      .then((file) => {
        if (!cancelled) {
          setContextBundlePreview(file.content);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContextBundlePreview("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    surfaceMode,
    snapshot.activeThread?.id,
    snapshot.activeThread?.updatedAt,
    snapshot.latestDecision?.id,
    snapshot.latestRun?.id,
    snapshot.memory?.updatedAt,
    workspacePath
  ]);

  useEffect(() => {
    if (!resizeTarget) {
      return;
    }

    let resizeFrame: number | null = null;
    let pendingEvent: MouseEvent | null = null;

    const applyResize = (event: MouseEvent) => {
      if (resizeTarget === "sidebar") {
        setSidebarWidth(clamp(event.clientX, 180, 320));
        return;
      }

      if (resizeTarget === "code-canvas") {
        const maxWidth = Math.max(320, window.innerWidth - sidebarWidthRef.current - 320);
        setCodeCanvasWidth(clamp(window.innerWidth - event.clientX, 320, maxWidth));
        return;
      }

      if (resizeTarget === "paper-preview") {
        const maxWidth = Math.max(460, window.innerWidth - sidebarWidthRef.current - 360);
        setPaperPreviewWidth(clamp(window.innerWidth - event.clientX, 420, maxWidth));
      }
    };

    const handlePointerMove = (event: MouseEvent) => {
      pendingEvent = event;

      if (resizeFrame != null) {
        return;
      }

      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;

        if (pendingEvent) {
          applyResize(pendingEvent);
          pendingEvent = null;
        }
      });
    };

    const handlePointerUp = () => {
      if (resizeFrame != null) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }

      if (pendingEvent) {
        applyResize(pendingEvent);
        pendingEvent = null;
      }

      setResizeTarget(null);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);

    return () => {
      if (resizeFrame != null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
    };
  }, [resizeTarget]);

  useEffect(() => {
    if (!appState || resizeTarget === "sidebar") {
      return;
    }

    const savedWidth = clamp(appSettings.sidebarWidth, 180, 320);

    if (savedWidth === sidebarWidth) {
      return;
    }

    const timer = window.setTimeout(() => {
      void updateAppSettings({ sidebarWidth });
    }, 140);

    return () => {
      window.clearTimeout(timer);
    };
  }, [appSettings.sidebarWidth, appState, resizeTarget, sidebarWidth, updateAppSettings]);

  useEffect(() => {
    if (!appState || resizeTarget === "code-canvas") {
      return;
    }

    const savedWidth = clamp(appSettings.codeCanvasWidth, 320, 960);

    if (savedWidth === codeCanvasWidth) {
      return;
    }

    const timer = window.setTimeout(() => {
      void updateAppSettings({ codeCanvasWidth });
    }, 140);

    return () => {
      window.clearTimeout(timer);
    };
  }, [appSettings.codeCanvasWidth, appState, codeCanvasWidth, resizeTarget, updateAppSettings]);

  useEffect(() => {
    if (!appState || resizeTarget === "paper-preview") {
      return;
    }

    const savedWidth = clamp(appSettings.paperPreviewWidth, 420, 1280);

    if (savedWidth === paperPreviewWidth) {
      return;
    }

    const timer = window.setTimeout(() => {
      void updateAppSettings({ paperPreviewWidth });
    }, 140);

    return () => {
      window.clearTimeout(timer);
    };
  }, [appSettings.paperPreviewWidth, appState, paperPreviewWidth, resizeTarget, updateAppSettings]);

  async function bootstrap() {
    try {
      if (!hasBridge) {
        setAppState({
          platform: "browser-preview",
          electronVersion: "preview",
          chromeVersion: "preview",
          nodeVersion: "preview",
          cwd: "",
          selectedWorkspacePath: "",
          selectedWorkspaceLabel: "",
          selectedWorkspaceKind: "local",
          selectedWorkspaceRemoteHost: null,
          selectedWorkspaceRemotePath: null,
          oracleReady: false,
          codexReady: false,
          oracleChromePath: null,
          discordBotStatus: {
            state: "disabled",
            botTag: "",
            botUserId: "",
            lastError: null,
            workspacePath: ""
          },
          settings: DEFAULT_APP_SETTINGS
        });
        return;
      }

      const nextAppState = await window.lithium.getAppState();
      const nextSnapshot = nextAppState.selectedWorkspacePath
        ? await window.lithium.getProjectSnapshot(nextAppState.selectedWorkspacePath)
        : emptySnapshot;

      startTransition(() => {
        setAppState(nextAppState);
        setSnapshot(nextSnapshot);
        setWorkspaceFiles([]);
      });
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function loadWorkspaceFiles(nextWorkspacePath: string) {
    try {
      const files = await window.lithium.listWorkspaceFiles(nextWorkspacePath);
      setWorkspaceFiles(files);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function refreshWorkspace(nextWorkspacePath = workspacePath) {
    const nextAppState = await window.lithium.getAppState();

    if (!nextWorkspacePath) {
      startTransition(() => {
        setAppState(nextAppState);
        setSnapshot(emptySnapshot);
        setWorkspaceFiles([]);
      });
      return;
    }

    const [nextSnapshot, files] = await Promise.all([
      window.lithium.getProjectSnapshot(nextWorkspacePath),
      window.lithium.listWorkspaceFiles(nextWorkspacePath)
    ]);

    startTransition(() => {
      setAppState(nextAppState);
      setSnapshot(nextSnapshot);
      setWorkspaceFiles(files);
    });
  }

  async function refreshProjectSnapshot(nextWorkspacePath = workspacePath) {
    if (!nextWorkspacePath) {
      startTransition(() => {
        setSnapshot(emptySnapshot);
      });
      return emptySnapshot;
    }

    const nextSnapshot = await window.lithium.getProjectSnapshot(nextWorkspacePath);

    startTransition(() => {
      setSnapshot(nextSnapshot);
    });

    return nextSnapshot;
  }

  async function withBusy(label: string, work: () => Promise<void>) {
    setBusyAction(label);
    setError(null);

    try {
      await work();
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    } finally {
      setBusyAction(null);
    }
  }

  function resetTerminalState() {
    setLogsOpen(false);
  }

  function handleToggleSidebar() {
    setSidebarCollapsed((current) => !current);
  }

  function handleToggleTerminal() {
    if (!TERMINAL_FEATURE_ENABLED || !projectReady) {
      return;
    }

    setLogsOpen((current) => !current);
  }

  function resetThreadSurface() {
    setComposerValue("");
    setPendingChatItems([]);
    setPendingChatThreadId(null);
    setDrawerTab("none");
    setLogsOpen(false);
    setInspectorPath("");
    resetTerminalState();
  }

  async function pickWorkspaceSelection() {
    const result = await window.lithium.pickWorkspace();

    if (!result.selectedWorkspacePath) {
      return null;
    }

    const [nextSnapshot, nextAppState, files] = await Promise.all([
      window.lithium.getProjectSnapshot(result.selectedWorkspacePath),
      window.lithium.getAppState(),
      window.lithium.listWorkspaceFiles(result.selectedWorkspacePath)
    ]);

    return {
      workspacePath: result.selectedWorkspacePath,
      appState: nextAppState,
      snapshot: nextSnapshot,
      files
    };
  }

  async function connectRemoteWorkspaceSelection(profileId: string) {
    const result = await window.lithium.connectRemoteWorkspace({ profileId });

    if (!result.selectedWorkspacePath) {
      return null;
    }

    const [nextSnapshot, nextAppState, files] = await Promise.all([
      window.lithium.getProjectSnapshot(result.selectedWorkspacePath),
      window.lithium.getAppState(),
      window.lithium.listWorkspaceFiles(result.selectedWorkspacePath)
    ]);

    return {
      workspacePath: result.selectedWorkspacePath,
      appState: nextAppState,
      snapshot: nextSnapshot,
      files
    };
  }

  function applyWorkspaceSelection(
    selection: {
      workspacePath: string;
      appState: RuntimeAppState;
      snapshot: ProjectSnapshot;
      files: WorkspaceFileRecord[];
    },
    options: { preserveWorkbench?: boolean } = {}
  ) {
    const preserveWorkbench = options.preserveWorkbench ?? false;

    startTransition(() => {
      setAppState(selection.appState);
      setSnapshot(selection.snapshot);
      setWorkspaceFiles(selection.files);
    });

    if (!preserveWorkbench) {
      resetCodeWorkbench();
      setCodeCanvasOpen(false);
      setPendingChatItems([]);
      setPendingChatThreadId(null);
      setInspectorPath("");
      setSelectedPaperPath("");
      setDrawerTab("none");
    }

    setBuilderInspection(null);
    resetTerminalState();
  }

  async function requestWorkspaceForUnsavedFile() {
    const selection = await pickWorkspaceSelection();

    if (!selection) {
      return null;
    }

    applyWorkspaceSelection(selection, {
      preserveWorkbench: true
    });

    return selection.workspacePath;
  }

  async function handlePickWorkspace() {
    await withBusy("Choosing workspace", async () => {
      const selection = await pickWorkspaceSelection();

      if (!selection) {
        return;
      }

      applyWorkspaceSelection(selection);
    });
  }

  async function handleConnectRemoteWorkspace(profileId: string) {
    await withBusy("Connecting remote workspace", async () => {
      const selection = await connectRemoteWorkspaceSelection(profileId);

      if (!selection) {
        return;
      }

      applyWorkspaceSelection(selection);
    });
  }

  async function handleSyncRemoteWorkspace() {
    if (!workspacePath) {
      return;
    }

    await withBusy("Syncing remote workspace", async () => {
      await window.lithium.syncRemoteWorkspace({ workspacePath });
      resetCodeWorkbench();
      setCodeCanvasOpen(false);
      setSelectedPaperPath("");
      await refreshWorkspace(workspacePath);
    });
  }

  async function handleNewCodeFile() {
    createUntitledCodeTab();
  }

  async function handleCreateThread() {
    if (!workspacePath || !projectReady) {
      return;
    }

    await withBusy("Creating thread", async () => {
      const nextSnapshot = await window.lithium.createThread({ workspacePath });

      setSnapshot(nextSnapshot);
      resetThreadSurface();
    });
  }

  async function handleSelectThread(threadId: string) {
    if (!workspacePath || !threadId) {
      return;
    }

    setThreadMenuOpenId(null);
    setThreadMenuPosition(null);

    await withBusy("Switching thread", async () => {
      const nextSnapshot = await window.lithium.selectThread({ workspacePath, threadId });

      setSnapshot(nextSnapshot);
      resetThreadSurface();
    });
  }

  async function handleRenameThread(thread: ThreadRecord) {
    if (!workspacePath) {
      return;
    }

    setThreadMenuOpenId(null);
    setThreadMenuPosition(null);

    const nextTitle = window.prompt("Rename chat", thread.title)?.trim();
    if (!nextTitle || nextTitle === thread.title) {
      return;
    }

    await withBusy("Renaming thread", async () => {
      const nextSnapshot = await window.lithium.renameThread({
        workspacePath,
        threadId: thread.id,
        title: nextTitle
      });
      setSnapshot(nextSnapshot);
    });
  }

  async function handleDeleteThread(thread: ThreadRecord) {
    if (!workspacePath || snapshot.threads.length <= 1) {
      return;
    }

    setThreadMenuOpenId(null);
    setThreadMenuPosition(null);

    const confirmed = window.confirm(`Delete "${thread.title}"?`);
    if (!confirmed) {
      return;
    }

    await withBusy("Deleting thread", async () => {
      const deletedWasActive = thread.id === activeThreadId;
      const nextSnapshot = await window.lithium.deleteThread({
        workspacePath,
        threadId: thread.id
      });
      setSnapshot(nextSnapshot);

      if (deletedWasActive) {
        resetThreadSurface();
      }
    });
  }

  async function handleSaveMemory() {
    if (!workspacePath || !projectReady) {
      return;
    }

    await withBusy("Saving context", async () => {
      const projectSnapshot = await window.lithium.updateProjectMemory({
        workspacePath,
        projectBrief: memoryDraft.projectBrief.trim(),
        researchGoal: memoryDraft.researchGoal.trim(),
        openQuestions: toLines(memoryDraft.openQuestions),
        activeHypotheses: toLines(memoryDraft.activeHypotheses)
      });
      const activeThreadId =
        projectSnapshot.activeThreadId ?? snapshot.activeThreadId ?? snapshot.threads[0]?.id ?? null;
      const nextSnapshot = activeThreadId
        ? await window.lithium.updateThreadMemory({
            workspacePath,
            threadId: activeThreadId,
            memory: threadMemoryDraft.memory.trim()
          })
        : projectSnapshot;

      setSnapshot(nextSnapshot);
      await loadWorkspaceFiles(workspacePath);
    });
  }

  async function applySnapshotUpdate(nextSnapshot: ProjectSnapshot) {
    const nextAppState = await window.lithium.getAppState();
    const nextWorkspacePath = nextAppState.selectedWorkspacePath || nextSnapshot.project?.workspacePath || "";
    const files = nextWorkspacePath ? await window.lithium.listWorkspaceFiles(nextWorkspacePath) : [];

    startTransition(() => {
      setAppState(nextAppState);
      setSnapshot(nextSnapshot);
      setWorkspaceFiles(files);
    });

    return {
      nextAppState,
      nextWorkspacePath,
      files
    };
  }

  async function handleSend(promptOverride?: string) {
    const rawPrompt = (promptOverride ?? composerValue).trim();
    const latestBuilderTaskPrompt = resolveLatestTaskPrompt(snapshot.latestTask?.prompt, "");
    const shouldStartAutomation =
      !automationInteractive && !/^\/(?:research|build|mixed|plan)\b/i.test(rawPrompt);
    const targetThreadId = activeThreadId;

    if (!canSubmitComposerPrompt(rawPrompt, latestBuilderTaskPrompt)) {
      if (/^\/build\s*$/i.test(rawPrompt)) {
        setError("No saved builder task is available yet.");
      }
      return;
    }

    if (!hasBridge) {
      setError("Chat is unavailable in browser preview mode.");
      return;
    }

    const pendingItem: ChatItem = {
      id: `pending-user:${Date.now()}`,
      role: "user",
      variant: "neutral",
      title: "You",
      body: rawPrompt,
      timestamp: new Date().toISOString(),
      order: chatItems.length
    };

    setPendingChatItems([pendingItem]);
    setPendingChatThreadId(targetThreadId ?? UNASSIGNED_PENDING_THREAD_ID);
    setComposerValue("");

    await withBusy("Running chat", async () => {
      try {
        if (shouldStartAutomation) {
          const createdSnapshot = await window.lithium.createAutomationSession({
            workspacePath: workspacePath || undefined,
            threadId: targetThreadId ?? undefined,
            objective: rawPrompt,
            mode: "continuous",
            maxSteps: 64,
            maxRuntimeMinutes: 24 * 60,
            maxRetries: 8,
            paperWriteEnabled: false
          });
          const sessionId = createdSnapshot.latestAutomationSession?.id;

          if (!sessionId) {
            throw new Error("Automation session could not be created.");
          }

          const nextSnapshot = await window.lithium.startAutomationSession({
            workspacePath: workspacePath || undefined,
            sessionId
          });

          await applySnapshotUpdate(nextSnapshot);
          setPendingChatItems([]);
          setPendingChatThreadId(null);
          setDrawerTab("none");
          setLogsOpen(false);
          return;
        }

        if (
          latestAutomationSession &&
          automationInteractive &&
          !/^\/(?:research|build|mixed|plan)\b/i.test(rawPrompt)
        ) {
          const nextSnapshot =
            automationCheckpointPending
              ? await window.lithium.approveAutomationCheckpoint({
                  workspacePath: workspacePath || undefined,
                  sessionId: latestAutomationSession.id,
                  checkpointId: latestAutomationCheckpoint?.id,
                  response: rawPrompt
                })
              : await window.lithium.interruptAutomationSession({
                  workspacePath: workspacePath || undefined,
                  sessionId: latestAutomationSession.id,
                  instruction: rawPrompt,
                  stopNow: false
                });

          await applySnapshotUpdate(nextSnapshot);
          setPendingChatItems([]);
          setPendingChatThreadId(null);
          return;
        }

        if (canUseChatRouter) {
          const nextSnapshot = await window.lithium.sendChatMessage({
            workspacePath: workspacePath || undefined,
            threadId: targetThreadId ?? undefined,
            prompt: rawPrompt
          });

          const { files } = await applySnapshotUpdate(nextSnapshot);
          setPendingChatItems([]);
          setPendingChatThreadId(null);

          if (WORKBENCH_SURFACES_ENABLED) {
            const requestedPaperSurface = promptRequestsPaperSurface(rawPrompt);
            const requestedCodeSurface = promptRequestsCodeSurface(rawPrompt);
            const openPaperSurface = requestedPaperSurface || shouldAutoOpenPaperSurface(nextSnapshot);
            const openCodeSurface =
              !openPaperSurface &&
              (requestedCodeSurface || shouldAutoOpenCodeSurface(nextSnapshot));

            if (openPaperSurface) {
              const nextPaperPath = selectPreferredPaperPath(
                sortPaperExplorerFiles(selectPaperWorkbenchFiles(files.filter((file) => file.kind === "paper"))),
                Boolean(nextSnapshot.latestRun)
              );

              if (nextPaperPath) {
                setSelectedPaperPath(nextPaperPath);
                setInspectorPath(nextPaperPath);
              }

              setCodeCanvasOpen(false);
              setDrawerTab("none");
            } else {
              setDrawerTab("none");

              if (openCodeSurface) {
                const nextCodePath = selectPreferredCodePath(
                  files.filter((file) => file.kind === "code"),
                  nextSnapshot.latestRun?.changedFiles ?? []
                );

                if (nextCodePath) {
                  setInspectorPath(nextCodePath);
                }
              } else {
                setInspectorPath("");
              }

              setCodeCanvasOpen(false);
            }
          } else {
            setDrawerTab("none");
            setCodeCanvasOpen(false);
            setInspectorPath("");
          }

          setLogsOpen(false);
          setComposerValue("");
          return;
        }

        const nextSnapshot = await window.lithium.consultStrategist({
          workspacePath: workspacePath || undefined,
          threadId: targetThreadId ?? undefined,
          prompt: rawPrompt,
          displayPrompt: rawPrompt,
          model: appSettings.strategistModel,
          reasoningIntensity: appSettings.strategistReasoningIntensity
        });

        await applySnapshotUpdate(nextSnapshot);
        setPendingChatItems([]);
        setPendingChatThreadId(null);
        setDrawerTab("none");
        setComposerValue("");
      } catch (nextError) {
        setPendingChatItems([]);
        setPendingChatThreadId(null);
        setComposerValue(rawPrompt);
        throw nextError;
      }
    });
  }

  async function handleStrategistSignIn() {
    if (!hasBridge) {
      await updateAppSettings({ strategistSessionReady: false });
      return;
    }

    await withBusy("Opening ChatGPT sign-in", async () => {
      await updateAppSettings({ strategistSessionReady: false });
      const nextSettings = await window.lithium.beginStrategistSignIn();
      const nextAppState = await window.lithium.getAppState();
      setAppState((current) =>
        current
          ? {
              ...nextAppState,
              settings: nextSettings
            }
          : nextAppState
      );
    });
  }

  async function handleRunStrategistProbe(input: {
    model: "gpt-5.4" | "gpt-5.4-pro";
    reasoningIntensity: "heavy" | "extended";
  }) {
    if (!hasBridge) {
      return;
    }

    await withBusy("Running strategist browser probe", async () => {
      const response = await window.lithium.runStrategistBrowserProbe({
        workspacePath: workspacePath || undefined,
        model: input.model,
        reasoningIntensity: input.reasoningIntensity
      });
      const nextAppState = await window.lithium.getAppState();
      const nextWorkspacePath = response.probe.workspacePath || nextAppState.selectedWorkspacePath;
      const files = nextWorkspacePath
        ? await window.lithium.listWorkspaceFiles(nextWorkspacePath)
        : [];

      startTransition(() => {
        setStrategistProbeResult(response);
        setAppState(nextAppState);
        setSnapshot(response.snapshot);
        setWorkspaceFiles(files);
      });

      if (response.error) {
        setError(response.error);
      }
    });
  }

  async function handleFinalizeRun() {
    if (!workspacePath || !snapshot.latestRun) {
      return;
    }

    await withBusy("Finalizing run", async () => {
      const nextSnapshot = await window.lithium.finalizeBuilderRun({
        workspacePath,
        runId: snapshot.latestRun?.id
      });
      setSnapshot(nextSnapshot);
    });
  }

  async function handleTerminateRun() {
    if (!workspacePath || !snapshot.latestRun) {
      return;
    }

    await withBusy("Terminating run", async () => {
      const nextSnapshot = await window.lithium.terminateBuilderRun({
        workspacePath,
        runId: snapshot.latestRun?.id
      });
      setSnapshot(nextSnapshot);
    });
  }

  async function handleRunLatestTask() {
    const prompt = resolveLatestTaskPrompt(snapshot.latestTask?.prompt, composerValue);

    if (!prompt) {
      return;
    }

    await handleSend(prompt);
  }

  async function handleSavePaper() {
    if (!workspacePath || !selectedPaperPath || selectedPaperPath.toLowerCase().endsWith(".pdf")) {
      return;
    }

    await withBusy("Saving paper", async () => {
      const nextContent = paperDraftRef.current;
      const file = await window.lithium.saveWorkspaceFile({
        workspacePath,
        path: selectedPaperPath,
        content: nextContent
      });
      setPaperDraft(file.content);
      paperDraftRef.current = file.content;
      setPaperDirty(false);

      const nextSnapshot = await window.lithium.compilePaper(workspacePath);
      setSnapshot(nextSnapshot);
      setPdfPreviewVersion((current) => current + 1);
      await loadWorkspaceFiles(workspacePath);
      setDrawerTab("paper");
    });
  }

  async function persistPaperDraftIfNeeded() {
    if (!workspacePath || !paperDirty || !selectedPaperPath || selectedPaperPath.toLowerCase().endsWith(".pdf")) {
      return;
    }

    const nextContent = paperDraftRef.current;
    const file = await window.lithium.saveWorkspaceFile({
      workspacePath,
      path: selectedPaperPath,
      content: nextContent
    });
    setPaperDraft(file.content);
    paperDraftRef.current = file.content;
    setPaperDirty(false);
  }

  async function handleSaveCurrentSurface() {
    if (surfaceMode === "paper" && selectedPaperPath && !selectedPaperPath.toLowerCase().endsWith(".pdf")) {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      await handleSavePaper();
      return;
    }

    if (surfaceMode === "memory") {
      await handleSaveMemory();
      return;
    }

    if (codeCanvasOpen && activeCodeTab) {
      await handleSaveCode();
    }
  }

  async function handleToggleFullscreen() {
    if (!hasBridge) {
      return;
    }

    try {
      await window.lithium.toggleFullscreen();
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function importAttachmentPaths(filePaths: string[]) {
    const nextSnapshot = await window.lithium.importAttachments({
      workspacePath: workspacePath || undefined,
      threadId: snapshot.activeThreadId ?? snapshot.threads[0]?.id ?? undefined,
      filePaths
    });
    const nextAppState = await window.lithium.getAppState();
    const nextWorkspacePath = nextAppState.selectedWorkspacePath || nextSnapshot.project?.workspacePath || "";
    const files = nextWorkspacePath
      ? await window.lithium.listWorkspaceFiles(nextWorkspacePath)
      : [];

    startTransition(() => {
      setAppState(nextAppState);
      setSnapshot(nextSnapshot);
      setWorkspaceFiles(files);
    });
  }

  async function handleDropAttachments(filePaths: string[]) {
    if (!filePaths.length) {
      return;
    }

    await withBusy("Importing attachments", async () => {
      await importAttachmentPaths(filePaths);
    });
  }

  async function handleRemoveAttachment(attachmentId: string) {
    if (!workspacePath) {
      return;
    }

    await withBusy("Removing attachment", async () => {
      const nextSnapshot = await window.lithium.removeAttachment({
        workspacePath,
        attachmentId
      });
      setSnapshot(nextSnapshot);
      await loadWorkspaceFiles(workspacePath);
    });
  }

  async function revealPaperSource(path: string, lineNumber?: number) {
    if (path !== selectedPaperPath) {
      try {
        await persistPaperDraftIfNeeded();
      } catch (nextError) {
        setError(toErrorMessage(nextError));
        return;
      }
    }

    setDrawerTab("paper");
    setCodeCanvasOpen(false);
    setLogsOpen(false);
    setSelectedPaperPath(path);
    setPaperFocusLine(lineNumber);
  }

  async function openPaperTarget(path: string, lineNumber?: number) {
    await revealPaperSource(path, lineNumber);
    setPaperPreviewJump(null);

    if (!workspacePath || !lineNumber) {
      return;
    }

    const previewPath = resolvePdfPreviewPath(path, paperWorkbenchFiles);

    if (!previewPath) {
      return;
    }

    try {
      const target = await window.lithium.resolvePaperSyncTarget({
        workspacePath,
        pdfPath: previewPath,
        sourcePath: path,
        lineNumber
      });

      if (target) {
        setPaperPreviewJump({
          nonce: Date.now(),
          target
        });
      }
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function handlePaperPreviewNavigateSource(target: { pageNumber: number; yRatio: number }) {
    if (!workspacePath || !pdfPreviewPath) {
      return;
    }

    try {
      const sourceTarget = await window.lithium.resolvePaperSourceTarget({
        workspacePath,
        pdfPath: pdfPreviewPath,
        pageNumber: target.pageNumber,
        yRatio: target.yRatio
      });

      if (!sourceTarget) {
        return;
      }

      await revealPaperSource(sourceTarget.sourcePath, sourceTarget.lineNumber);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function handleStartAutomation() {
    await withBusy("Starting automation", async () => {
      const createdSnapshot = await window.lithium.createAutomationSession({
        workspacePath: workspacePath || undefined,
        threadId: snapshot.activeThreadId ?? snapshot.threads[0]?.id ?? undefined,
        objective: automationObjective,
        mode: "continuous",
        maxSteps: 64,
        maxRuntimeMinutes: 24 * 60,
        maxRetries: 8,
        paperWriteEnabled: false
      });
      const sessionId = createdSnapshot.latestAutomationSession?.id;

      if (!sessionId) {
        throw new Error("Automation session could not be created.");
      }

      const nextSnapshot = await window.lithium.startAutomationSession({
        workspacePath: workspacePath || undefined,
        sessionId
      });
      await applySnapshotUpdate(nextSnapshot);
    });
  }

  async function handlePauseAutomation() {
    if (!latestAutomationSession) {
      return;
    }

    await withBusy("Pausing automation", async () => {
      const nextSnapshot = await window.lithium.pauseAutomationSession({
        workspacePath: workspacePath || undefined,
        sessionId: latestAutomationSession.id
      });
      await applySnapshotUpdate(nextSnapshot);
    });
  }

  async function handleResumeAutomation() {
    if (!latestAutomationSession) {
      return;
    }

    await withBusy("Resuming automation", async () => {
      const nextSnapshot = await window.lithium.resumeAutomationSession({
        workspacePath: workspacePath || undefined,
        sessionId: latestAutomationSession.id
      });
      await applySnapshotUpdate(nextSnapshot);
    });
  }

  async function handleApproveAutomationCheckpoint() {
    if (!latestAutomationSession) {
      return;
    }

    await withBusy("Approving checkpoint", async () => {
      const nextSnapshot = await window.lithium.approveAutomationCheckpoint({
        workspacePath: workspacePath || undefined,
        sessionId: latestAutomationSession.id,
        checkpointId: latestAutomationCheckpoint?.id
      });
      await applySnapshotUpdate(nextSnapshot);
    });
  }

  async function handleStopAutomation() {
    if (!latestAutomationSession) {
      return;
    }

    await withBusy("Stopping automation", async () => {
      const nextSnapshot = await window.lithium.interruptAutomationSession({
        workspacePath: workspacePath || undefined,
        sessionId: latestAutomationSession.id,
        instruction: "Stop automation and wait for further user direction.",
        stopNow: true
      });
      await applySnapshotUpdate(nextSnapshot);
    });
  }

  const handleOpenArtifact = useEffectEvent((path: string) => {
    if (!WORKBENCH_SURFACES_ENABLED) {
      return;
    }

    setDrawerTab("none");
    setCodeCanvasOpen(false);
    setLogsOpen(false);
    setInspectorPath(path);
  });

  const handleCloseArtifact = useEffectEvent(() => {
    setInspectorPath("");
  });

  function handleOpenInspectorWorkbench() {
    if (!WORKBENCH_SURFACES_ENABLED || !selectedInspectorFile) {
      return;
    }

    if (selectedInspectorFile.kind === "paper") {
      setSelectedPaperPath(selectedInspectorFile.path);
      setInspectorPath("");
      void openPaperTarget(selectedInspectorFile.path);
      return;
    }

    setInspectorPath("");
    setDrawerTab("none");
    setLogsOpen(false);
    void openCodeFile(selectedInspectorFile.path);
  }

  function setSurface(nextSurface: SurfaceMode) {
    if (!WORKBENCH_SURFACES_ENABLED && nextSurface === "paper") {
      setDrawerTab("none");
      return;
    }

    setDrawerTab(nextSurface === "chat" ? "none" : nextSurface);
  }

  function handleOpenCodeTarget(path: string) {
    if (!WORKBENCH_SURFACES_ENABLED) {
      return;
    }

    setDrawerTab("none");
    setLogsOpen(false);
    setInspectorPath(path);
  }

  function handleOpenChatSurface() {
    setDrawerTab("none");
    setCodeCanvasOpen(false);
    setLogsOpen(false);
    setInspectorPath("");
  }

  function handleOpenCodeSurface() {
    if (!WORKBENCH_SURFACES_ENABLED || !projectReady) {
      return;
    }

    setDrawerTab("none");
    setLogsOpen(false);
    setInspectorPath("");

    if (selectedCodePath) {
      setCodeCanvasOpen(true);
      return;
    }

    const nextCodePath = codeExplorerFiles[0]?.path;

    if (nextCodePath) {
      void openCodeFile(nextCodePath);
      return;
    }

    createUntitledCodeTab({ openCanvas: true });
  }

  function handleOpenPaperSurface() {
    if (!WORKBENCH_SURFACES_ENABLED) {
      return;
    }

    const nextPaperPath = selectedPaperPath || selectPreferredPaperPath(paperExplorerFiles, Boolean(snapshot.latestRun));

    if (!nextPaperPath) {
      return;
    }

    setLogsOpen(false);
    setCodeCanvasOpen(false);
    setInspectorPath("");
    void openPaperTarget(nextPaperPath);
  }

  function renderThreadList() {
    const threads = snapshot.threads.slice();

    return (
      <div className="thread-list" role="tree" aria-label="Chat list">
        {threads.map((thread, index) => {
          const isActive = thread.id === activeThreadId;
          const label = formatThreadLabel(thread, index, isActive ? threadTitle : undefined);
          const menuOpen = threadMenuOpenId === thread.id;
          const unread = !isActive && isThreadUnread(threadSeenState[thread.id], thread.updatedAt);

          return (
            <div
              key={thread.id}
              className={`${isActive ? "thread-row active" : "thread-row"}${unread ? " has-unread" : ""}`}
            >
              <button
                className="thread-row-main"
                onClick={() => void handleSelectThread(thread.id)}
                type="button"
              >
                <span className="thread-row-title">{label}</span>
              </button>
              <div className={menuOpen ? "thread-row-meta-shell menu-open" : "thread-row-meta-shell"}>
                {unread ? <span aria-hidden="true" className="thread-row-unread-dot" /> : null}
                <button
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  aria-label="Chat actions"
                  className="thread-row-action"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (menuOpen) {
                      setThreadMenuOpenId(null);
                      setThreadMenuPosition(null);
                      return;
                    }

                    const rect = event.currentTarget.getBoundingClientRect();
                    setThreadMenuOpenId(thread.id);
                    setThreadMenuPosition({
                      top: rect.bottom + 8,
                      left: Math.max(
                        12,
                        Math.min(rect.right - THREAD_MENU_WIDTH, window.innerWidth - THREAD_MENU_WIDTH - 12)
                      )
                    });
                  }}
                  title="Chat actions"
                  type="button"
                >
                  <svg
                    aria-hidden="true"
                    className="thread-row-action-icon"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <circle cx="5" cy="12" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="19" cy="12" r="1.8" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function renderRailContent() {
    if (surfaceMode !== "memory") {
      if (!projectReady) {
        return null;
      }

      return renderThreadList();
    }

    return (
      <div className="tree-list" role="list" aria-label="Context sections">
        {[
          "Project memory",
          snapshot.activeThread?.title || "Thread memory",
          "Structured handoffs",
          "Current context pack"
        ].map((label, index) => (
          <div key={label} className={index === 0 ? "tree-row file active static" : "tree-row file static"}>
            <span className="tree-file-mark" />
            <span className="tree-label">{label}</span>
          </div>
        ))}
      </div>
    );
  }

  function resolveRailHeading() {
    if (surfaceMode === "memory") {
      return "Context";
    }

    return null;
  }

  return (
    <div
      className={`workspace-shell mode-${surfaceMode}${sidebarCollapsed ? " sidebar-collapsed" : ""}${appState?.platform ? ` platform-${appState.platform}` : ""}`}
      style={workspaceShellStyle}
    >
      <aside className={sidebarCollapsed ? "thread-rail collapsed" : "thread-rail"}>
        <div className={railHeading ? "thread-rail-header" : "thread-rail-header empty"}>
          {railHeading ? <div className="explorer-heading">{railHeading}</div> : null}
        </div>
        <div className="thread-rail-body">{renderRailContent()}</div>
        <div className="thread-rail-footer">
          <button
            aria-label="Open settings"
            className={settingsOpen ? "rail-footer-action active" : "rail-footer-action"}
            onClick={openSettings}
            title="Settings"
            type="button"
          >
            <svg
              aria-hidden="true"
              className="rail-footer-icon"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                d="M10.08 3.75c.2-.77 1.29-.77 1.49 0l.28 1.08c.1.38.4.68.78.78l1.08.28c.77.2.77 1.29 0 1.49l-1.08.28a1.13 1.13 0 0 0-.78.78l-.28 1.08c-.2.77-1.29.77-1.49 0l-.28-1.08a1.13 1.13 0 0 0-.78-.78l-1.08-.28c-.77-.2-.77-1.29 0-1.49l1.08-.28c.38-.1.68-.4.78-.78l.28-1.08Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.75"
              />
              <circle
                cx="12"
                cy="12"
                r="3.1"
                stroke="currentColor"
                strokeWidth="1.75"
              />
            </svg>
          </button>
        </div>
      </aside>
      {!sidebarCollapsed ? (
        <div
          className="pane-resizer"
          onMouseDown={(event) => {
            event.preventDefault();
            setResizeTarget("sidebar");
          }}
          role="separator"
        />
      ) : null}

      <main className="content-shell">
        <section className={`main-shell surface-${surfaceMode}`}>
          <header className="surface-header" onDoubleClick={() => void handleToggleFullscreen()}>
            <div className="surface-leading">
              <div className="surface-title-block">
                <div className="surface-title-row">
                  <div className="surface-title">{surfaceTitle}</div>
                </div>
              </div>
            </div>
            <div className={showAutomationHeaderAction ? "surface-actions" : "surface-actions hidden"}>
              <button
                aria-label={
                  automationRunning
                    ? "Stop autopilot"
                    : automationCheckpointPending
                    ? "Continue autopilot"
                    : "Start autopilot"
                }
                className={
                  automationRunning
                    ? "surface-icon-button active"
                    : automationCheckpointPending
                    ? "surface-icon-button ready"
                    : "surface-icon-button"
                }
                disabled={Boolean(busyAction) || !hasBridge}
                onClick={() => {
                  if (automationRunning) {
                    void handleStopAutomation();
                    return;
                  }

                  if (automationCheckpointPending) {
                    void handleApproveAutomationCheckpoint();
                    return;
                  }

                  void handleStartAutomation();
                }}
                title={
                  automationRunning
                    ? "Stop autopilot"
                    : automationCheckpointPending
                    ? "Continue autopilot"
                    : "Start autopilot"
                }
                type="button"
              >
                {automationRunning ? (
                  <svg aria-hidden="true" fill="currentColor" viewBox="0 0 20 20">
                    <rect height="8.5" rx="1.6" width="8.5" x="5.75" y="5.75" />
                  </svg>
                ) : (
                  <svg aria-hidden="true" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M6.4 4.8a.8.8 0 0 1 1.2-.68l7.1 4.4a.8.8 0 0 1 0 1.36l-7.1 4.4A.8.8 0 0 1 6.4 13.6V4.8Z" />
                  </svg>
                )}
              </button>
            </div>
          </header>

          <section className="surface-main">
            {surfaceMode === "chat" ? (
              <section className="surface-panel chat-canvas-surface">
                <div className={terminalOpen ? "chat-canvas-stack logs-open" : "chat-canvas-stack"}>
                  <div
                    className={codeCanvasOpen || inspectorOpen ? "chat-canvas-body canvas-open" : "chat-canvas-body"}
                    style={codeCanvasOpen || inspectorOpen ? codeWorkbenchStyle : undefined}
                  >
                    <section className="chat-column chat-primary">
                      <div ref={chatScrollRef} className="chat-scroll">
                        <ChatFeed
                          items={visibleChatItems}
                          onOpenArtifact={WORKBENCH_SURFACES_ENABLED ? handleOpenArtifact : undefined}
                          researchGoal={snapshot.memory?.researchGoal}
                          workspacePath={workspacePath}
                        />
                      </div>
                      <Composer
                        attachments={snapshot.activeThreadAttachments}
                        appSettings={appSettings}
                        automationInteractive={automationInteractive}
                        startsAutomation={composerStartsAutomation}
                        busy={Boolean(busyAction)}
                        canCreateThread={Boolean(workspacePath && projectReady)}
                        canOpenCode={WORKBENCH_SURFACES_ENABLED && projectReady}
                        canOpenPaper={
                          WORKBENCH_SURFACES_ENABLED &&
                          Boolean(
                            selectedPaperPath || selectPreferredPaperPath(paperExplorerFiles, Boolean(snapshot.latestRun))
                          )
                        }
                        canToggleTerminal={WORKBENCH_SURFACES_ENABLED && TERMINAL_FEATURE_ENABLED && projectReady}
                        onCreateThread={() => {
                          void handleCreateThread();
                        }}
                        onDropFiles={(filePaths) => {
                          void handleDropAttachments(filePaths);
                        }}
                        onOpenChatSurface={handleOpenChatSurface}
                        onOpenCodeSurface={handleOpenCodeSurface}
                        onOpenPaperSurface={handleOpenPaperSurface}
                        onOpenSettings={openSettings}
                        onRemoveAttachment={(attachmentId) => void handleRemoveAttachment(attachmentId)}
                        onSend={handleSend}
                        onToggleTerminal={handleToggleTerminal}
                        onValueChange={setComposerValue}
                        placeholder={composerPlaceholder}
                        value={composerValue}
                      />
                    </section>
                    {WORKBENCH_SURFACES_ENABLED && inspectorOpen ? (
                      <>
                        <div
                          className="pane-resizer"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            setResizeTarget("code-canvas");
                          }}
                          role="separator"
                        />
                        <section className="code-canvas-shell">
                          <ArtifactInspector
                            changedFiles={changedFiles}
                            file={selectedInspectorFile}
                            onClose={handleCloseArtifact}
                            onOpenWorkbench={handleOpenInspectorWorkbench}
                            onRefresh={async () => {
                              await refreshWorkspace(workspacePath);
                            }}
                            themeMode={resolvedTheme}
                            workspacePath={workspacePath}
                          />
                        </section>
                      </>
                    ) : null}
                    {WORKBENCH_SURFACES_ENABLED && !inspectorOpen && codeCanvasOpen ? (
                      <>
                        <div
                          className="pane-resizer"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            setResizeTarget("code-canvas");
                          }}
                          role="separator"
                        />
                        <section className="code-canvas-shell">
                          <CodeWorkbench
                            busy={Boolean(busyAction)}
                            codeDraft={codeDraft}
                            codeFilesCount={codeExplorerFiles.length}
                            codeTitle={activeCodeTab?.label ?? ""}
                            codeTabs={codeTabs}
                            onChangeCode={updateCodeDraft}
                            onCloseCanvas={() => setCodeCanvasOpen(false)}
                            onCloseCodeTab={handleCloseCodeTab}
                            onCreateCodeFile={() => void handleNewCodeFile()}
                            onOpenWorkspace={() => void handlePickWorkspace()}
                            onSelectCodePath={setSelectedCodePath}
                            projectReady={projectReady}
                            selectedCodePath={selectedCodePath}
                            themeMode={resolvedTheme}
                            workspacePath={workspacePath}
                          />
                        </section>
                      </>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}

            {surfaceMode === "memory" ? (
              <ContextWorkbench
                activeThread={snapshot.activeThread}
                busy={Boolean(busyAction)}
                contextBundlePreview={contextBundlePreview}
                latestDecision={snapshot.latestDecision}
                latestRun={snapshot.latestRun}
                memoryDraft={memoryDraft}
                onChangeMemoryField={(field, value) =>
                  setMemoryDraft((current) => ({
                    ...current,
                    [field]: value
                  }))
                }
                onChangeThreadMemory={(value) => setThreadMemoryDraft({ memory: value })}
                onSave={() => void handleSaveMemory()}
                projectReady={projectReady}
                sessionSummary={snapshot.memory?.sessionSummary || ""}
                threadMemory={threadMemoryDraft.memory}
              />
            ) : null}

            {WORKBENCH_SURFACES_ENABLED && surfaceMode === "paper" ? (
              <PaperWorkbench
                busy={Boolean(busyAction)}
                jump={paperPreviewJump}
                onChangePaper={(value) => {
                  paperDraftRef.current = value;
                  setPaperDraft(value);
                  setPaperDirty(true);
                }}
                onNavigateSource={(target) => {
                  void handlePaperPreviewNavigateSource(target);
                }}
                onResizePreview={() => setResizeTarget("paper-preview")}
                paperDraft={paperDraft}
                paperFocusLine={paperFocusLine}
                paperPreviewBytes={pdfPreviewBytes}
                paperTitle={paperTitle}
                projectReady={projectReady}
                selectedPaperPath={selectedPaperPath}
                storageKey={pdfPreviewPath ?? selectedPaperPath}
                style={paperSurfaceStyle}
                themeMode={resolvedTheme}
              />
            ) : null}
          </section>
        </section>
      </main>

      {appState && onboardingVisible ? (
        <OnboardingPanel
          appState={appState}
          onDismiss={() => void dismissOnboarding()}
          onOpenWorkspace={() => void handlePickWorkspace()}
          projectReady={projectReady}
        />
      ) : null}

      {appState && settingsOpen ? (
        <SettingsPanel
          appState={appState}
          onConnectRemoteWorkspace={(profileId) => void handleConnectRemoteWorkspace(profileId)}
          onClose={closeSettings}
          onReopenOnboarding={() => void reopenOnboarding()}
          onRunStrategistProbe={(input) => void handleRunStrategistProbe(input)}
          onSyncRemoteWorkspace={() => void handleSyncRemoteWorkspace()}
          onStartStrategistSignIn={() => void handleStrategistSignIn()}
          onSetTheme={(themePreference) => void updateAppSettings({ themePreference })}
          onUpdateSettings={updateAppSettings}
          settings={appSettings}
          strategistProbeBusy={busyAction === "Running strategist browser probe"}
          strategistProbeResult={strategistProbeResult}
        />
      ) : null}

      {threadMenuOpenId && threadMenuPosition ? (
        <div
          className="thread-row-menu thread-row-menu-popover"
          role="menu"
          style={{
            top: `${threadMenuPosition.top}px`,
            left: `${threadMenuPosition.left}px`
          }}
        >
          <button
            className="thread-row-menu-item"
            onClick={() => {
              const thread = snapshot.threads.find((candidate) => candidate.id === threadMenuOpenId);
              if (thread) {
                void handleRenameThread(thread);
              }
            }}
            role="menuitem"
            type="button"
          >
            <svg
              aria-hidden="true"
              className="thread-row-menu-icon"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                d="M4 20h4.4a2 2 0 0 0 1.4-.58L19 10.22a2.12 2.12 0 1 0-3-3L6.82 16.42A2 2 0 0 0 6.24 17.8V20Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.7"
              />
              <path
                d="m13.5 9 3.5 3.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.7"
              />
            </svg>
            <span>Rename</span>
          </button>
          <button
            className="thread-row-menu-item destructive"
            disabled={snapshot.threads.length <= 1}
            onClick={() => {
              const thread = snapshot.threads.find((candidate) => candidate.id === threadMenuOpenId);
              if (thread) {
                void handleDeleteThread(thread);
              }
            }}
            role="menuitem"
            type="button"
          >
            <svg
              aria-hidden="true"
              className="thread-row-menu-icon"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                d="M4.5 7.5h15"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.7"
              />
              <path
                d="M9.5 3.75h5a1 1 0 0 1 1 1V7.5h-7V4.75a1 1 0 0 1 1-1Z"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="1.7"
              />
              <path
                d="m7 7.5.8 10.02A2 2 0 0 0 9.8 19.4h4.4a2 2 0 0 0 1.99-1.88L17 7.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.7"
              />
              <path
                d="M10 11v4.5M14 11v4.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.7"
              />
            </svg>
            <span>Delete</span>
          </button>
        </div>
      ) : null}

      {error ? <div className="error-toast">{error}</div> : null}
    </div>
  );
}

function buildThreadSeenStorageKey(workspacePath: string) {
  return `lithium:thread-seen:${encodeURIComponent(workspacePath)}`;
}

function isThreadUnread(lastSeenAt: string | undefined, updatedAt: string) {
  if (!lastSeenAt) {
    return false;
  }

  return updatedAt > lastSeenAt;
}
