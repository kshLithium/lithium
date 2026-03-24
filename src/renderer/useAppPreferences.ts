import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { DEFAULT_APP_SETTINGS } from "../shared/types";
import type { AppSettingsUpdate, InitialThemeState, ResolvedTheme, RuntimeAppState } from "../shared/types";
import { resolveThemeMode } from "./app-utils";
import {
  applyDocumentTheme,
  getSystemPrefersDark,
  PREFERS_DARK_MEDIA_QUERY,
  resolveThemeState
} from "./theme";

type UseAppPreferencesArgs = {
  appState: RuntimeAppState | null;
  hasBridge: boolean;
  setAppState: Dispatch<SetStateAction<RuntimeAppState | null>>;
};

function readInitialThemeState(): InitialThemeState {
  if (typeof window === "undefined") {
    return resolveThemeState(DEFAULT_APP_SETTINGS.themePreference, false);
  }

  if (typeof window.lithium?.getInitialThemeState === "function") {
    return window.lithium.getInitialThemeState();
  }

  return resolveThemeState(DEFAULT_APP_SETTINGS.themePreference, getSystemPrefersDark(window));
}

export function useAppPreferences(args: UseAppPreferencesArgs) {
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => readInitialThemeState().systemTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const appSettings = args.appState?.settings ?? DEFAULT_APP_SETTINGS;
  const onboardingVisible = Boolean(args.appState) && !appSettings.onboardingDismissed;
  const resolvedTheme = resolveThemeMode(appSettings.themePreference, systemTheme === "dark");

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    applyDocumentTheme(resolveThemeState(appSettings.themePreference, systemTheme === "dark"), document);
  }, [appSettings.themePreference, systemTheme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (args.hasBridge && typeof window.lithium?.onThemeStateChange === "function") {
      setSystemTheme(readInitialThemeState().systemTheme);

      return window.lithium.onThemeStateChange((themeState) => {
        setSystemTheme(themeState.systemTheme);
      });
    }

    if (typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia(PREFERS_DARK_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };

    setSystemTheme(getSystemPrefersDark(window) ? "dark" : "light");

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", handleChange);
      return () => {
        query.removeEventListener("change", handleChange);
      };
    }

    query.addListener(handleChange);
    return () => {
      query.removeListener(handleChange);
    };
  }, [args.hasBridge]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsOpen]);

  async function updateAppSettings(update: AppSettingsUpdate) {
    if (!args.hasBridge) {
      args.setAppState((current) =>
        current
          ? {
              ...current,
              settings: {
                ...current.settings,
                ...update
              }
            }
          : current
      );
      return;
    }

    const previousSettings = args.appState?.settings ?? DEFAULT_APP_SETTINGS;

    args.setAppState((current) =>
      current
        ? {
            ...current,
            settings: {
              ...current.settings,
              ...update
            }
          }
        : current
    );

    try {
      const nextAppState = await window.lithium.updateAppSettings(update);

      if (typeof update.themePreference === "string" && typeof window.lithium.getInitialThemeState === "function") {
        setSystemTheme(window.lithium.getInitialThemeState().systemTheme);
      }

      args.setAppState(nextAppState);
    } catch (error) {
      args.setAppState((current) => (current ? { ...current, settings: previousSettings } : current));
      throw error;
    }
  }

  async function dismissOnboarding() {
    await updateAppSettings({ onboardingDismissed: true });
  }

  async function reopenOnboarding() {
    await updateAppSettings({ onboardingDismissed: false });
    setSettingsOpen(false);
  }

  return {
    appSettings,
    dismissOnboarding,
    onboardingVisible,
    openSettings: () => setSettingsOpen(true),
    reopenOnboarding,
    resolvedTheme,
    settingsOpen,
    updateAppSettings,
    closeSettings: () => setSettingsOpen(false)
  };
}
