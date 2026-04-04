import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactKind, ArtifactRef } from "../../shared/types";
import { buildProjectPaths, createArtifactPaths } from "../services/workspace-layout";
import { createId, nowIso, sha256 } from "./utils";

export class ArtifactStore {
  async allocateRunArtifacts(workspacePath: string, lane: "worker" | "strategist" | "evaluator", id?: string) {
    const paths = buildProjectPaths(workspacePath);
    const token = id ?? createId(lane);
    const directory =
      lane === "strategist" ? paths.strategistRunsDir : lane === "evaluator" ? paths.evaluatorRunsDir : paths.workerRunsDir;
    await mkdir(directory, { recursive: true });
    return createArtifactPaths(directory, token);
  }

  async writeTextArtifact(input: {
    workspacePath: string;
    directory: string;
    fileName: string;
    body: string;
    kind: ArtifactKind;
    contentType?: string;
  }): Promise<ArtifactRef> {
    const targetPath = path.join(input.directory, input.fileName);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, input.body, "utf8");
    const sizeBytes = Buffer.byteLength(input.body, "utf8");
    return {
      id: createId("art"),
      kind: input.kind,
      path: targetPath,
      hash: sha256(input.body),
      contentType: input.contentType,
      sizeBytes,
      createdAt: nowIso()
    };
  }

  async writeBufferArtifact(input: {
    directory: string;
    fileName: string;
    body: Uint8Array;
    kind: ArtifactKind;
    contentType?: string;
  }): Promise<ArtifactRef> {
    const targetPath = path.join(input.directory, input.fileName);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, input.body);
    return {
      id: createId("art"),
      kind: input.kind,
      path: targetPath,
      hash: sha256(input.body),
      contentType: input.contentType,
      sizeBytes: input.body.byteLength,
      createdAt: nowIso()
    };
  }

  async writeJsonArtifact(input: {
    directory: string;
    fileName: string;
    value: unknown;
    kind: ArtifactKind;
  }) {
    return await this.writeTextArtifact({
      workspacePath: "",
      directory: input.directory,
      fileName: input.fileName,
      body: `${JSON.stringify(input.value, null, 2)}\n`,
      kind: input.kind,
      contentType: "application/json"
    });
  }

  async writePatchArtifact(workspacePath: string, taskId: string, patch: string) {
    const paths = buildProjectPaths(workspacePath);
    return await this.writeTextArtifact({
      workspacePath,
      directory: paths.patchesDir,
      fileName: `${taskId}.patch`,
      body: patch,
      kind: "patch",
      contentType: "text/x-diff"
    });
  }

  async readText(artifact?: ArtifactRef | null) {
    if (!artifact?.path) {
      return "";
    }

    return await readFile(artifact.path, "utf8").catch(() => "");
  }

  async statArtifact(artifact?: ArtifactRef | null) {
    if (!artifact?.path) {
      return null;
    }

    return await stat(artifact.path).catch(() => null);
  }
}
