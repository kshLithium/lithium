import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExperimentManifest, ExperimentResultRecord, SourceArtifactRecord } from "../../shared/types";
import { createArtifactPaths, buildProjectPaths } from "../services/workspace-layout";
import { ResearchStateStore } from "./state-store";

export class ArtifactService {
  constructor(private readonly deps: { stateStore: ResearchStateStore }) {}

  async allocateWorkerRunArtifacts(workspacePath: string, lane: "worker" | "oracle" | "evaluator" = "worker") {
    const paths = buildProjectPaths(workspacePath);
    const id = (await this.deps.stateStore.allocateWorkerRun(workspacePath)).id;
    const directory =
      lane === "oracle" ? paths.oracleSessionsDir : lane === "evaluator" ? paths.evaluatorDir : paths.workerRunsDir;
    await mkdir(directory, { recursive: true });
    return createArtifactPaths(directory, id);
  }

  async writePatchArtifact(workspacePath: string, taskId: string, patch: string) {
    const paths = buildProjectPaths(workspacePath);
    await mkdir(paths.researchPatchesDir, { recursive: true });
    const patchPath = path.join(paths.researchPatchesDir, `${taskId}.patch`);
    await writeFile(patchPath, patch, "utf8");
    return patchPath;
  }

  async writeExperimentManifest(workspacePath: string, experimentId: string, manifest: ExperimentManifest) {
    const paths = buildProjectPaths(workspacePath);
    await mkdir(paths.experimentManifestDir, { recursive: true });
    const manifestPath = path.join(paths.experimentManifestDir, `${experimentId}.manifest.json`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifestPath;
  }

  async readPatchArtifact(patchArtifactPath?: string) {
    if (!patchArtifactPath) {
      return "";
    }

    return await readFile(patchArtifactPath, "utf8").catch(() => "");
  }

  async captureSourceArtifact(input: {
    workspacePath: string;
    objectiveId: string;
    sourceId: string;
    fileName: string;
    body: string | Buffer;
    contentType?: string;
  }): Promise<SourceArtifactRecord> {
    const paths = buildProjectPaths(input.workspacePath);
    await mkdir(paths.sourceArtifactsDir, { recursive: true });
    const artifactId = (await this.deps.stateStore.allocateSourceArtifact(input.workspacePath)).id;
    const safeName = input.fileName.replace(/[^A-Za-z0-9._-]+/g, "-");
    const targetPath = path.join(paths.sourceArtifactsDir, `${artifactId}-${safeName}`);
    const bytes = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;
    await writeFile(targetPath, bytes);
    const now = new Date().toISOString();
    const record: SourceArtifactRecord = {
      id: artifactId,
      objectiveId: input.objectiveId,
      sourceId: input.sourceId,
      path: targetPath,
      hash: sha256(bytes),
      contentType: input.contentType,
      sizeBytes: bytes.byteLength,
      createdAt: now,
      updatedAt: now
    };
    await this.deps.stateStore.writeSourceArtifact(input.workspacePath, record);
    return record;
  }

  async fetchRemoteSourceArtifact(input: {
    workspacePath: string;
    objectiveId: string;
    sourceId: string;
    locator: string;
  }) {
    try {
      const response = await fetch(input.locator, {
        headers: {
          "user-agent": "Lithium/3.0"
        }
      });

      if (!response.ok) {
        return null;
      }

      const body = Buffer.from(await response.arrayBuffer());
      const extension = inferExtensionFromContentType(response.headers.get("content-type"));
      return await this.captureSourceArtifact({
        workspacePath: input.workspacePath,
        objectiveId: input.objectiveId,
        sourceId: input.sourceId,
        fileName: `${input.sourceId}${extension}`,
        body,
        contentType: response.headers.get("content-type") ?? undefined
      });
    } catch {
      return null;
    }
  }

  async readRecentExperimentResults(workspacePath: string, objectiveId: string, limit = 5) {
    return (await this.deps.stateStore.listExperimentResults(workspacePath))
      .filter((entry) => entry.objectiveId === objectiveId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  toExperimentResultRecord(
    record: ExperimentResultRecord,
    manifest: ExperimentManifest,
    manifestPath: string
  ): ExperimentResultRecord {
    return {
      ...record,
      manifest,
      manifestPath
    };
  }
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inferExtensionFromContentType(contentType: string | null) {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";

  switch (normalized) {
    case "text/html":
      return ".html";
    case "application/json":
      return ".json";
    case "text/plain":
      return ".txt";
    case "application/pdf":
      return ".pdf";
    default:
      return ".bin";
  }
}
