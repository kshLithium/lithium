import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../../shared/types";
import { AppService } from "./app-service";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    })
  );
});

describe("AppService runtime cleanup", () => {
  it("cleans up automation controller state after an immediate stop", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-automation-runtime-"));
    tempDirs.push(workspacePath);
    const service = new AppService(workspacePath, {
      getAppSettings: async () => DEFAULT_APP_SETTINGS
    });

    const created = await service.createAutomationSession({
      workspacePath,
      objective: "Keep the local automation loop running."
    });
    const sessionId = created.latestAutomationSession?.id;

    expect(sessionId).toBeTruthy();

    await service.interruptAutomationSession({
      workspacePath,
      sessionId: sessionId ?? "AU001",
      instruction: "자동연구 중지",
      stopNow: true
    });

    expect(
      ((service as unknown as { runtime: { automationControllers: Map<string, unknown> } }).runtime
        .automationControllers.size)
    ).toBe(0);
  });
});
