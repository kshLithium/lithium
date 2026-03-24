import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteWorkspaceProfile } from "../../shared/types";
import { RemoteWorkspaceService, type RemoteWorkspaceMetadata } from "./remote-workspace-service";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("remote-workspace-service", () => {
  it("filters unsafe relative paths before syncing workspace files", async () => {
    const workspacePath = await createWorkspace();
    await mkdir(path.join(workspacePath, "paper"), { recursive: true });
    await writeFile(path.join(workspacePath, "paper", "main.tex"), "remote\n", "utf8");

    const metadata = createMetadata(workspacePath);
    const service = new RemoteWorkspaceService(path.join(os.tmpdir(), "lithium-remote-root")) as any;
    const uploadFile = vi.fn(async () => undefined);
    service.requireMetadata = vi.fn(async () => metadata);
    service.withSftp = vi.fn(async (_profile: RemoteWorkspaceProfile, work: (sftp: object) => Promise<unknown>) =>
      await work({})
    );
    service.uploadFile = uploadFile;

    const synced = await service.pushWorkspaceFiles(workspacePath, [
      "paper/main.tex",
      "../secret.txt",
      ".\\scratch\\..\\paper\\main.tex",
      ""
    ]);

    expect(synced).toEqual(["paper/main.tex"]);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledWith({}, metadata, "paper/main.tex");
  });

  it("preserves existing local files when a remote artifact pull fails", async () => {
    const workspacePath = await createWorkspace();
    await mkdir(path.join(workspacePath, "paper"), { recursive: true });
    const pdfPath = path.join(workspacePath, "paper", "main.pdf");
    await writeFile(pdfPath, "existing-pdf", "utf8");

    const metadata = createMetadata(workspacePath);
    const service = new RemoteWorkspaceService(path.join(os.tmpdir(), "lithium-remote-root")) as any;
    const downloadFile = vi.fn(async (_sftp: object, _metadata: RemoteWorkspaceMetadata, relativePath: string) => {
      if (relativePath === "paper/main.pdf") {
        throw new Error("network dropped");
      }
    });
    service.requireMetadata = vi.fn(async () => metadata);
    service.withSftp = vi.fn(async (_profile: RemoteWorkspaceProfile, work: (sftp: object) => Promise<unknown>) =>
      await work({})
    );
    service.downloadFile = downloadFile;

    await expect(service.pullWorkspaceFiles(workspacePath, ["paper/main.pdf"])).rejects.toThrow(
      "Failed to download remote workspace files: paper/main.pdf"
    );
    await expect(readFile(pdfPath, "utf8")).resolves.toBe("existing-pdf");
  });
});

async function createWorkspace() {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-remote-workspace-"));
  tempDirs.push(workspacePath);
  return workspacePath;
}

function createMetadata(workspacePath: string): RemoteWorkspaceMetadata {
  return {
    version: 1,
    mirrorPath: workspacePath,
    label: "GPU Box (researcher@gpu.example.org:/workspace/project)",
    kind: "ssh",
    remoteHost: "researcher@gpu.example.org",
    remotePath: "/workspace/project",
    profile: {
      id: "gpu-box",
      name: "GPU Box",
      kind: "ssh",
      host: "gpu.example.org",
      username: "researcher",
      remotePath: "/workspace/project"
    }
  };
}
