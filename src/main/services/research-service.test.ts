import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchService } from "./research-service";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe("ResearchService", () => {
  it("rejects objective runs on non-git workspaces", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-research-service-"));
    tempDirs.push(workspacePath);
    const service = new ResearchService(workspacePath);

    await service.initWorkspace(workspacePath);
    await service.createObjective({
      workspacePath,
      objective: "Advance the next benchmark result."
    });

    await expect(service.startRun({ workspacePath })).rejects.toThrow("git-backed workspace");
  });

  it("creates a blocked run when the Oracle session is unavailable", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-research-service-git-"));
    tempDirs.push(workspacePath);
    await execFileAsync("git", ["init"], { cwd: workspacePath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspacePath });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: workspacePath });
    await writeFile(path.join(workspacePath, "README.md"), "# demo\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: workspacePath });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: workspacePath });

    const service = new ResearchService(workspacePath, {
      chatgptAuthRunner: {
        signIn: vi.fn(),
        prepareReusableSession: vi.fn().mockRejectedValue(new Error("Saved ChatGPT session expired."))
      }
    });

    await service.initWorkspace(workspacePath);
    await service.createObjective({
      workspacePath,
      objective: "Advance the next benchmark result."
    });

    const snapshot = await service.startRun({ workspacePath });

    expect(snapshot.activeRun?.status).toBe("blocked");
    expect(snapshot.activeRun?.blockedReason).toContain("expired");
  });

  it("imports attachments into the source graph for the active objective", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-research-attachment-"));
    tempDirs.push(workspacePath);
    const attachmentPath = path.join(workspacePath, "note.txt");
    await writeFile(attachmentPath, "baseline metric: 0.72\nconsider the ablation branch\n", "utf8");

    const service = new ResearchService(workspacePath);
    await service.initWorkspace(workspacePath);
    const snapshot = await service.createObjective({
      workspacePath,
      objective: "Advance the benchmark branch."
    });

    await service.importAttachments({
      workspacePath,
      objectiveId: snapshot.activeObjective?.id,
      filePaths: [attachmentPath]
    });

    const nextSnapshot = await service.getWorkspaceSnapshot(workspacePath);
    expect(nextSnapshot.attachments).toHaveLength(1);
    expect(nextSnapshot.recentSources.some((entry) => entry.kind === "attachment")).toBe(true);
    expect(nextSnapshot.recentSources[0]?.provenance).toContain("attachment:");
    expect(await readFile(path.join(workspacePath, nextSnapshot.attachments[0]!.relativePath), "utf8")).toContain(
      "baseline metric"
    );
  });
});
