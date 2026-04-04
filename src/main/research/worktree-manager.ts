import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { ResearchWorktreeLeaseRecord } from "../../shared/types";
import { buildProjectPaths } from "../services/workspace-layout";
import { resolveWorkspaceGitRoot } from "../services/workspace-execution";

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  async supportsWorkspace(workspacePath: string) {
    return Boolean(await resolveWorkspaceGitRoot(workspacePath));
  }

  async acquireLease(workspacePath: string, workItemId: string): Promise<ResearchWorktreeLeaseRecord> {
    const gitRoot = await resolveWorkspaceGitRoot(workspacePath);

    if (!gitRoot) {
      throw new Error("Research autopilot requires a git-backed workspace so it can isolate each run.");
    }

    const paths = buildProjectPaths(workspacePath);
    const leaseId = `lease-${workItemId.toLowerCase()}`;
    const worktreePath = path.join(paths.worktreesDir, leaseId);
    const now = new Date().toISOString();
    await mkdir(paths.worktreesDir, { recursive: true });
    await this.cleanupByPath(workspacePath, worktreePath).catch(() => undefined);
    await execFileAsync("git", ["worktree", "prune"], { cwd: gitRoot });
    await execFileAsync("git", ["worktree", "add", "--force", "--detach", worktreePath, "HEAD"], {
      cwd: gitRoot
    });

    return {
      id: leaseId,
      workItemId,
      worktreePath,
      cleanupStatus: "active",
      createdAt: now,
      updatedAt: now
    };
  }

  async prepareRunWorkspace(workspacePath: string, runId: string) {
    const lease = await this.acquireLease(workspacePath, runId);
    const gitRoot = await resolveWorkspaceGitRoot(workspacePath);

    return {
      gitRoot,
      worktreePath: lease.worktreePath,
      lease
    };
  }

  async cleanupRunWorkspace(workspacePath: string, runId: string) {
    const paths = buildProjectPaths(workspacePath);
    const legacyPath = path.join(paths.worktreesDir, runId);
    const leasePath = path.join(paths.worktreesDir, `lease-${runId.toLowerCase()}`);
    await this.cleanupByPath(workspacePath, legacyPath);
    if (leasePath !== legacyPath) {
      await this.cleanupByPath(workspacePath, leasePath);
    }
  }

  async releaseLease(
    workspacePath: string,
    lease: Pick<ResearchWorktreeLeaseRecord, "worktreePath">
  ): Promise<{ cleanupStatus: "released" | "failed"; cleanupError?: string }> {
    try {
      await this.cleanupByPath(workspacePath, lease.worktreePath);
      return {
        cleanupStatus: "released"
      };
    } catch (error) {
      return {
        cleanupStatus: "failed",
        cleanupError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async garbageCollect(workspacePath: string, activeWorktreePaths: string[]) {
    const paths = buildProjectPaths(workspacePath);
    await mkdir(paths.worktreesDir, { recursive: true });
    const active = new Set(activeWorktreePaths.map((entry) => path.resolve(entry)));
    const entries = await readdir(paths.worktreesDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const absolutePath = path.join(paths.worktreesDir, entry.name);
      if (active.has(path.resolve(absolutePath))) {
        continue;
      }

      await this.cleanupByPath(workspacePath, absolutePath).catch(() => undefined);
    }
  }

  private async cleanupByPath(workspacePath: string, worktreePath: string) {
    const gitRoot = await resolveWorkspaceGitRoot(workspacePath);

    if (gitRoot) {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: gitRoot
      }).catch(() => undefined);
      await execFileAsync("git", ["worktree", "prune"], { cwd: gitRoot }).catch(() => undefined);
    }

    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  }
}
