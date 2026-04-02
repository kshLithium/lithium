import { spawn } from "node:child_process";
import { access, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const EXECUTION_ROOT_SCAN_IGNORES = new Set([
  ".git",
  ".lithium",
  ".venv",
  "venv",
  "node_modules",
  "dist"
]);

export async function resolveWorkspaceExecutionRoot(workspacePath: string) {
  const canonicalWorkspacePath = await realpath(workspacePath).catch(() => workspacePath);
  const directGitRoot = await readGitRootFrom(workspacePath);

  if (directGitRoot) {
    return canonicalWorkspacePath;
  }

  return (await findSingleNestedGitWorkspace(canonicalWorkspacePath)) ?? canonicalWorkspacePath;
}

export async function resolveWorkspaceGitRoot(workspacePath: string) {
  const directGitRoot = await readGitRootFrom(workspacePath);

  if (directGitRoot) {
    return directGitRoot;
  }

  const nestedWorkspace = await findSingleNestedGitWorkspace(workspacePath);

  if (!nestedWorkspace) {
    return null;
  }

  return (await readGitRootFrom(nestedWorkspace)) ?? nestedWorkspace;
}

export async function resolveWorkspaceCommandContext(workspacePath: string) {
  const commandCwd = await resolveWorkspaceExecutionRoot(workspacePath);
  const virtualEnvPath = await resolveWorkspaceVirtualEnvPath([commandCwd, workspacePath]);

  return {
    commandCwd,
    env: virtualEnvPath
      ? {
          VIRTUAL_ENV: virtualEnvPath,
          PATH: [path.join(virtualEnvPath, "bin"), process.env.PATH ?? ""]
            .filter(Boolean)
            .join(path.delimiter)
        }
      : undefined
  };
}

async function findSingleNestedGitWorkspace(workspacePath: string) {
  const entries = await readdir(workspacePath, { withFileTypes: true }).catch(() => []);
  const candidates: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || EXECUTION_ROOT_SCAN_IGNORES.has(entry.name)) {
      continue;
    }

    const childPath = path.join(workspacePath, entry.name);
    const childGitRoot = await readGitRootFrom(childPath);

    if (childGitRoot) {
      candidates.push(await realpath(childPath).catch(() => childPath));
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

async function resolveWorkspaceVirtualEnvPath(candidateRoots: string[]) {
  const roots = Array.from(new Set(candidateRoots.map((entry) => entry.trim()).filter(Boolean)));

  for (const root of roots) {
    for (const name of [".venv", "venv"]) {
      const candidate = path.join(root, name);
      const pythonBinary = path.join(candidate, "bin", "python3");

      try {
        await access(pythonBinary);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
  }

  return null;
}

async function readGitRootFrom(cwd: string) {
  const child = spawn("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"]
  });
  let stdout = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

  if (exitCode !== 0) {
    return null;
  }

  return stdout.trim() || null;
}
