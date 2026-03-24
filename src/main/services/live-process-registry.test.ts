import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getLiveProcess, startLiveProcess, stopAllLiveProcesses } from "./live-process-registry";

describe("live-process-registry", () => {
  it("keeps live builder-style processes running without a timeout", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-live-process-"));
    const handle = startLiveProcess({
      id: "R-test-no-timeout",
      workspacePath: tempDir,
      spec: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log('finished'), 50)"],
        cwd: tempDir
      },
      stdoutPath: path.join(tempDir, "stdout.log"),
      stderrPath: path.join(tempDir, "stderr.log"),
      outputPath: path.join(tempDir, "output.log")
    });

    expect(getLiveProcess(tempDir, handle.id)?.pid).toBe(handle.pid);

    const result = await handle.done;

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(getLiveProcess(tempDir, handle.id)).toBeNull();
  });

  it("still enforces explicit live-process timeouts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-live-process-"));
    const handle = startLiveProcess({
      id: "R-test-timeout",
      workspacePath: tempDir,
      spec: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log('too late'), 250)"],
        cwd: tempDir
      },
      stdoutPath: path.join(tempDir, "stdout.log"),
      stderrPath: path.join(tempDir, "stderr.log"),
      timeoutMs: 25
    });

    const result = await handle.done;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(getLiveProcess(tempDir, handle.id)).toBeNull();
  });

  it("terminates every tracked live process during shutdown cleanup", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-live-process-"));
    const handle = startLiveProcess({
      id: "R-test-stop-all",
      workspacePath: tempDir,
      spec: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)"],
        cwd: tempDir
      },
      stdoutPath: path.join(tempDir, "stdout.log"),
      stderrPath: path.join(tempDir, "stderr.log")
    });

    expect(getLiveProcess(tempDir, handle.id)?.pid).toBe(handle.pid);

    stopAllLiveProcesses();

    const result = await handle.done;

    expect(result.exitCode).not.toBe(0);
    expect(getLiveProcess(tempDir, handle.id)).toBeNull();
  });
});
