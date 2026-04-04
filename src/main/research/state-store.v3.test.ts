import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchStateStore } from "./state-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe("ResearchStateStore V3", () => {
  it("rejects legacy .lithium layouts instead of migrating them", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-state-v3-"));
    tempDirs.push(workspacePath);
    await mkdir(path.join(workspacePath, ".lithium", "research", "objectives"), { recursive: true });

    const store = new ResearchStateStore();
    await expect(store.initWorkspace(workspacePath)).rejects.toThrow("Legacy Lithium state detected");
  });
});
