import path from "node:path";
import type { ThemePreference } from "../../shared/types";

export type InitialSurface = "chat" | "code" | "paper" | "memory" | null;
export const APP_PROTOCOL = "app";
export const APP_PROTOCOL_HOST = "lithium";

export function resolveInitialSurface(value: string | undefined): InitialSurface {
  if (value === "chat" || value === "code" || value === "paper" || value === "memory") {
    return value;
  }

  return null;
}

export function resolveSurfaceUrl(url: string, initialSurface: InitialSurface) {
  if (!initialSurface || initialSurface === "chat") {
    return url;
  }

  const resolvedUrl = new URL(url);
  resolvedUrl.searchParams.set("surface", initialSurface);
  return resolvedUrl.toString();
}

export function isSafeExternalUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

export function isTrustedAppUrl(url: string, devServerUrl?: string) {
  try {
    const parsed = new URL(url);

    if (devServerUrl) {
      const allowed = new URL(devServerUrl);
      return parsed.origin === allowed.origin;
    }

    return parsed.protocol === `${APP_PROTOCOL}:`;
  } catch {
    return false;
  }
}

export function resolveWindowBackgroundColor(
  themePreference: ThemePreference,
  shouldUseDarkColors: boolean
) {
  const resolvedTheme =
    themePreference === "system" ? (shouldUseDarkColors ? "dark" : "light") : themePreference;

  return resolvedTheme === "dark" ? "#10151b" : "#f3f2ee";
}

export function resolveAppEntryUrl(initialSurface: InitialSurface) {
  return resolveSurfaceUrl(`${APP_PROTOCOL}://${APP_PROTOCOL_HOST}/index.html`, initialSurface);
}

export function resolveBundledAssetPath(url: string, distRoot: string) {
  const parsed = new URL(url);

  if (parsed.protocol !== `${APP_PROTOCOL}:`) {
    throw new Error(`Unexpected protocol: ${parsed.protocol}`);
  }

  if (parsed.hostname !== APP_PROTOCOL_HOST) {
    throw new Error(`Unexpected host: ${parsed.hostname || "unknown"}`);
  }

  const pathname = decodeURIComponent(parsed.pathname || "/");
  const rawSegments = pathname.split("/").filter(Boolean);

  if (rawSegments.some((segment) => segment === "..")) {
    throw new Error(`Blocked protocol path escape: ${pathname}`);
  }

  const relativePath = path.posix.normalize(pathname === "/" ? "/index.html" : pathname).replace(/^\/+/, "");
  const resolvedPath = path.join(distRoot, relativePath);
  const relative = path.relative(distRoot, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Blocked protocol path escape: ${pathname}`);
  }

  return resolvedPath;
}
