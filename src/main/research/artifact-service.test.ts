import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactService } from "./artifact-service";
import { ResearchStateStore } from "./state-store";
import { WorktreeManager } from "./worktree-manager";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe("ArtifactService", () => {
  it("captures a builder patch in a worktree and promotes it back to the main workspace", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-artifact-service-"));
    tempDirs.push(workspacePath);
    await execFileAsync("git", ["init"], { cwd: workspacePath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspacePath });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: workspacePath });
    await writeFile(path.join(workspacePath, "README.md"), "# demo\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: workspacePath });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: workspacePath });

    const stateStore = new ResearchStateStore();
    await stateStore.initWorkspace(workspacePath);
    const artifactService = new ArtifactService({ stateStore });
    const worktreeManager = new WorktreeManager();
    const lease = await worktreeManager.acquireLease(workspacePath, "RW001");

    await writeFile(path.join(lease.worktreePath, "README.md"), "# demo\npatched\n", "utf8");
    const patchArtifactPath = await artifactService.capturePatchArtifact({
      workspacePath,
      workItemId: "RW001",
      worktreePath: lease.worktreePath
    });
    const promote = await artifactService.promotePatchArtifact({
      workspacePath,
      patchArtifactPath: patchArtifactPath ?? undefined
    });

    expect(patchArtifactPath).toBeTruthy();
    expect(await readFile(patchArtifactPath!, "utf8")).toContain("patched");
    expect(promote.status).toBe("promoted");
    expect(await readFile(path.join(workspacePath, "README.md"), "utf8")).toContain("patched");

    await worktreeManager.cleanupRunWorkspace(workspacePath, "RW001");
    await expect(access(lease.worktreePath)).rejects.toThrow();
  });
});
