import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchBranchRecord } from "../../shared/types";
import { ResearchStateStore } from "./state-store";
import { WorktreeManager } from "./worktree-manager";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe("WorktreeManager V3", () => {
  it("keeps a persistent branch worktree with its own git lineage", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-worktree-v3-"));
    tempDirs.push(workspacePath);
    await execFileAsync("git", ["init"], { cwd: workspacePath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspacePath });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: workspacePath });
    await writeFile(path.join(workspacePath, "README.md"), "# demo\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: workspacePath });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: workspacePath });

    const stateStore = new ResearchStateStore();
    await stateStore.initWorkspace(workspacePath);
    const manager = new WorktreeManager();
    const now = new Date().toISOString();
    const branch: ResearchBranchRecord = {
      id: "RB001",
      objectiveId: "RO001",
      title: "Primary branch",
      hypothesis: "Try the branch-local edit",
      status: "active",
      score: 0.6,
      evidenceIds: [],
      sourceIds: [],
      findingIds: [],
      workItemIds: [],
      createdAt: now,
      updatedAt: now,
      lastUpdatedAt: now
    };

    const prepared = await manager.ensureBranchWorkspace(workspacePath, branch);
    await writeFile(path.join(prepared.worktreePath!, "README.md"), "# demo\nbranch edit\n", "utf8");
    const committed = await manager.commitIfDirty({
      workspacePath,
      branch: prepared,
      message: "branch edit"
    });
    const refreshed = await manager.ensureBranchWorkspace(workspacePath, committed.branch);

    expect(refreshed.worktreePath).toBe(prepared.worktreePath);
    expect(refreshed.gitRef).toBe(prepared.gitRef);
    expect(refreshed.baseCommit).toBe(prepared.baseCommit);
    expect(refreshed.headCommit).not.toBe(prepared.headCommit);
    expect(await readFile(path.join(workspacePath, "README.md"), "utf8")).toBe("# demo\n");
    expect(await readFile(path.join(refreshed.worktreePath!, "README.md"), "utf8")).toContain("branch edit");
  });
});
