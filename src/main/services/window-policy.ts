import path from "node:path";

export const APP_PROTOCOL = "app";
export const APP_PROTOCOL_HOST = "lithium";

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

export function resolveRendererUrl(url: string) {
  return url;
}

export function resolveAppEntryUrl() {
  return `${APP_PROTOCOL}://${APP_PROTOCOL_HOST}/index.html`;
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
