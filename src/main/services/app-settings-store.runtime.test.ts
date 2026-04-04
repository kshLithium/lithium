import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppSettingsStore } from "./app-settings-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

describe("AppSettingsStore runtime behavior", () => {
  it("serializes concurrent updates without dropping fields", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-settings-store-"));
    tempDirs.push(tempDir);
    const store = new AppSettingsStore(path.join(tempDir, "settings.json"));

    await Promise.all([
      store.update({
        lastWorkspacePath: "/tmp/real-real"
      }),
      store.update({
        oracleSessionReady: true
      })
    ]);

    const settings = await store.read();

    expect(settings.lastWorkspacePath).toBe("/tmp/real-real");
    expect(settings.oracleSessionReady).toBe(true);
  });

  it("does not leave temporary files behind after writing settings", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-settings-store-"));
    tempDirs.push(tempDir);
    const store = new AppSettingsStore(path.join(tempDir, "settings.json"));

    await store.update({
      lastWorkspacePath: "/tmp/real-real"
    });

    const entries = await readdir(tempDir);

    expect(entries).toContain("settings.json");
    expect(entries.some((entry) => entry.includes(".tmp"))).toBe(false);
  });
});
