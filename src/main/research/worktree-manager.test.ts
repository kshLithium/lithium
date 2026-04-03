import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "./worktree-manager";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe("WorktreeManager", () => {
  it("creates and removes an isolated git worktree per run", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-worktree-"));
    tempDirs.push(workspacePath);
    await execFileAsync("git", ["init"], { cwd: workspacePath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspacePath });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: workspacePath });
    await writeFile(path.join(workspacePath, "README.md"), "# demo\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: workspacePath });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: workspacePath });

    const manager = new WorktreeManager();
    const prepared = await manager.prepareRunWorkspace(workspacePath, "RW001");

    await expect(access(path.join(prepared.worktreePath, "README.md"))).resolves.toBeUndefined();
    await manager.cleanupRunWorkspace(workspacePath, "RW001");
    await expect(access(prepared.worktreePath)).rejects.toThrow();
  });
});
