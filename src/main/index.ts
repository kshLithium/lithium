import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppCommand
} from "../shared/types";
import { AppService } from "./services/app-service";
import { AppSettingsStore } from "./services/app-settings-store";
import { stopAllLiveProcesses } from "./services/live-process-registry";
import { stopAllLiveShells } from "./services/live-shell-registry";
import { OrchestratorRunner } from "./services/orchestrator-runner";
import { ResidentOrchestratorRunner } from "./services/resident-orchestrator-runner";
import {
  APP_PROTOCOL,
  isSafeExternalUrl,
  isTrustedAppUrl,
  resolveAppEntryUrl,
  resolveBundledAssetPath,
  resolveRendererUrl
} from "./services/window-policy";

const DEFAULT_WORKSPACE_PATH = process.env.LITHIUM_WORKSPACE ?? "";
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const APP_COMMAND_CHANNEL = "lithium:app-command";
const APP_ICON_PATH = resolveAppIconPath();
const APP_NAME = process.env.LITHIUM_APP_NAME?.trim() || (app.isPackaged ? "Lithium" : "Lithium Dev");
const windowReadiness = new WeakMap<BrowserWindow, { readyToShow: boolean; rendererReady: boolean }>();
app.setName(APP_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_NAME));
const appSettingsStore = new AppSettingsStore(path.join(app.getPath("userData"), "settings.json"));
const appService = new AppService(DEFAULT_WORKSPACE_PATH, {
  orchestratorRunner: new ResidentOrchestratorRunner(new OrchestratorRunner()),
  onSelectedWorkspacePathChange: (workspacePath) => {
    void appSettingsStore.update({ lastWorkspacePath: workspacePath });
  },
  getAppSettings: () => appSettingsStore.read()
});
const DIST_ROOT = path.join(__dirname, "../dist");
if (process.platform === "win32") {
  app.setAppUserModelId(
    app.isPackaged ? "dev.lithium.app" : "dev.lithium.app.dev"
  );
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

async function getRuntimeAppState() {
  const settings = await appSettingsStore.read();
  return appService.getAppState({
    platform: process.platform,
    settings
  });
}

async function withStrategistSessionState<T>(
  work: (settings: AppSettings) => Promise<T>,
  shouldMarkReady: (result: T) => boolean
) {
  const settings = await appSettingsStore.read();
  const result = await work(settings);

  if (!settings.strategistSessionReady && shouldMarkReady(result)) {
    await appSettingsStore.update({ strategistSessionReady: true });
  }

  return result;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: APP_NAME,
    backgroundColor: "#ffffff",
    icon: APP_ICON_PATH,
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    trafficLightPosition:
      process.platform === "darwin"
        ? {
            x: 18,
            y: 18
          }
        : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  windowReadiness.set(win, {
    readyToShow: false,
    rendererReady: false
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(resolveRendererUrl(DEV_SERVER_URL));
  } else {
    void win.loadURL(resolveAppEntryUrl());
  }

  win.once("ready-to-show", () => {
    const readiness = windowReadiness.get(win);

    if (!readiness) {
      win.show();
      return;
    }

    readiness.readyToShow = true;
    maybeShowWindow(win);
  });
  win.on("closed", () => {
    windowReadiness.delete(win);
  });

  if (process.env.LITHIUM_DEBUG_WINDOW === "1") {
    win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      console.log(`[renderer:fail-load] ${errorCode} ${errorDescription} ${validatedUrl}`);
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      console.log(`[renderer:gone] ${details.reason} exitCode=${details.exitCode}`);
    });
    win.webContents.openDevTools({ mode: "detach" });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url, DEV_SERVER_URL)) {
      event.preventDefault();
    }
  });

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") {
      return;
    }

    const hasPrimaryModifier = process.platform === "darwin" ? input.meta : input.control;

    if (!hasPrimaryModifier || input.alt) {
      return;
    }

    const key = input.key.toLowerCase();

    if (key === "o") {
      event.preventDefault();
      win.webContents.send(APP_COMMAND_CHANNEL, "open-workspace" satisfies AppCommand);
      return;
    }

    if (key === "t" && !input.shift) {
      event.preventDefault();
      win.webContents.send(APP_COMMAND_CHANNEL, "open-new-thread" satisfies AppCommand);
      return;
    }

    if (key === "b" && !input.shift) {
      event.preventDefault();
      win.webContents.send(APP_COMMAND_CHANNEL, "toggle-sidebar" satisfies AppCommand);
      return;
    }
  });
}

function resolveAppIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "build", "icon.png");
  }

  return path.join(process.cwd(), "build", "icon.png");
}

function maybeShowWindow(win: BrowserWindow) {
  const readiness = windowReadiness.get(win);

  if (!readiness || !readiness.readyToShow || !readiness.rendererReady || win.isVisible()) {
    return;
  }

  win.show();
}

function registerIpcHandle(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any
) {
  ipcMain.handle(channel, async (event, ...args) => {
    const senderUrl = event.senderFrame?.url ?? "";

    if (senderUrl && !isTrustedAppUrl(senderUrl, DEV_SERVER_URL)) {
      throw new Error(`Blocked IPC from untrusted renderer: ${senderUrl || "unknown"}`);
    }

    return await handler(event, ...args);
  });
}

function installApplicationMenu() {
  if (process.platform !== "darwin") {
    return;
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        {
          label: `About ${APP_NAME}`,
          role: "about"
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  protocol.handle(APP_PROTOCOL, async (request) => {
    const assetPath = resolveBundledAssetPath(request.url, DIST_ROOT);
    const body = await readFile(assetPath);
    return new Response(body, {
      headers: {
        "content-type": contentTypeForAsset(assetPath)
      }
    });
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  const settings = await appSettingsStore.read();

  if (!DEFAULT_WORKSPACE_PATH && settings.lastWorkspacePath.trim()) {
    appService.setSelectedWorkspacePath(settings.lastWorkspacePath.trim());
  }

  if (process.platform === "darwin" && APP_ICON_PATH && app.dock) {
    const dockIcon = nativeImage.createFromPath(APP_ICON_PATH).resize({
      width: 512,
      height: 512,
      quality: "best"
    });
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }

  installApplicationMenu();

  registerIpcHandle("lithium:get-app-state", async () => getRuntimeAppState());
  registerIpcHandle("lithium:renderer-ready", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    if (!win) {
      return;
    }

    const readiness = windowReadiness.get(win);

    if (!readiness) {
      win.show();
      return;
    }

    readiness.rendererReady = true;
    maybeShowWindow(win);
  });

  registerIpcHandle("lithium:pick-workspace", async () => {
    const currentState = await getRuntimeAppState();
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      defaultPath: currentState.selectedWorkspacePath || app.getPath("documents")
    });

    if (!result.canceled && result.filePaths[0]) {
      const selectedWorkspacePath = result.filePaths[0];
      appService.setSelectedWorkspacePath(selectedWorkspacePath);
      await appService.initProject(selectedWorkspacePath);
      return { selectedWorkspacePath };
    }

    return {
      selectedWorkspacePath: currentState.selectedWorkspacePath
    };
  });

  registerIpcHandle("lithium:pick-attachment-files", async (_event, workspacePath?: string) => {
    const currentState = await getRuntimeAppState();
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      defaultPath: workspacePath || currentState.selectedWorkspacePath || app.getPath("documents")
    });

    if (result.canceled) {
      return [];
    }

    return result.filePaths;
  });

  registerIpcHandle("lithium:get-project-snapshot", async (_event, workspacePath?: string) => {
    return appService.getSnapshot(workspacePath);
  });

  registerIpcHandle("lithium:create-thread", async (_event, request) => {
    return appService.createThread(request);
  });

  registerIpcHandle("lithium:select-thread", async (_event, request) => {
    return appService.selectThread(request);
  });

  registerIpcHandle(
    "lithium:send-chat-message",
    async (_event, request) =>
      await withStrategistSessionState(
        async (settings) =>
          await appService.sendChatMessage(request, {
            strategistSessionReady: settings.strategistSessionReady
          }),
        (snapshot) => Boolean(snapshot.latestDecision)
      )
  );

  registerIpcHandle("lithium:inspect-chat-progress", async (_event, request) => {
    return appService.inspectChatProgress(request);
  });

  registerIpcHandle("lithium:import-attachments", async (_event, request) => {
    return appService.importAttachments(request);
  });

  registerIpcHandle("lithium:remove-attachment", async (_event, request) => {
    return appService.removeAttachment(request);
  });

  registerIpcHandle("lithium:toggle-fullscreen", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    if (!win) {
      return false;
    }

    const nextState = !win.isFullScreen();
    win.setFullScreen(nextState);
    return nextState;
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopAllLiveProcesses();
  stopAllLiveShells();
});

function contentTypeForAsset(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".woff2":
      return "font/woff2";
    case ".pdf":
      return "application/pdf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".rtf":
      return "application/rtf";
    case ".odt":
      return "application/vnd.oasis.opendocument.text";
    case ".ods":
      return "application/vnd.oasis.opendocument.spreadsheet";
    case ".odp":
      return "application/vnd.oasis.opendocument.presentation";
    default:
      return "application/octet-stream";
  }
}
