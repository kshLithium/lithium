import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from "electron";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppCommand,
  type InitialThemeState,
  type ResolvedTheme,
  type ThemePreference
} from "../shared/types";
import { TERMINAL_FEATURE_ENABLED } from "../shared/feature-flags";
import { AppService } from "./services/app-service";
import { AppSettingsStore, sanitizeThemePreference } from "./services/app-settings-store";
import { detectChromePath } from "./services/chrome-detection";
import { DiscordBotService, resolveDiscordBotConfig } from "./services/discord-bot-service";
import { stopAllLiveProcesses } from "./services/live-process-registry";
import { MobileBridgeServer } from "./services/mobile-bridge-server";
import { onLiveTerminalEvent, stopAllLiveTerminals } from "./services/terminal-pty-registry";
import {
  APP_PROTOCOL,
  isSafeExternalUrl,
  isTrustedAppUrl,
  resolveAppEntryUrl,
  resolveBundledAssetPath,
  resolveInitialSurface,
  resolveSurfaceUrl,
  resolveWindowBackgroundColor,
  type InitialSurface
} from "./services/window-policy";
import { MOBILE_BRIDGE_FEATURE_ENABLED, MOBILE_BRIDGE_PORT } from "../shared/feature-flags";

const DEFAULT_WORKSPACE_PATH = process.env.LITHIUM_WORKSPACE ?? "";
const INITIAL_SURFACE = resolveInitialSurface(process.env.LITHIUM_INITIAL_SURFACE);
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const APP_COMMAND_CHANNEL = "lithium:app-command";
const TERMINAL_EVENT_CHANNEL = "lithium:terminal-event";
const THEME_STATE_CHANNEL = "lithium:theme-state";
const APP_ICON_PATH = resolveAppIconPath();
const APP_NAME = process.env.LITHIUM_APP_NAME?.trim() || (app.isPackaged ? "Lithium" : "Lithium Dev");
const RUNTIME_CAPABILITY_CACHE_TTL_MS = 30_000;
let lastKnownThemePreference: ThemePreference = DEFAULT_APP_SETTINGS.themePreference;
app.setName(APP_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_NAME));
const appSettingsStore = new AppSettingsStore(
  path.join(app.getPath("userData"), "settings.json"),
  path.join(app.getPath("userData"), "app-settings.json")
);
const appService = new AppService(DEFAULT_WORKSPACE_PATH, {
  remoteWorkspaceRoot: path.join(app.getPath("userData"), "remote-workspaces"),
  onSelectedWorkspacePathChange: (workspacePath) => {
    void appSettingsStore.update({ lastWorkspacePath: workspacePath });
  },
  getAppSettings: () => appSettingsStore.read()
});
const discordBotService = new DiscordBotService({
  bridge: {
    resolveWorkspacePath: async () => {
      const settings = await appSettingsStore.read();
      const configuredWorkspace =
        settings.discordBot.workspacePath.trim() ||
        process.env.LITHIUM_DISCORD_WORKSPACE?.trim() ||
        process.env.LITHIUM_WORKSPACE?.trim() ||
        "";

      if (configuredWorkspace) {
        return configuredWorkspace;
      }

      return settings.lastWorkspacePath.trim();
    },
    getSnapshot: async (workspacePath) => appService.getSnapshot(workspacePath),
    createThread: async (request) => appService.createThread(request),
    sendChatMessage: async (request) => {
      const settings = await appSettingsStore.read();
      const snapshot = await appService.sendChatMessage(request, {
        strategistSessionReady: settings.strategistSessionReady
      });

      if (!settings.strategistSessionReady && snapshot.latestDecision) {
        await appSettingsStore.update({ strategistSessionReady: true });
      }

      return snapshot;
    },
    inspectBuilderRun: async (request) => appService.inspectBuilderRun(request)
  },
  log: (message) => {
    console.log(message);
  }
});
const mobileBridgeServer = new MobileBridgeServer({
  staticRoot: path.join(__dirname, "../dist-mobile"),
  port: MOBILE_BRIDGE_PORT,
  getAppState: async () => getRuntimeAppState(),
  getProjectSnapshot: async (workspacePath) => appService.getSnapshot(workspacePath),
  createThread: async (request) => appService.createThread(request),
  selectThread: async (request) => appService.selectThread(request),
  sendChatMessage: async (request) => {
    const settings = await appSettingsStore.read();
    const snapshot = await appService.sendChatMessage(request, {
      strategistSessionReady: settings.strategistSessionReady
    });

    if (!settings.strategistSessionReady && snapshot.latestDecision) {
      await appSettingsStore.update({ strategistSessionReady: true });
    }

    return snapshot;
  },
  createAutomationSession: async (request) => appService.createAutomationSession(request),
  startAutomationSession: async (request) => appService.startAutomationSession(request),
  pauseAutomationSession: async (request) => appService.pauseAutomationSession(request),
  resumeAutomationSession: async (request) => appService.resumeAutomationSession(request),
  interruptAutomationSession: async (request) => appService.interruptAutomationSession(request),
  inspectChatProgress: async (request) => appService.inspectChatProgress(request),
  log: (message) => {
    console.log(message);
  }
});
const DIST_ROOT = path.join(__dirname, "../dist");
if (process.platform === "win32") {
  app.setAppUserModelId(
    app.isPackaged ? "dev.lithium.app" : "dev.lithium.app.dev"
  );
}

ipcMain.on("lithium:get-initial-theme-state", (event) => {
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL() ?? "";

  if (senderUrl && !isTrustedAppUrl(senderUrl, DEV_SERVER_URL)) {
    event.returnValue = resolveInitialThemeState(DEFAULT_APP_SETTINGS.themePreference);
    return;
  }

  event.returnValue = resolveInitialThemeState(lastKnownThemePreference);
});

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

async function commandExists(command: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn("which", [command], {
      stdio: "ignore"
    });

    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

type AsyncCapabilityCache<T> = {
  expiresAt: number;
  value?: T;
  promise?: Promise<T>;
};

const commandExistsCache = new Map<string, AsyncCapabilityCache<boolean>>();
const chromePathCache: AsyncCapabilityCache<string | null> = {
  expiresAt: 0
};

async function resolveCachedCapability<T>(
  cache: AsyncCapabilityCache<T>,
  loader: () => Promise<T>,
  ttlMs = RUNTIME_CAPABILITY_CACHE_TTL_MS
) {
  const now = Date.now();

  if (cache.value !== undefined && cache.expiresAt > now) {
    return cache.value;
  }

  if (!cache.promise) {
    cache.promise = loader()
      .then((value) => {
        cache.value = value;
        cache.expiresAt = Date.now() + ttlMs;
        return value;
      })
      .finally(() => {
        cache.promise = undefined;
      });
  }

  return await cache.promise;
}

async function getCachedCommandExists(command: string) {
  const cache = commandExistsCache.get(command) ?? {
    expiresAt: 0
  };
  commandExistsCache.set(command, cache);
  return await resolveCachedCapability(cache, async () => await commandExists(command));
}

async function getCachedChromePath() {
  return await resolveCachedCapability(chromePathCache, async () => (await detectChromePath()) ?? null);
}

async function getRuntimeAppState() {
  const settings = await appSettingsStore.read();
  return appService.getAppState({
    platform: process.platform,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    cwd: process.cwd(),
    oracleReady: await getCachedCommandExists("npx"),
    codexReady: await getCachedCommandExists("codex"),
    oracleChromePath: await getCachedChromePath(),
    discordBotStatus: discordBotService.getStatus(),
    settings
  });
}

async function reconfigureDiscordBot(settings: AppSettings) {
  try {
    await discordBotService.configure(resolveDiscordBotConfig(settings.discordBot, process.env));
  } catch (error) {
    console.error(`[discord] failed to configure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: APP_NAME,
    backgroundColor: resolveWindowBackgroundColor(
      nativeTheme.themeSource as ThemePreference,
      nativeTheme.shouldUseDarkColors
    ),
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

  if (DEV_SERVER_URL) {
    void win.loadURL(resolveSurfaceUrl(DEV_SERVER_URL, INITIAL_SURFACE));
  } else {
    void win.loadURL(resolveAppEntryUrl(INITIAL_SURFACE));
  }

  win.once("ready-to-show", () => {
    win.show();
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

    const isBackquote = input.code === "Backquote" || input.key === "`" || input.key === "~";

    if (input.control && input.shift && isBackquote) {
      event.preventDefault();
      if (TERMINAL_FEATURE_ENABLED) {
        win.webContents.send(APP_COMMAND_CHANNEL, "toggle-terminal" satisfies AppCommand);
      }
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

    if (key === "s" && !input.shift) {
      event.preventDefault();
      win.webContents.send(APP_COMMAND_CHANNEL, "save-current-surface" satisfies AppCommand);
      return;
    }

    if (key === "t" && !input.shift) {
      event.preventDefault();
      win.webContents.send(APP_COMMAND_CHANNEL, "open-new-thread" satisfies AppCommand);
      return;
    }

    if (key === "n" && !input.shift) {
      event.preventDefault();
      win.webContents.send(APP_COMMAND_CHANNEL, "new-code-file" satisfies AppCommand);
      return;
    }

    if (key === "," && !input.shift) {
      event.preventDefault();
      win.webContents.send(APP_COMMAND_CHANNEL, "open-settings" satisfies AppCommand);
      return;
    }

    if (key === "b" && !input.shift) {
      event.preventDefault();
      win.webContents.send(APP_COMMAND_CHANNEL, "toggle-sidebar" satisfies AppCommand);
      return;
    }
  });
}

function applyNativeThemePreference(value: string) {
  nativeTheme.themeSource = sanitizeThemePreference(value);
}

function resolveSystemTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function resolveInitialThemeState(themePreference: ThemePreference): InitialThemeState {
  const systemTheme = resolveSystemTheme();
  const resolvedTheme: ResolvedTheme = themePreference === "system" ? systemTheme : themePreference;

  return {
    themePreference,
    resolvedTheme,
    systemTheme
  };
}

function broadcastThemeState(themePreference: ThemePreference) {
  const themeState = resolveInitialThemeState(themePreference);

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(THEME_STATE_CHANNEL, themeState);
  }
}

function resolveAppIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "build", "icon.png");
  }

  return path.join(process.cwd(), "build", "icon.png");
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
  lastKnownThemePreference = settings.themePreference;
  applyNativeThemePreference(settings.themePreference);
  await reconfigureDiscordBot(settings);

  if (!DEFAULT_WORKSPACE_PATH && settings.lastWorkspacePath.trim()) {
    appService.setSelectedWorkspacePath(settings.lastWorkspacePath.trim());
  }

  if (MOBILE_BRIDGE_FEATURE_ENABLED) {
    try {
      await mobileBridgeServer.start();
    } catch (error) {
      console.error(
        `[mobile] failed to start bridge: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  nativeTheme.on("updated", () => {
    const nextBackground = resolveWindowBackgroundColor(
      nativeTheme.themeSource as ThemePreference,
      nativeTheme.shouldUseDarkColors
    );

    for (const win of BrowserWindow.getAllWindows()) {
      win.setBackgroundColor(nextBackground);
    }

    broadcastThemeState(lastKnownThemePreference);
  });

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

  onLiveTerminalEvent((terminalEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(TERMINAL_EVENT_CHANNEL, terminalEvent);
    }
  });

  registerIpcHandle("lithium:get-app-state", async () => getRuntimeAppState());

  registerIpcHandle("lithium:update-app-settings", async (_event, request) => {
    const settings = await appSettingsStore.update(request);
    lastKnownThemePreference = settings.themePreference;
    applyNativeThemePreference(settings.themePreference);
    await reconfigureDiscordBot(settings);
    const nextBackground = resolveWindowBackgroundColor(
      settings.themePreference,
      nativeTheme.shouldUseDarkColors
    );

    for (const win of BrowserWindow.getAllWindows()) {
      win.setBackgroundColor(nextBackground);
    }

    broadcastThemeState(settings.themePreference);

    return settings;
  });

  registerIpcHandle("lithium:pick-workspace", async () => {
    const currentState = await getRuntimeAppState();
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      defaultPath: currentState.selectedWorkspacePath || app.getPath("documents")
    });

    if (!result.canceled && result.filePaths[0]) {
      return appService.setSelectedWorkspacePath(result.filePaths[0]);
    }

    return {
      selectedWorkspacePath: currentState.selectedWorkspacePath
    };
  });

  registerIpcHandle("lithium:connect-remote-workspace", async (_event, request) => {
    const settings = await appSettingsStore.read();
    const profile = settings.remoteWorkspaceProfiles.find((entry) => entry.id === request.profileId);

    if (!profile) {
      throw new Error("Remote workspace profile not found.");
    }

    return await appService.connectRemoteWorkspace(profile);
  });

  registerIpcHandle("lithium:sync-remote-workspace", async (_event, request) => {
    return await appService.syncRemoteWorkspace(request?.workspacePath);
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

  registerIpcHandle("lithium:init-project", async (_event, workspacePath?: string) => {
    return appService.initProject(workspacePath);
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

  registerIpcHandle("lithium:rename-thread", async (_event, request) => {
    return appService.renameThread(request);
  });

  registerIpcHandle("lithium:update-thread-memory", async (_event, request) => {
    return appService.updateThreadMemory(request);
  });

  registerIpcHandle("lithium:delete-thread", async (_event, request) => {
    return appService.deleteThread(request);
  });

  registerIpcHandle("lithium:get-project-memory", async (_event, workspacePath?: string) => {
    return appService.getProjectMemory(workspacePath);
  });

  registerIpcHandle("lithium:update-project-memory", async (_event, request) => {
    return appService.updateProjectMemory(request);
  });

  registerIpcHandle("lithium:create-automation-session", async (_event, request) => {
    return appService.createAutomationSession(request);
  });

  registerIpcHandle("lithium:start-automation-session", async (_event, request) => {
    return appService.startAutomationSession(request);
  });

  registerIpcHandle("lithium:pause-automation-session", async (_event, request) => {
    return appService.pauseAutomationSession(request);
  });

  registerIpcHandle("lithium:resume-automation-session", async (_event, request) => {
    return appService.resumeAutomationSession(request);
  });

  registerIpcHandle("lithium:interrupt-automation-session", async (_event, request) => {
    return appService.interruptAutomationSession(request);
  });

  registerIpcHandle("lithium:approve-automation-checkpoint", async (_event, request) => {
    return appService.approveAutomationCheckpoint(request);
  });

  registerIpcHandle("lithium:begin-strategist-sign-in", async () => {
    await appSettingsStore.update({ strategistSessionReady: false });
    await appService.beginStrategistSignIn();
    return await appSettingsStore.update({ strategistSessionReady: true });
  });

  registerIpcHandle("lithium:send-chat-message", async (_event, request) => {
    const settings = await appSettingsStore.read();
    const snapshot = await appService.sendChatMessage(request, {
      strategistSessionReady: settings.strategistSessionReady
    });

    if (!settings.strategistSessionReady && snapshot.latestDecision) {
      await appSettingsStore.update({ strategistSessionReady: true });
    }

    return snapshot;
  });

  registerIpcHandle("lithium:consult-strategist", async (_event, request) => {
    const settings = await appSettingsStore.read();
    const snapshot = await appService.consultStrategist(request, {
      strategistSessionReady: settings.strategistSessionReady
    });

    if (!settings.strategistSessionReady) {
      await appSettingsStore.update({ strategistSessionReady: true });
    }

    return snapshot;
  });

  registerIpcHandle("lithium:inspect-chat-progress", async (_event, request) => {
    return appService.inspectChatProgress(request);
  });

  registerIpcHandle("lithium:run-strategist-browser-probe", async (_event, request) => {
    const settings = await appSettingsStore.read();
    const response = await appService.runStrategistBrowserProbe(request, {
      strategistSessionReady: settings.strategistSessionReady
    });

    if (!settings.strategistSessionReady && response.ok && response.snapshot.latestDecision) {
      await appSettingsStore.update({ strategistSessionReady: true });
    }

    return response;
  });

  registerIpcHandle("lithium:start-builder-task", async (_event, request) => {
    return appService.startBuilderTask(request);
  });

  registerIpcHandle("lithium:run-builder-task", async (_event, request) => {
    return appService.runBuilderTask(request);
  });

  registerIpcHandle("lithium:inspect-builder-run", async (_event, request) => {
    return appService.inspectBuilderRun(request);
  });

  registerIpcHandle("lithium:terminate-builder-run", async (_event, request) => {
    return appService.terminateBuilderRun(request);
  });

  registerIpcHandle("lithium:finalize-builder-run", async (_event, request) => {
    return appService.finalizeBuilderRun(request);
  });

  registerIpcHandle("lithium:update-manuscript", async (_event, workspacePath?: string) => {
    return appService.updateManuscript(workspacePath);
  });

  registerIpcHandle("lithium:compile-paper", async (_event, workspacePath?: string) => {
    return appService.compilePaper(workspacePath);
  });

  registerIpcHandle("lithium:import-attachments", async (_event, request) => {
    return appService.importAttachments(request);
  });

  registerIpcHandle("lithium:remove-attachment", async (_event, request) => {
    return appService.removeAttachment(request);
  });

  registerIpcHandle("lithium:list-workspace-files", async (_event, workspacePath?: string) => {
    return appService.listWorkspaceFiles(workspacePath);
  });

  registerIpcHandle("lithium:read-workspace-file", async (_event, request) => {
    return appService.readWorkspaceFile(request);
  });

  registerIpcHandle("lithium:read-workspace-file-bytes", async (_event, request) => {
    return appService.readWorkspaceFileBytes(request);
  });

  registerIpcHandle("lithium:read-workspace-diff", async (_event, request) => {
    return appService.readWorkspaceDiff(request);
  });

  registerIpcHandle("lithium:save-workspace-file", async (_event, request) => {
    return appService.saveWorkspaceFile(request);
  });

  registerIpcHandle("lithium:resolve-paper-sync-target", async (_event, request) => {
    return appService.resolvePaperSyncTarget(request);
  });

  registerIpcHandle("lithium:resolve-paper-source-target", async (_event, request) => {
    return appService.resolvePaperSourceTarget(request);
  });

  registerIpcHandle("lithium:create-terminal-session", async (_event, request) => {
    return appService.createTerminalSession(request);
  });

  registerIpcHandle("lithium:get-terminal-session", async (_event, request) => {
    return appService.getTerminalSession(request);
  });

  registerIpcHandle("lithium:write-terminal-input", async (_event, request) => {
    return appService.writeTerminalInput(request);
  });

  registerIpcHandle("lithium:resize-terminal-session", async (_event, request) => {
    return appService.resizeTerminalSession(request);
  });

  registerIpcHandle("lithium:close-terminal-session", async (_event, request) => {
    return appService.closeTerminalSession(request);
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
  stopAllLiveTerminals();
  void discordBotService.stop("shutdown");
  void mobileBridgeServer.stop();
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
    default:
      return "application/octet-stream";
  }
}
