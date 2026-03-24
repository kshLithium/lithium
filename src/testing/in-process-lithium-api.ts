import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppSettingsUpdate,
  type InitialThemeState,
  type LithiumApi,
  type ResolvedTheme,
  type RuntimeAppState
} from "../shared/types";
import { AppService } from "../main/services/app-service";

type InProcessRuntimeOverrides = Partial<
  Pick<
    RuntimeAppState,
    | "platform"
    | "electronVersion"
    | "chromeVersion"
    | "nodeVersion"
    | "cwd"
    | "oracleReady"
    | "codexReady"
    | "oracleChromePath"
    | "discordBotStatus"
  >
>;

type InProcessLithiumApiOptions = {
  appService: AppService;
  settings?: Partial<AppSettings>;
  runtime?: InProcessRuntimeOverrides;
  systemTheme?: ResolvedTheme;
  pickWorkspace?: () => Promise<string>;
  pickAttachmentFiles?: (workspacePath?: string) => Promise<string[]>;
};

export function createInProcessLithiumApi(
  options: InProcessLithiumApiOptions
): LithiumApi {
  const appService = options.appService;
  const themeListeners = new Set<(themeState: InitialThemeState) => void>();
  const systemTheme = options.systemTheme ?? "light";
  let settings = mergeSettings(cloneSettings(DEFAULT_APP_SETTINGS), options.settings ?? {});
  const runtime = {
    platform: "darwin",
    electronVersion: "40.8.2",
    chromeVersion: "144.0.0.0",
    nodeVersion: process.versions.node,
    cwd: process.cwd(),
    oracleReady: true,
    codexReady: true,
    oracleChromePath: null,
    discordBotStatus: {
      state: "disabled",
      botTag: "",
      botUserId: "",
      lastError: null,
      workspacePath: ""
    },
    ...options.runtime
  } satisfies Pick<
    RuntimeAppState,
    | "platform"
    | "electronVersion"
    | "chromeVersion"
    | "nodeVersion"
    | "cwd"
    | "oracleReady"
    | "codexReady"
    | "oracleChromePath"
    | "discordBotStatus"
  >;

  function resolveThemeState(themePreference = settings.themePreference): InitialThemeState {
    return {
      themePreference,
      resolvedTheme: themePreference === "system" ? systemTheme : themePreference,
      systemTheme
    };
  }

  function notifyThemeListeners() {
    const nextThemeState = resolveThemeState();

    for (const listener of themeListeners) {
      listener(nextThemeState);
    }
  }

  return {
    getInitialThemeState: () => resolveThemeState(),
    onThemeStateChange: (listener) => {
      themeListeners.add(listener);
      return () => {
        themeListeners.delete(listener);
      };
    },
    getAppState: async () =>
      await appService.getAppState({
        ...runtime,
        settings: cloneSettings(settings)
      }),
    pickWorkspace: async () => {
      const providedPath = await options.pickWorkspace?.();

      if (!providedPath?.trim()) {
        const runtimeState = await appService.getAppState({
          ...runtime,
          settings: cloneSettings(settings)
        });

        if (!runtimeState.selectedWorkspacePath) {
          throw new Error("No workspace picker is available in the in-process test API.");
        }

        return {
          selectedWorkspacePath: runtimeState.selectedWorkspacePath
        };
      }

      return appService.setSelectedWorkspacePath(providedPath);
    },
    connectRemoteWorkspace: async (request) => {
      const profile = settings.remoteWorkspaceProfiles.find((entry) => entry.id === request.profileId);

      if (!profile) {
        throw new Error(`Remote workspace profile not found: ${request.profileId}`);
      }

      return await appService.connectRemoteWorkspace(profile);
    },
    syncRemoteWorkspace: async (request) => await appService.syncRemoteWorkspace(request?.workspacePath),
    pickAttachmentFiles: async (workspacePath) => (await options.pickAttachmentFiles?.(workspacePath)) ?? [],
    initProject: async (workspacePath) => await appService.initProject(workspacePath),
    getProjectSnapshot: async (workspacePath) => await appService.getSnapshot(workspacePath),
    createThread: async (request) => await appService.createThread(request),
    selectThread: async (request) => await appService.selectThread(request),
    renameThread: async (request) => await appService.renameThread(request),
    updateThreadMemory: async (request) => await appService.updateThreadMemory(request),
    deleteThread: async (request) => await appService.deleteThread(request),
    getProjectMemory: async (workspacePath) => await appService.getProjectMemory(workspacePath),
    updateProjectMemory: async (request) => await appService.updateProjectMemory(request),
    createAutomationSession: async (request) => await appService.createAutomationSession(request),
    startAutomationSession: async (request) => await appService.startAutomationSession(request),
    pauseAutomationSession: async (request) => await appService.pauseAutomationSession(request),
    resumeAutomationSession: async (request) => await appService.resumeAutomationSession(request),
    interruptAutomationSession: async (request) => await appService.interruptAutomationSession(request),
    approveAutomationCheckpoint: async (request) => await appService.approveAutomationCheckpoint(request),
    beginStrategistSignIn: async () => {
      await appService.beginStrategistSignIn();
      settings = mergeSettings(settings, {
        strategistSessionReady: true
      });
      return cloneSettings(settings);
    },
    sendChatMessage: async (request) =>
      await appService.sendChatMessage(request, {
        strategistSessionReady: settings.strategistSessionReady
      }),
    consultStrategist: async (request) =>
      await appService.consultStrategist(request, {
        strategistSessionReady: settings.strategistSessionReady
      }),
    inspectChatProgress: async (request) => await appService.inspectChatProgress(request),
    runStrategistBrowserProbe: async (request) =>
      await appService.runStrategistBrowserProbe(request, {
        strategistSessionReady: settings.strategistSessionReady
      }),
    startBuilderTask: async (request) => await appService.startBuilderTask(request),
    runBuilderTask: async (request) => await appService.runBuilderTask(request),
    inspectBuilderRun: async (request) => await appService.inspectBuilderRun(request),
    terminateBuilderRun: async (request) => await appService.terminateBuilderRun(request),
    finalizeBuilderRun: async (request) => await appService.finalizeBuilderRun(request),
    updateManuscript: async (workspacePath) => await appService.updateManuscript(workspacePath),
    compilePaper: async (workspacePath) => await appService.compilePaper(workspacePath),
    importAttachments: async (request) => await appService.importAttachments(request),
    removeAttachment: async (request) => await appService.removeAttachment(request),
    listWorkspaceFiles: async (workspacePath) => await appService.listWorkspaceFiles(workspacePath),
    readWorkspaceFile: async (request) => await appService.readWorkspaceFile(request),
    readWorkspaceFileBytes: async (request) => await appService.readWorkspaceFileBytes(request),
    readWorkspaceDiff: async (request) => await appService.readWorkspaceDiff(request),
    saveWorkspaceFile: async (request) => await appService.saveWorkspaceFile(request),
    resolvePaperSyncTarget: async (request) => await appService.resolvePaperSyncTarget(request),
    resolvePaperSourceTarget: async (request) => await appService.resolvePaperSourceTarget(request),
    createTerminalSession: async (request) => await appService.createTerminalSession(request),
    getTerminalSession: async (request) => await appService.getTerminalSession(request),
    writeTerminalInput: async (request) => await appService.writeTerminalInput(request),
    resizeTerminalSession: async (request) => await appService.resizeTerminalSession(request),
    closeTerminalSession: async (request) => await appService.closeTerminalSession(request),
    onTerminalEvent: () => () => undefined,
    onAppCommand: () => () => undefined,
    updateAppSettings: async (request: AppSettingsUpdate) => {
      const previousThemePreference = settings.themePreference;
      settings = mergeSettings(settings, request);

      if (settings.themePreference !== previousThemePreference) {
        notifyThemeListeners();
      }

      return await appService.getAppState({
        ...runtime,
        settings: cloneSettings(settings)
      });
    },
    toggleFullscreen: async () => false
  };
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    discordBot: {
      ...settings.discordBot,
      allowedUserIds: [...settings.discordBot.allowedUserIds],
      allowedChannelIds: [...settings.discordBot.allowedChannelIds]
    },
    terminalConnectionProfiles: settings.terminalConnectionProfiles.map((profile) => ({ ...profile })),
    remoteWorkspaceProfiles: settings.remoteWorkspaceProfiles.map((profile) => ({ ...profile }))
  };
}

function mergeSettings(current: AppSettings, update: Partial<AppSettings>): AppSettings {
  return {
    ...current,
    ...update,
    discordBot: update.discordBot
      ? {
          ...current.discordBot,
          ...update.discordBot,
          allowedUserIds: [...update.discordBot.allowedUserIds],
          allowedChannelIds: [...update.discordBot.allowedChannelIds]
        }
      : current.discordBot,
    terminalConnectionProfiles: update.terminalConnectionProfiles
      ? update.terminalConnectionProfiles.map((profile) => ({ ...profile }))
      : current.terminalConnectionProfiles,
    remoteWorkspaceProfiles: update.remoteWorkspaceProfiles
      ? update.remoteWorkspaceProfiles.map((profile) => ({ ...profile }))
      : current.remoteWorkspaceProfiles
  };
}
