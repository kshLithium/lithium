import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { buildProjectPaths } from "../services/workspace-layout";
import { resolveWorkspaceGitRoot } from "../services/workspace-execution";

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  async supportsWorkspace(workspacePath: string) {
    return Boolean(await resolveWorkspaceGitRoot(workspacePath));
  }

  async prepareRunWorkspace(workspacePath: string, runId: string) {
    const gitRoot = await resolveWorkspaceGitRoot(workspacePath);

    if (!gitRoot) {
      throw new Error("Research autopilot requires a git-backed workspace so it can isolate each run.");
    }

    const paths = buildProjectPaths(workspacePath);
    const worktreePath = path.join(paths.worktreesDir, runId);
    await mkdir(paths.worktreesDir, { recursive: true });
    await this.cleanupRunWorkspace(workspacePath, runId).catch(() => undefined);
    await execFileAsync("git", ["worktree", "prune"], { cwd: gitRoot });
    await execFileAsync("git", ["worktree", "add", "--force", "--detach", worktreePath, "HEAD"], {
      cwd: gitRoot
    });

    return {
      gitRoot,
      worktreePath
    };
  }

  async cleanupRunWorkspace(workspacePath: string, runId: string) {
    const gitRoot = await resolveWorkspaceGitRoot(workspacePath);
    const paths = buildProjectPaths(workspacePath);
    const worktreePath = path.join(paths.worktreesDir, runId);

    if (gitRoot) {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: gitRoot
      }).catch(() => undefined);
      await execFileAsync("git", ["worktree", "prune"], { cwd: gitRoot }).catch(() => undefined);
    }

    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  }
}
