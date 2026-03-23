import {
  DEFAULT_APP_SETTINGS,
  type InitialThemeState,
  type ThemePreference
} from "../shared/types";
import { resolveThemeMode } from "./app-utils";

export const PREFERS_DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

type MatchMediaHost = Pick<Window, "matchMedia">;
type DocumentHost = Pick<Document, "documentElement">;

export function getSystemPrefersDark(targetWindow?: MatchMediaHost | null) {
  if (!targetWindow || typeof targetWindow.matchMedia !== "function") {
    return false;
  }

  return targetWindow.matchMedia(PREFERS_DARK_MEDIA_QUERY).matches;
}

export function resolveThemeState(
  themePreference: ThemePreference,
  prefersDark = false
): InitialThemeState {
  const systemTheme = prefersDark ? "dark" : "light";

  return {
    themePreference,
    resolvedTheme: resolveThemeMode(themePreference, prefersDark),
    systemTheme
  };
}

export function applyDocumentTheme(themeState: InitialThemeState, targetDocument?: DocumentHost | null) {
  if (!targetDocument) {
    return themeState.resolvedTheme;
  }

  const root = targetDocument.documentElement;
  root.dataset.theme = themeState.resolvedTheme;
  root.dataset.themePreference = themeState.themePreference;
  root.style.colorScheme = themeState.resolvedTheme;

  return themeState.resolvedTheme;
}

export function bootstrapDocumentTheme(
  initialThemeState?: Partial<InitialThemeState>,
  targetWindow?: MatchMediaHost | null,
  targetDocument?: DocumentHost | null
) {
  const themePreference = initialThemeState?.themePreference ?? DEFAULT_APP_SETTINGS.themePreference;
  const fallbackState = resolveThemeState(themePreference, getSystemPrefersDark(targetWindow));

  return applyDocumentTheme(
    {
      themePreference,
      resolvedTheme: initialThemeState?.resolvedTheme ?? fallbackState.resolvedTheme,
      systemTheme: initialThemeState?.systemTheme ?? fallbackState.systemTheme
    },
    targetDocument
  );
}
