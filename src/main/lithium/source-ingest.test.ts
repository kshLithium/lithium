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
});
