import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const APP_NAME = "Lithium.app";
const RELEASE_ROOT = path.resolve(process.cwd(), "release");

async function exists(targetPath: string) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findPackagedApp(rootPath: string, depth = 0): Promise<string | null> {
  if (depth > 4) {
    return null;
  }

  const entries = await readdir(rootPath, { withFileTypes: true });
  const directMatch = entries.find((entry) => entry.isDirectory() && entry.name === APP_NAME);

  if (directMatch) {
    return path.join(rootPath, directMatch.name);
  }

  const preferredDirs = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => {
      const leftScore = left.name.includes(process.arch) ? 1 : 0;
      const rightScore = right.name.includes(process.arch) ? 1 : 0;
      return rightScore - leftScore;
    });

  for (const entry of preferredDirs) {
    const nestedPath = await findPackagedApp(path.join(rootPath, entry.name), depth + 1);

    if (nestedPath) {
      return nestedPath;
    }
  }

  return null;
}

async function resolveAppPath() {
  const candidates = [
    path.join(RELEASE_ROOT, `mac-${process.arch}`, APP_NAME),
    path.join(RELEASE_ROOT, "mac", APP_NAME),
    path.join(RELEASE_ROOT, APP_NAME)
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return await findPackagedApp(RELEASE_ROOT);
}

async function main() {
  const appPath = await resolveAppPath();

  if (!appPath) {
    console.error("No packaged Lithium.app found under ./release. Run `npm run package:dir` first.");
    process.exitCode = 1;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("open", ["-na", appPath], {
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`open exited with code ${code ?? "unknown"}`));
    });
  });

  console.log(`Opened packaged app: ${appPath}`);
}

await main();
