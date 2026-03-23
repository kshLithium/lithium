import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function exists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function detectChromePath() {
  const envPath = process.env.LITHIUM_ORACLE_CHROME_PATH ?? process.env.CHROME_PATH;

  if (envPath && (await exists(envPath))) {
    return envPath;
  }

  const directCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
  ];

  for (const candidate of directCandidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  const playwrightRoot = path.join(os.homedir(), "Library/Caches/ms-playwright");

  if (!(await exists(playwrightRoot))) {
    return undefined;
  }

  const entries = (await readdir(playwrightRoot))
    .filter((entry) => entry.startsWith("chromium-"))
    .sort()
    .reverse();

  for (const entry of entries) {
    const candidate = path.join(
      playwrightRoot,
      entry,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing"
    );

    if (await exists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
