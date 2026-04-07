import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store";
import { SourceIngest } from "./source-ingest";
import { ResearchStore } from "./store";

describe("SourceIngest", () => {
  it("stores local files under .lithium artifacts and creates retrieval chunks", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-v4-source-"));
    const sourcePath = path.join(workspacePath, "notes.txt");
    await writeFile(sourcePath, "alpha beta gamma delta epsilon ".repeat(120), "utf8");

    const store = new ResearchStore();
    await store.initializeWorkspace(workspacePath);
    const ingest = new SourceIngest({
      store,
      artifactStore: new ArtifactStore()
    });
    const objective = {
      id: "obj_1",
      title: "Test objective",
      objective: "Test objective",
      summary: "Test objective",
      status: "active" as const,
      successCriteria: [],
      branchIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store.upsertProjection(workspacePath, "objective", objective);

    const sources = await ingest.addInputs({
      workspacePath,
      objective,
      inputs: [sourcePath]
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.bodyArtifactRef?.path).toContain(`${path.sep}.lithium${path.sep}artifacts${path.sep}`);
    const chunks = store.listProjections(workspacePath, "source_chunk");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((entry) => entry.objectiveId === objective.id)).toBe(true);
  });

  it("retrieves both objective-scoped and branch-scoped sources for a branch query", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-v5-source-links-"));
    const commonSourcePath = path.join(workspacePath, "common.txt");
    const branchSourcePath = path.join(workspacePath, "branch.txt");
    await writeFile(commonSourcePath, "shared baseline metric evidence alpha ".repeat(80), "utf8");
    await writeFile(branchSourcePath, "branch specific evidence beta gamma ".repeat(80), "utf8");

    const store = new ResearchStore();
    await store.initializeWorkspace(workspacePath);
    const ingest = new SourceIngest({
      store,
      artifactStore: new ArtifactStore()
    });
    const now = new Date().toISOString();
    const objective = {
      id: "obj_1",
      title: "Test objective",
      objective: "Test objective",
      summary: "Test objective",
      status: "active" as const,
      successCriteria: [],
      branchIds: ["br_1"],
      activeBranchId: "br_1",
      createdAt: now,
      updatedAt: now
    };
    const branch = {
      id: "br_1",
      objectiveId: "obj_1",
      title: "Primary branch",
      hypothesis: "Hypothesis",
      status: "active" as const,
      score: 0.5,
      findingIds: [],
      taskIds: [],
      createdAt: now,
      updatedAt: now
    };
    store.upsertProjection(workspacePath, "objective", objective);
    store.upsertProjection(workspacePath, "branch", branch);

    const [commonSource] = await ingest.addInputs({
      workspacePath,
      objective,
      inputs: [commonSourcePath]
    });
    const [branchSource] = await ingest.addInputs({
      workspacePath,
      objective,
      branch,
      inputs: [branchSourcePath]
    });

    const results = await ingest.search({
      workspacePath,
      objectiveId: objective.id,
      branchId: branch.id,
      query: "shared branch evidence",
      limit: 10
    });
    const sourceIds = new Set(results.map((entry) => entry.sourceId));

    expect(sourceIds.has(commonSource!.id)).toBe(true);
    expect(sourceIds.has(branchSource!.id)).toBe(true);
  });
});
