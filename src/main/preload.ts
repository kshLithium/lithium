import { contextBridge, ipcRenderer } from "electron";
import type {
  AttachmentDeleteRequest,
  AttachmentImportRequest,
  AppCommand,
  ChatRequest,
  LithiumApi,
  ThreadCreateRequest,
  ThreadSelectionRequest
} from "../shared/types";

const APP_COMMAND_CHANNEL = "lithium:app-command";

const api: LithiumApi = {
  getAppState: () => ipcRenderer.invoke("lithium:get-app-state"),
  notifyShellReady: () => ipcRenderer.invoke("lithium:renderer-ready"),
  pickWorkspace: () => ipcRenderer.invoke("lithium:pick-workspace"),
  pickAttachmentFiles: (workspacePath?: string) =>
    ipcRenderer.invoke("lithium:pick-attachment-files", workspacePath),
  getProjectSnapshot: (workspacePath?: string) =>
    ipcRenderer.invoke("lithium:get-project-snapshot", workspacePath),
  createThread: (request?: ThreadCreateRequest) =>
    ipcRenderer.invoke("lithium:create-thread", request),
  selectThread: (request: ThreadSelectionRequest) =>
    ipcRenderer.invoke("lithium:select-thread", request),
  sendChatMessage: (request: ChatRequest) =>
    ipcRenderer.invoke("lithium:send-chat-message", request),
  inspectChatProgress: (request) =>
    ipcRenderer.invoke("lithium:inspect-chat-progress", request),
  importAttachments: (request: AttachmentImportRequest) =>
    ipcRenderer.invoke("lithium:import-attachments", request),
  removeAttachment: (request: AttachmentDeleteRequest) =>
    ipcRenderer.invoke("lithium:remove-attachment", request),
  onAppCommand: (listener) => {
    const handler = (_event: unknown, command: AppCommand) => {
      listener(command);
    };

    ipcRenderer.on(APP_COMMAND_CHANNEL, handler);

    return () => {
      ipcRenderer.removeListener(APP_COMMAND_CHANNEL, handler);
    };
  },
  toggleFullscreen: () => ipcRenderer.invoke("lithium:toggle-fullscreen")
};

contextBridge.exposeInMainWorld("lithium", api);
