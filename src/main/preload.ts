import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettingsUpdate,
  AttachmentDeleteRequest,
  AttachmentImportRequest,
  AppCommand,
  AutomationCheckpointApprovalRequest,
  AutomationInterruptRequest,
  AutomationSessionControlRequest,
  AutomationSessionCreateRequest,
  InitialThemeState,
  ChatRequest,
  BuilderRunControlRequest,
  BuilderRequest,
  TerminalEvent,
  PaperSourceTargetRequest,
  PaperSyncTargetRequest,
  RemoteWorkspaceConnectRequest,
  RemoteWorkspaceSyncRequest,
  ThreadDeleteRequest,
  ThreadCreateRequest,
  ThreadMemoryUpdateRequest,
  ThreadRenameRequest,
  ThreadSelectionRequest,
  LithiumApi,
  ProjectMemoryUpdate,
  StrategistRequest,
  TerminalSessionCreateRequest,
  TerminalSessionInputRequest,
  TerminalSessionResizeRequest,
  TerminalSessionRequest,
  WorkspaceDiffRequest,
  WorkspaceFileRequest,
  WorkspaceFileWriteRequest
} from "../shared/types";

const APP_COMMAND_CHANNEL = "lithium:app-command";
const TERMINAL_EVENT_CHANNEL = "lithium:terminal-event";
const THEME_STATE_CHANNEL = "lithium:theme-state";

const api: LithiumApi = {
  getInitialThemeState: () =>
    ipcRenderer.sendSync("lithium:get-initial-theme-state") as InitialThemeState,
  onThemeStateChange: (listener) => {
    const handler = (_event: unknown, themeState: InitialThemeState) => {
      listener(themeState);
    };

    ipcRenderer.on(THEME_STATE_CHANNEL, handler);

    return () => {
      ipcRenderer.removeListener(THEME_STATE_CHANNEL, handler);
    };
  },
  getAppState: () => ipcRenderer.invoke("lithium:get-app-state"),
  pickWorkspace: () => ipcRenderer.invoke("lithium:pick-workspace"),
  connectRemoteWorkspace: (request: RemoteWorkspaceConnectRequest) =>
    ipcRenderer.invoke("lithium:connect-remote-workspace", request),
  syncRemoteWorkspace: (request?: RemoteWorkspaceSyncRequest) =>
    ipcRenderer.invoke("lithium:sync-remote-workspace", request),
  pickAttachmentFiles: (workspacePath?: string) =>
    ipcRenderer.invoke("lithium:pick-attachment-files", workspacePath),
  initProject: (workspacePath?: string) => ipcRenderer.invoke("lithium:init-project", workspacePath),
  getProjectSnapshot: (workspacePath?: string) =>
    ipcRenderer.invoke("lithium:get-project-snapshot", workspacePath),
  createThread: (request?: ThreadCreateRequest) =>
    ipcRenderer.invoke("lithium:create-thread", request),
  selectThread: (request: ThreadSelectionRequest) =>
    ipcRenderer.invoke("lithium:select-thread", request),
  renameThread: (request: ThreadRenameRequest) =>
    ipcRenderer.invoke("lithium:rename-thread", request),
  updateThreadMemory: (request: ThreadMemoryUpdateRequest) =>
    ipcRenderer.invoke("lithium:update-thread-memory", request),
  deleteThread: (request: ThreadDeleteRequest) =>
    ipcRenderer.invoke("lithium:delete-thread", request),
  getProjectMemory: (workspacePath?: string) =>
    ipcRenderer.invoke("lithium:get-project-memory", workspacePath),
  updateProjectMemory: (request: ProjectMemoryUpdate) =>
    ipcRenderer.invoke("lithium:update-project-memory", request),
  createAutomationSession: (request: AutomationSessionCreateRequest) =>
    ipcRenderer.invoke("lithium:create-automation-session", request),
  startAutomationSession: (request: AutomationSessionControlRequest) =>
    ipcRenderer.invoke("lithium:start-automation-session", request),
  pauseAutomationSession: (request: AutomationSessionControlRequest) =>
    ipcRenderer.invoke("lithium:pause-automation-session", request),
  resumeAutomationSession: (request: AutomationSessionControlRequest) =>
    ipcRenderer.invoke("lithium:resume-automation-session", request),
  interruptAutomationSession: (request: AutomationInterruptRequest) =>
    ipcRenderer.invoke("lithium:interrupt-automation-session", request),
  approveAutomationCheckpoint: (request: AutomationCheckpointApprovalRequest) =>
    ipcRenderer.invoke("lithium:approve-automation-checkpoint", request),
  beginStrategistSignIn: () => ipcRenderer.invoke("lithium:begin-strategist-sign-in"),
  sendChatMessage: (request: ChatRequest) =>
    ipcRenderer.invoke("lithium:send-chat-message", request),
  consultStrategist: (request: StrategistRequest) =>
    ipcRenderer.invoke("lithium:consult-strategist", request),
  inspectChatProgress: (request) =>
    ipcRenderer.invoke("lithium:inspect-chat-progress", request),
  runStrategistBrowserProbe: (request) =>
    ipcRenderer.invoke("lithium:run-strategist-browser-probe", request),
  startBuilderTask: (request: BuilderRequest) =>
    ipcRenderer.invoke("lithium:start-builder-task", request),
  runBuilderTask: (request: BuilderRequest) =>
    ipcRenderer.invoke("lithium:run-builder-task", request),
  inspectBuilderRun: (request: BuilderRunControlRequest) =>
    ipcRenderer.invoke("lithium:inspect-builder-run", request),
  terminateBuilderRun: (request: BuilderRunControlRequest) =>
    ipcRenderer.invoke("lithium:terminate-builder-run", request),
  finalizeBuilderRun: (request: BuilderRunControlRequest) =>
    ipcRenderer.invoke("lithium:finalize-builder-run", request),
  updateManuscript: (workspacePath?: string) =>
    ipcRenderer.invoke("lithium:update-manuscript", workspacePath),
  compilePaper: (workspacePath?: string) => ipcRenderer.invoke("lithium:compile-paper", workspacePath),
  importAttachments: (request: AttachmentImportRequest) =>
    ipcRenderer.invoke("lithium:import-attachments", request),
  removeAttachment: (request: AttachmentDeleteRequest) =>
    ipcRenderer.invoke("lithium:remove-attachment", request),
  listWorkspaceFiles: (workspacePath?: string) =>
    ipcRenderer.invoke("lithium:list-workspace-files", workspacePath),
  readWorkspaceFile: (request: WorkspaceFileRequest) =>
    ipcRenderer.invoke("lithium:read-workspace-file", request),
  readWorkspaceFileBytes: (request: WorkspaceFileRequest) =>
    ipcRenderer.invoke("lithium:read-workspace-file-bytes", request),
  readWorkspaceDiff: (request: WorkspaceDiffRequest) =>
    ipcRenderer.invoke("lithium:read-workspace-diff", request),
  saveWorkspaceFile: (request: WorkspaceFileWriteRequest) =>
    ipcRenderer.invoke("lithium:save-workspace-file", request),
  resolvePaperSyncTarget: (request: PaperSyncTargetRequest) =>
    ipcRenderer.invoke("lithium:resolve-paper-sync-target", request),
  resolvePaperSourceTarget: (request: PaperSourceTargetRequest) =>
    ipcRenderer.invoke("lithium:resolve-paper-source-target", request),
  createTerminalSession: (request: TerminalSessionCreateRequest) =>
    ipcRenderer.invoke("lithium:create-terminal-session", request),
  getTerminalSession: (request: TerminalSessionRequest) =>
    ipcRenderer.invoke("lithium:get-terminal-session", request),
  writeTerminalInput: (request: TerminalSessionInputRequest) =>
    ipcRenderer.invoke("lithium:write-terminal-input", request),
  resizeTerminalSession: (request: TerminalSessionResizeRequest) =>
    ipcRenderer.invoke("lithium:resize-terminal-session", request),
  closeTerminalSession: (request: TerminalSessionRequest) =>
    ipcRenderer.invoke("lithium:close-terminal-session", request),
  onTerminalEvent: (listener) => {
    const handler = (_event: unknown, terminalEvent: TerminalEvent) => {
      listener(terminalEvent);
    };

    ipcRenderer.on(TERMINAL_EVENT_CHANNEL, handler);

    return () => {
      ipcRenderer.removeListener(TERMINAL_EVENT_CHANNEL, handler);
    };
  },
  onAppCommand: (listener) => {
    const handler = (_event: unknown, command: AppCommand) => {
      listener(command);
    };

    ipcRenderer.on(APP_COMMAND_CHANNEL, handler);

    return () => {
      ipcRenderer.removeListener(APP_COMMAND_CHANNEL, handler);
    };
  },
  updateAppSettings: (request: AppSettingsUpdate) =>
    ipcRenderer.invoke("lithium:update-app-settings", request),
  toggleFullscreen: () => ipcRenderer.invoke("lithium:toggle-fullscreen")
};

contextBridge.exposeInMainWorld("lithium", api);
