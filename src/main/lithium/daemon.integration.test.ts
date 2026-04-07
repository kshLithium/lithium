import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceDaemon } from "./bootstrap";
import { sendRpc } from "./rpc-client";

const activeDaemons: Array<ReturnType<typeof createWorkspaceDaemon>> = [];

describe("WorkspaceDaemon RPC", () => {
  afterEach(async () => {
    while (activeDaemons.length > 0) {
      await activeDaemons.pop()!.stop();
    }
  });

  it("serves objective creation and status over the local socket", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-v5-daemon-"));
    const daemon = createWorkspaceDaemon(workspacePath);
    activeDaemons.push(daemon);
    await daemon.start();

    const created = await sendRpc<{ id: string; title: string }>(workspacePath, "objective.create", {
      objective: "Investigate the new daemon architecture"
    });
    const list = await sendRpc<Array<{ id: string }>>(workspacePath, "objective.list");
    const snapshot = await sendRpc<{ activeObjective: { id: string } | null; daemon: { running: boolean } }>(
      workspacePath,
      "status.snapshot"
    );

    expect(created.id).toBeTruthy();
    expect(list.some((entry) => entry.id === created.id)).toBe(true);
    expect(snapshot.activeObjective?.id).toBe(created.id);
    expect(snapshot.daemon.running).toBe(true);
  });
});
