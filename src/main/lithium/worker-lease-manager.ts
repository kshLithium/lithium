import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { BranchRecord, WorktreeLeaseRecord } from "../../shared/types";
import { pathExists } from "../services/fs-utils";
import { buildProjectPaths } from "../services/workspace-layout";
import { resolveWorkspaceGitRoot } from "../services/workspace-execution";
import { createId, nowIso } from "./utils";

const execFileAsync = promisify(execFile);
const LITHIUM_GIT_AUTHOR_NAME = "Lithium";
const LITHIUM_GIT_AUTHOR_EMAIL = "lithium@local.invalid";

export class WorkerLeaseManager {
  async supportsWorkspace(workspacePath: string) {
    return Boolean(await resolveWorkspaceGitRoot(workspacePath));
  }

  async ensureLease(input: {
    workspacePath: string;
    branch: BranchRecord;
    taskId: string;
    mode: "write" | "read";
  }): Promise<{ branch: BranchRecord; lease: WorktreeLeaseRecord }> {
    const branch = await this.ensureBranchWorkspace(input.workspacePath, input.branch);
    const paths = buildProjectPaths(input.workspacePath);
    const tempDir = path.join(paths.tempEnvDir, input.taskId.toLowerCase());
    await mkdir(tempDir, { recursive: true });
    const now = nowIso();

    return {
      branch,
      lease: {
        id: `lease_${input.taskId.toLowerCase()}`,
        taskId: input.taskId,
        branchId: branch.id,
        worktreePath: branch.worktreePath!,
        tempDir,
        mode: input.mode,
        status: "active",
        createdAt: now,
        updatedAt: now
      }
    };
  }

  async releaseLease(lease: WorktreeLeaseRecord) {
    const now = nowIso();
    try {
      await rm(lease.tempDir, { recursive: true, force: true });
      return {
        ...lease,
        status: "released" as const,
        updatedAt: now,
        releasedAt: now
      };
    } catch (error) {
      return {
        ...lease,
        status: "failed" as const,
        updatedAt: now,
        cleanupError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async ensureBranchWorkspace(workspacePath: string, branch: BranchRecord) {
    const gitRoot = await resolveWorkspaceGitRoot(workspacePath);
    if (!gitRoot) {
      throw new Error("Lithium V5 requires a git-backed workspace for build and experiment tasks.");
    }

    const paths = buildProjectPaths(workspacePath);
    await mkdir(paths.worktreesDir, { recursive: true });
    const baseCommit = branch.baseCommit ?? (await this.readHeadCommit(gitRoot));
    const gitRef = branch.gitRef ?? `lithium/${branch.objectiveId.toLowerCase()}/${branch.id.toLowerCase()}`;
    const worktreePath = branch.worktreePath ?? path.join(paths.worktreesDir, branch.id.toLowerCase());
    const refExists = await this.gitRefExists(gitRoot, gitRef);

    if (!refExists) {
      await execFileAsync("git", ["branch", "--force", gitRef, baseCommit], { cwd: gitRoot });
    }

    const worktreeReady = await pathExists(path.join(worktreePath, ".git"));
    if (!worktreeReady) {
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      await execFileAsync("git", ["worktree", "add", "--force", worktreePath, gitRef], { cwd: gitRoot });
    }

    const headCommit = await this.readHeadCommit(worktreePath);
    return {
      ...branch,
      baseCommit,
      gitRef,
      worktreePath,
      headCommit,
      updatedAt: nowIso()
    };
  }

  async commitIfDirty(input: {
    workspacePath: string;
    branch: BranchRecord;
    message: string;
  }) {
    const branch = await this.ensureBranchWorkspace(input.workspacePath, input.branch);
    const dirty = await this.isDirty(branch.worktreePath!);

    if (!dirty) {
      return {
        branch: await this.refreshBranchHead(input.workspacePath, branch),
        committed: false
      };
    }

    await execFileAsync("git", ["add", "-A"], { cwd: branch.worktreePath! });
    await execFileAsync(
      "git",
      [
        "-c",
        `user.name=${LITHIUM_GIT_AUTHOR_NAME}`,
        "-c",
        `user.email=${LITHIUM_GIT_AUTHOR_EMAIL}`,
        "commit",
        "-m",
        input.message
      ],
      { cwd: branch.worktreePath! }
    );

    return {
      branch: await this.refreshBranchHead(input.workspacePath, branch),
      committed: true
    };
  }

  async buildPromotionPatch(input: {
    workspacePath: string;
    branch: BranchRecord;
    fromCommit?: string | null;
  }) {
    const branch = await this.refreshBranchHead(input.workspacePath, input.branch);
    const fromCommit = input.fromCommit ?? branch.promotionHeadCommit ?? branch.baseCommit;
    if (!fromCommit || !branch.headCommit || fromCommit === branch.headCommit) {
      return {
        branch,
        changed: false,
        patch: ""
      };
    }

    const { stdout } = await execFileAsync("git", ["diff", "--binary", `${fromCommit}..${branch.headCommit}`], {
      cwd: branch.worktreePath!,
      maxBuffer: 10 * 1024 * 1024
    });

    return {
      branch,
      changed: Boolean(stdout.trim()),
      patch: stdout
    };
  }

  async buildWorkingTreePatch(branch: BranchRecord) {
    if (!branch.worktreePath) {
      return {
        changed: false,
        patch: ""
      };
    }
    const { stdout } = await execFileAsync("git", ["diff", "--binary", "HEAD"], {
      cwd: branch.worktreePath,
      maxBuffer: 10 * 1024 * 1024
    });
    return {
      changed: Boolean(stdout.trim()),
      patch: stdout
    };
  }

  async promotePatchArtifact(workspacePath: string, patchPath: string) {
    const gitRoot = await resolveWorkspaceGitRoot(workspacePath);
    if (!gitRoot) {
      throw new Error("Patch promotion requires a git-backed workspace.");
    }

    const check = await execFileAsync("git", ["apply", "--check", patchPath], { cwd: gitRoot }).catch(() => null);
    if (!check) {
      return {
        promotionStatus: "failed" as const,
        promotionError: "Patch apply --check failed."
      };
    }

    await execFileAsync("git", ["apply", "--3way", patchPath], { cwd: gitRoot });
    return {
      promotionStatus: "promoted" as const
    };
  }

  async restoreBranchWorkspace(workspacePath: string, branch: BranchRecord) {
    const gitRoot = await resolveWorkspaceGitRoot(workspacePath);
    if (!gitRoot) {
      throw new Error("Restoring a lease requires a git-backed workspace.");
    }
    if (!branch.worktreePath || !branch.gitRef) {
      return await this.ensureBranchWorkspace(workspacePath, branch);
    }

    await execFileAsync("git", ["worktree", "remove", "--force", branch.worktreePath], { cwd: gitRoot }).catch(() => undefined);
    await rm(branch.worktreePath, { recursive: true, force: true }).catch(() => undefined);
    await execFileAsync("git", ["worktree", "add", "--force", branch.worktreePath, branch.gitRef], { cwd: gitRoot });
    return await this.refreshBranchHead(workspacePath, branch);
  }

  async listChangedFiles(worktreePath: string, options?: { trackedOnly?: boolean }) {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: worktreePath });
    return stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .filter((line) => !(options?.trackedOnly && line.startsWith("??")))
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .map((entry) => entry.replaceAll(path.sep, "/"));
  }

  async hasTrackedChanges(worktreePath: string) {
    const files = await this.listChangedFiles(worktreePath, {
      trackedOnly: true
    });
    return files.length > 0;
  }

  buildRuntimeEnv(tempDir: string) {
    return {
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir
    };
  }

  private async refreshBranchHead(workspacePath: string, branch: BranchRecord) {
    const ensured = await this.ensureBranchWorkspace(workspacePath, branch);
    return {
      ...ensured,
      headCommit: await this.readHeadCommit(ensured.worktreePath!)
    };
  }

  private async readHeadCommit(cwd: string) {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim();
  }

  private async gitRefExists(gitRoot: string, gitRef: string) {
    try {
      await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${gitRef}`], { cwd: gitRoot });
      return true;
    } catch {
      return false;
    }
  }

  private async isDirty(worktreePath: string) {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: worktreePath });
    return Boolean(stdout.trim());
  }
}
