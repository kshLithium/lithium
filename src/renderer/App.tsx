import {
  Suspense,
  lazy,
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { DEFAULT_APP_SETTINGS } from "../shared/types";
import {
  clampCodeCanvasWidth,
  clampPaperPreviewWidth,
  clampSidebarWidth
} from "../shared/app-settings";
import type {
  AttachmentRecord,
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
  buildAttachmentArtifactRefs,
  buildChatItems,
  buildExplorerRows,
  formatLiveProgressBody,
  mergeTransientChatItems,
  selectPreferredCodePath,
  clamp,
  formatPaperLabel,
  formatThreadLabel,
  normalizePath,
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
import { ChatFeed } from "./ChatFeed";
import { stabilizeChatProgress } from "./chat-progress";
import { Composer } from "./Composer";
import {
  canSubmitComposerPrompt,
  describeBusyChatState,
  UNASSIGNED_PENDING_THREAD_ID,
  isPendingChatVisible,
  promptRequestsCodeSurface,
  promptRequestsPaperSurface,
  resolveLatestTaskPrompt,
  shouldAutoOpenCodeSurface,
  shouldAutoOpenPaperSurface
} from "./chat-surface";
import { usePollingTask } from "./usePollingTask";
import { useAppPreferences } from "./useAppPreferences";
import { useCodeWorkbenchState } from "./useCodeWorkbenchState";
import { isThreadUnread, useThreadSeenState } from "./useThreadSeenState";
import { TERMINAL_FEATURE_ENABLED, WORKBENCH_SURFACES_ENABLED } from "../shared/feature-flags";

const INITIAL_SURFACE = resolveInitialSurface();
const THREAD_MENU_WIDTH = 168;
const INITIAL_DRAWER_TAB: DrawerTab =
  INITIAL_SURFACE === "chat" ? "none" : !WORKBENCH_SURFACES_ENABLED && INITIAL_SURFACE === "paper" ? "none" : INITIAL_SURFACE;
const PANEL_FALLBACK = <div className="empty-state">Loading panel…</div>;
const SURFACE_FALLBACK = <div className="empty-state">Loading surface…</div>;

const ArtifactInspector = lazy(async () => {
  const module = await import("./ArtifactInspector");
  return { default: module.ArtifactInspector };
});

const CodeWorkbench = lazy(async () => {
  const module = await import("./CodeWorkbench");
  return { default: module.CodeWorkbench };
});

const ContextWorkbench = lazy(async () => {
  const module = await import("./ContextWorkbench");
  return { default: module.ContextWorkbench };
});

const OnboardingPanel = lazy(async () => {
  const module = await import("./OnboardingPanel");
  return { default: module.OnboardingPanel };
});

const PaperWorkbench = lazy(async () => {
  const module = await import("./PaperWorkbench");
  return { default: module.PaperWorkbench };
});

const SettingsPanel = lazy(async () => {
  const module = await import("./SettingsPanel");
  return { default: module.SettingsPanel };
});

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
  const [queuedChatPrompts, setQueuedChatPrompts] = useState<
    Array<{ id: string; prompt: string; threadId: string | null; attachments: AttachmentRecord[] }>
  >([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft>(emptyMemoryDraft);
  const [threadMemoryDraft, setThreadMemoryDraft] = useState(emptyThreadMemoryDraft);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [threadMenuOpenId, setThreadMenuOpenId] = useState<string | null>(null);
  const [threadMenuPosition, setThreadMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [codeCanvasWidth, setCodeCanvasWidth] = useState(DEFAULT_APP_SETTINGS.codeCanvasWidth);
  const [paperPreviewWidth, setPaperPreviewWidth] = useState(DEFAULT_APP_SETTINGS.paperPreviewWidth);
  const [resizeTarget, setResizeTarget] = useState<ResizeTarget>(null);
  const [inspectorPath, setInspectorPath] = useState("");
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastChatScrollKeyRef = useRef("");
  const busyActionStackRef = useRef<Array<{ id: number; label: string }>>([]);
  const nextBusyActionIdRef = useRef(0);
  const paperDraftRef = useRef("");
  const paperDirtyRef = useRef(false);
  const paperLoadRequestRef = useRef(0);
  const sidebarWidthRef = useRef(DEFAULT_APP_SETTINGS.sidebarWidth);
  const workspaceLoadRequestRef = useRef(0);
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
  const threadSeenState = useThreadSeenState({
    workspacePath,
    projectId: snapshot.project?.id,
    threads: snapshot.threads,
    activeThread: snapshot.activeThread
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
  const visibleChatItems = useMemo(
    () =>
      mergeTransientChatItems(chatItems, visiblePendingChatItems, {
        busyAction,
        busyBody: busyAction ? formatLiveProgressBody(chatProgress) || describeBusyChatState(busyAction) : "",
        chatProgress,
        workspacePath,
        activeThreadId
      }),
    [activeThreadId, busyAction, chatItems, chatProgress, visiblePendingChatItems, workspacePath]
  );
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
    workspaceRevision,
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
  const activePendingAutomationCheckpoint = useMemo(() => {
    if (!latestAutomationSession) {
      return null;
    }

    const checkpoints = snapshot.automationCheckpoints ?? [];

    return (
      checkpoints.find(
        (checkpoint) =>
          checkpoint.threadId === activeThreadId &&
          checkpoint.sessionId === latestAutomationSession.id &&
          checkpoint.status === "pending" &&
          checkpoint.id === latestAutomationSession.latestCheckpointId
      ) ||
      checkpoints.find(
        (checkpoint) =>
          checkpoint.threadId === activeThreadId &&
          checkpoint.sessionId === latestAutomationSession.id &&
          checkpoint.status === "pending"
      ) ||
      null
    );
  }, [activeThreadId, latestAutomationSession, snapshot.automationCheckpoints]);
  const automationCheckpointPending = Boolean(latestAutomationSession && activePendingAutomationCheckpoint);
  const inspectorOpen = WORKBENCH_SURFACES_ENABLED && Boolean(selectedInspectorFile);
  const automationRunning = latestAutomationSession?.status === "running";
  const automationInteractive = automationRunning || automationCheckpointPending;
  const composerAllowWhileBusy = automationInteractive || busyAction === "Running chat";
  const terminalOpen = WORKBENCH_SURFACES_ENABLED && TERMINAL_FEATURE_ENABLED && logsOpen;
  const composerPlaceholder = composerAllowWhileBusy
    ? "Ask for status, steer, or say stop."
    : "Start with a message.";
  const railHeading = resolveRailHeading();
  const railProjectTitle = surfaceTitle === "Lithium" ? "" : surfaceTitle;
  const hasRailHeader = Boolean(railProjectTitle || railHeading);

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
    if (typeof document === "undefined") {
      return;
    }

    document.title = surfaceTitle === "Lithium" ? "Lithium" : `${surfaceTitle} · Lithium`;
  }, [surfaceTitle]);

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

    setSidebarWidth(clampSidebarWidth(appSettings.sidebarWidth));
  }, [appSettings.sidebarWidth, appState]);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (!appState) {
      return;
    }

    setCodeCanvasWidth(clampCodeCanvasWidth(appSettings.codeCanvasWidth));
  }, [appSettings.codeCanvasWidth, appState]);

  useEffect(() => {
    if (!appState) {
      return;
    }

    setPaperPreviewWidth(clampPaperPreviewWidth(appSettings.paperPreviewWidth));
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
  }, [selectedPaperPath, workspacePath, workspaceRevision]);

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

  usePollingTask({
    deps: [
      snapshot.latestRun?.finalization,
      snapshot.latestRun?.id,
      snapshot.latestRun?.status,
      workspacePath
    ],
    enabled: Boolean(workspacePath && snapshot.latestRun),
    task: async () => {
      try {
        const inspection = await window.lithium.inspectBuilderRun({
          workspacePath,
          runId: snapshot.latestRun?.id
        });

        if (!inspection) {
          return null;
        }

        setBuilderInspection(inspection);

        const finalized =
          inspection.run?.status !== snapshot.latestRun?.status ||
          inspection.run?.finalization !== snapshot.latestRun?.finalization;

        if (finalized) {
          await refreshWorkspace(workspacePath);
          return null;
        }

        return inspection.active || inspection.suggestedStatus !== "idle" ? 900 : null;
      } catch {
        return 2_000;
      }
    }
  });

  useEffect(() => {
    if (!workspacePath || !snapshot.latestRun) {
      setBuilderInspection(null);
    }
  }, [snapshot.latestRun, workspacePath]);

  usePollingTask({
    deps: [activeThreadId, automationRunning, busyAction, hasBridge, pendingChatItems.length, workspacePath],
    enabled:
      hasBridge &&
      (Boolean(busyAction && pendingChatItems.length) || automationRunning) &&
      typeof window.lithium.inspectChatProgress === "function",
    task: async () => {
      try {
        const inspection = await window.lithium.inspectChatProgress({
          workspacePath: workspacePath || undefined,
          threadId: activeThreadId || undefined
        });

        setChatProgress((current) => stabilizeChatProgress(current, inspection));
        return inspection?.active || !inspection ? 700 : null;
      } catch {
        return 1_200;
      }
    }
  });

  useEffect(() => {
    if (
      hasBridge &&
      (Boolean(busyAction && pendingChatItems.length) || automationRunning) &&
      typeof window.lithium.inspectChatProgress === "function"
    ) {
      return;
    }

    setChatProgress(null);
  }, [activeThreadId, automationRunning, busyAction, hasBridge, pendingChatItems.length, workspacePath]);

  usePollingTask({
    deps: [automationRunning, latestAutomationSession?.id, workspacePath],
    enabled: Boolean(workspacePath && latestAutomationSession && automationRunning),
    initialDelayMs: 1200,
    task: async () => {
      try {
        await refreshProjectSnapshot(workspacePath);
        return 1400;
      } catch {
        return 2200;
      }
    }
  });

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

    const savedWidth = clampSidebarWidth(appSettings.sidebarWidth);

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

    const savedWidth = clampCodeCanvasWidth(appSettings.codeCanvasWidth);

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

    const savedWidth = clampPaperPreviewWidth(appSettings.paperPreviewWidth);

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
    const requestId = workspaceLoadRequestRef.current + 1;
    workspaceLoadRequestRef.current = requestId;

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
      const [nextSnapshot, files] = nextAppState.selectedWorkspacePath
        ? await Promise.all([
            window.lithium.getProjectSnapshot(nextAppState.selectedWorkspacePath),
            window.lithium.listWorkspaceFiles(nextAppState.selectedWorkspacePath)
          ])
        : [emptySnapshot, [] as WorkspaceFileRecord[]];

      if (workspaceLoadRequestRef.current !== requestId) {
        return;
      }

      startTransition(() => {
        setAppState(nextAppState);
        setSnapshot(nextSnapshot);
        setWorkspaceFiles(files);
        setWorkspaceRevision((current) => current + 1);
      });
    } catch (nextError) {
      if (workspaceLoadRequestRef.current === requestId) {
        setError(toErrorMessage(nextError));
      }
    }
  }

  async function refreshWorkspace(nextWorkspacePath = workspacePath) {
    const requestId = workspaceLoadRequestRef.current + 1;
    workspaceLoadRequestRef.current = requestId;
    const nextAppState = await window.lithium.getAppState();

    if (!nextWorkspacePath) {
      if (workspaceLoadRequestRef.current !== requestId) {
        return;
      }

      startTransition(() => {
        setAppState(nextAppState);
        setSnapshot(emptySnapshot);
        setWorkspaceFiles([]);
        setWorkspaceRevision((current) => current + 1);
      });
      return;
    }

    const [nextSnapshot, files] = await Promise.all([
      window.lithium.getProjectSnapshot(nextWorkspacePath),
      window.lithium.listWorkspaceFiles(nextWorkspacePath)
    ]);

    if (workspaceLoadRequestRef.current !== requestId) {
      return;
    }

    startTransition(() => {
      setAppState(nextAppState);
      setSnapshot(nextSnapshot);
      setWorkspaceFiles(files);
      setWorkspaceRevision((current) => current + 1);
    });
  }

  async function refreshProjectSnapshot(nextWorkspacePath = workspacePath) {
    const requestId = workspaceLoadRequestRef.current;

    if (!nextWorkspacePath) {
      if (workspaceLoadRequestRef.current === requestId) {
        startTransition(() => {
          setSnapshot(emptySnapshot);
        });
      }
      return emptySnapshot;
    }

    const nextSnapshot = await window.lithium.getProjectSnapshot(nextWorkspacePath);

    if (workspaceLoadRequestRef.current !== requestId) {
      return nextSnapshot;
    }

    startTransition(() => {
      setSnapshot(nextSnapshot);
    });

    return nextSnapshot;
  }

  async function withBusy(label: string, work: () => Promise<void>) {
    const busyActionId = nextBusyActionIdRef.current + 1;
    nextBusyActionIdRef.current = busyActionId;
    busyActionStackRef.current = [...busyActionStackRef.current, { id: busyActionId, label }];
    setBusyAction(label);
    setError(null);

    try {
      await work();
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    } finally {
      busyActionStackRef.current = busyActionStackRef.current.filter((entry) => entry.id !== busyActionId);
      setBusyAction(busyActionStackRef.current[busyActionStackRef.current.length - 1]?.label ?? null);
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
    workspaceLoadRequestRef.current += 1;

    startTransition(() => {
      setAppState(selection.appState);
      setSnapshot(selection.snapshot);
      setWorkspaceFiles(selection.files);
      setWorkspaceRevision((current) => current + 1);
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

      await applySnapshotUpdate(nextSnapshot);
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
    return await handleSendWithOptions(promptOverride);
  }

  async function handleSendWithOptions(
    promptOverride?: string,
    options: {
      bypassQueue?: boolean;
      pendingItemId?: string;
      targetThreadId?: string | null;
      attachmentSnapshot?: AttachmentRecord[];
    } = {}
  ) {
    const rawPrompt = (promptOverride ?? composerValue).trim();
    const latestBuilderTaskPrompt = resolveLatestTaskPrompt(snapshot.latestTask?.prompt, "");
    const targetThreadId = options.targetThreadId ?? activeThreadId;
    const attachmentsForSend = options.attachmentSnapshot ?? snapshot.activeThreadAttachments;
    const attachmentArtifacts = buildAttachmentArtifactRefs(
      attachmentsForSend,
      workspaceFiles,
      workspacePath
    );
    const optimisticAttachments = attachmentsForSend;
    const shouldOptimisticallyClearAttachments =
      optimisticAttachments.length > 0 && Boolean(targetThreadId) && targetThreadId === activeThreadId;

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

    const pendingItemId =
      options.pendingItemId ?? `pending-user:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const pendingThreadId = targetThreadId ?? UNASSIGNED_PENDING_THREAD_ID;

    if (!options.bypassQueue && busyAction === "Running chat" && !automationInteractive) {
      const pendingItem: ChatItem = {
        id: pendingItemId,
        role: "user",
        variant: "neutral",
        title: "You",
        body: rawPrompt,
        timestamp: new Date().toISOString(),
        order: chatItems.length + pendingChatItems.length,
        artifacts: attachmentArtifacts.length ? attachmentArtifacts : undefined
      };

      setPendingChatItems((current) => {
        if (current.some((item) => item.id === pendingItemId)) {
          return current;
        }

        return [...current, pendingItem];
      });
      setPendingChatThreadId(pendingThreadId);
      setQueuedChatPrompts((current) => [
        ...current,
        {
          id: pendingItemId,
          prompt: rawPrompt,
          threadId: targetThreadId,
          attachments: optimisticAttachments
        }
      ]);
      setComposerValue("");
      if (shouldOptimisticallyClearAttachments) {
        setSnapshot((current) =>
          current.activeThreadId === targetThreadId
            ? {
                ...current,
                activeThreadAttachments: []
              }
            : current
        );
      }
      return;
    }

    const pendingItem: ChatItem = {
      id: pendingItemId,
      role: "user",
      variant: "neutral",
      title: "You",
      body: rawPrompt,
      timestamp: new Date().toISOString(),
      order: chatItems.length + pendingChatItems.length,
      artifacts: attachmentArtifacts.length ? attachmentArtifacts : undefined
    };

    setPendingChatItems((current) => {
      if (current.some((item) => item.id === pendingItemId)) {
        return current;
      }

      return [...current, pendingItem];
    });
    setPendingChatThreadId(pendingThreadId);
    setComposerValue("");
    if (shouldOptimisticallyClearAttachments) {
      setSnapshot((current) =>
        current.activeThreadId === targetThreadId
          ? {
              ...current,
              activeThreadAttachments: []
            }
          : current
      );
    }

    await withBusy("Running chat", async () => {
      try {
        if (canUseChatRouter) {
          const nextSnapshot = await window.lithium.sendChatMessage({
            workspacePath: workspacePath || undefined,
            threadId: targetThreadId ?? undefined,
            prompt: rawPrompt
          });

          const { files } = await applySnapshotUpdate(nextSnapshot);
          setPendingChatItems((current) => current.filter((item) => item.id !== pendingItemId));

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
        setPendingChatItems((current) => current.filter((item) => item.id !== pendingItemId));
        setDrawerTab("none");
      } catch (nextError) {
        setPendingChatItems((current) => current.filter((item) => item.id !== pendingItemId));
        setComposerValue((current) => (current.trim() ? current : rawPrompt));
        if (shouldOptimisticallyClearAttachments) {
          setSnapshot((current) =>
            current.activeThreadId === targetThreadId && current.activeThreadAttachments.length === 0
              ? {
                  ...current,
                  activeThreadAttachments: optimisticAttachments
                }
              : current
          );
        }
        throw nextError;
      }
    });
  }

  useEffect(() => {
    if (busyAction || !queuedChatPrompts.length) {
      return;
    }

    const nextPrompt = queuedChatPrompts[0];

    if (!nextPrompt) {
      return;
    }

    setQueuedChatPrompts((current) => current.filter((entry) => entry.id !== nextPrompt.id));
    void handleSendWithOptions(nextPrompt.prompt, {
      bypassQueue: true,
      pendingItemId: nextPrompt.id,
      targetThreadId: nextPrompt.threadId,
      attachmentSnapshot: nextPrompt.attachments
    });
  }, [busyAction, queuedChatPrompts, activeThreadId, chatItems.length, pendingChatItems.length]);

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
      await applySnapshotUpdate(response.snapshot);
      setStrategistProbeResult(response);

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
      await applySnapshotUpdate(nextSnapshot);
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
      await applySnapshotUpdate(nextSnapshot);
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
      await applySnapshotUpdate(nextSnapshot);
      setPdfPreviewVersion((current) => current + 1);
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
    await applySnapshotUpdate(nextSnapshot);
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
      await applySnapshotUpdate(nextSnapshot);
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
        <div className={hasRailHeader ? "thread-rail-header" : "thread-rail-header empty"}>
          {railProjectTitle ? (
            <div className="thread-rail-project">
              <div className="thread-rail-project-name" title={railProjectTitle}>
                {railProjectTitle}
              </div>
              {railHeading ? <div className="thread-rail-project-meta">{railHeading}</div> : null}
            </div>
          ) : railHeading ? (
            <div className="explorer-heading">{railHeading}</div>
          ) : null}
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
          <div className="surface-header surface-header-ghost" onDoubleClick={() => void handleToggleFullscreen()} />

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
                      <div className="chat-composer-wrap">
                        <Composer
                          allowWhileBusy={composerAllowWhileBusy}
                          attachments={snapshot.activeThreadAttachments}
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
                      </div>
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
                          <Suspense fallback={SURFACE_FALLBACK}>
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
                          </Suspense>
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
                          <Suspense fallback={SURFACE_FALLBACK}>
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
                          </Suspense>
                        </section>
                      </>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}

            {surfaceMode === "memory" ? (
              <Suspense fallback={SURFACE_FALLBACK}>
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
              </Suspense>
            ) : null}

            {WORKBENCH_SURFACES_ENABLED && surfaceMode === "paper" ? (
              <Suspense fallback={SURFACE_FALLBACK}>
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
              </Suspense>
            ) : null}
          </section>
        </section>
      </main>

      {appState && onboardingVisible ? (
        <Suspense fallback={PANEL_FALLBACK}>
          <OnboardingPanel
            appState={appState}
            onDismiss={() => void dismissOnboarding()}
            onOpenWorkspace={() => void handlePickWorkspace()}
            projectReady={projectReady}
          />
        </Suspense>
      ) : null}

      {appState && settingsOpen ? (
        <Suspense fallback={PANEL_FALLBACK}>
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
        </Suspense>
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
