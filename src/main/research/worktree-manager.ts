import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { ResearchBranchRecord, ResearchWorktreeLeaseRecord } from "../../shared/types";
import { pathExists } from "../services/fs-utils";
import { buildProjectPaths } from "../services/workspace-layout";
import { resolveWorkspaceGitRoot } from "../services/workspace-execution";

const execFileAsync = promisify(execFile);
const LITHIUM_GIT_AUTHOR_NAME = "Lithium";
const LITHIUM_GIT_AUTHOR_EMAIL = "lithium@local.invalid";

export class WorktreeManager {
  async supportsWorkspace(workspacePath: string) {
    return Boolean(await resolveWorkspaceGitRoot(workspacePath));
  }

  async ensureBranchWorkspace(workspacePath: string, branch: ResearchBranchRecord) {
    const gitRoot = await resolveWorkspaceGitRoot(workspacePath);

    if (!gitRoot) {
      throw new Error("Research runs require a git-backed workspace.");
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
      headCommit
    };
  }

  async refreshBranchHead(workspacePath: string, branch: ResearchBranchRecord) {
    const ensured = await this.ensureBranchWorkspace(workspacePath, branch);
    return {
      ...ensured,
      headCommit: await this.readHeadCommit(ensured.worktreePath!)
    };
  }

  async commitIfDirty(input: {
    workspacePath: string;
    branch: ResearchBranchRecord;
    message: string;
  }) {
    const ensured = await this.ensureBranchWorkspace(input.workspacePath, input.branch);
    const worktreePath = ensured.worktreePath!;
    const dirty = await this.isDirty(worktreePath);

    if (!dirty) {
      return {
        branch: await this.refreshBranchHead(input.workspacePath, ensured),
        committed: false
      };
    }

    await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
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
      { cwd: worktreePath }
    );

    return {
      branch: await this.refreshBranchHead(input.workspacePath, ensured),
      committed: true
    };
  }

  async buildPromotionPatch(input: {
    workspacePath: string;
    branch: ResearchBranchRecord;
    fromCommit?: string | null;
    outputPath: string;
  }) {
    const ensured = await this.refreshBranchHead(input.workspacePath, input.branch);
    const fromCommit = input.fromCommit ?? ensured.promotionHeadCommit ?? ensured.baseCommit;

    if (!fromCommit || !ensured.headCommit || fromCommit === ensured.headCommit) {
      return {
        branch: ensured,
        changed: false
      };
    }

    const { stdout } = await execFileAsync("git", ["diff", "--binary", `${fromCommit}..${ensured.headCommit}`], {
      cwd: ensured.worktreePath!,
      maxBuffer: 10 * 1024 * 1024
    });

    return {
      branch: ensured,
      changed: Boolean(stdout.trim()),
      patch: stdout
    };
  }

  async acquireLease(workspacePath: string, workItemId: string): Promise<ResearchWorktreeLeaseRecord> {
    const paths = buildProjectPaths(workspacePath);
    const worktreePath = path.join(paths.worktreesDir, workItemId.toLowerCase());
    return {
      id: `lease-${workItemId.toLowerCase()}`,
      workItemId,
      worktreePath,
      cleanupStatus: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async releaseLease() {
    return {
      cleanupStatus: "released" as const
    };
  }

  async garbageCollect() {
    return;
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
