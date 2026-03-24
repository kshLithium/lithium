import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "./process-runner";

describe("process-runner", () => {
  it("waits for completion when no timeout is provided", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-process-runner-"));
    const stdoutPath = path.join(tempDir, "stdout.log");
    const stderrPath = path.join(tempDir, "stderr.log");

    const result = await runCommand({
      spec: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log('finished'), 50)"],
        cwd: tempDir
      },
      stdoutPath,
      stderrPath
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    await expect(readFile(stdoutPath, "utf8")).resolves.toContain("finished");
  });

  it("still enforces explicit timeouts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-process-runner-"));
    const stdoutPath = path.join(tempDir, "stdout.log");
    const stderrPath = path.join(tempDir, "stderr.log");

    const result = await runCommand({
      spec: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log('too late'), 250)"],
        cwd: tempDir
      },
      timeoutMs: 25,
      stdoutPath,
      stderrPath
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});
