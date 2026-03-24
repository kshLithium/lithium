import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OUTPUT_TRUNCATION_MARKER } from "./fs-utils";
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

  it("keeps the beginning and end of long output while preserving the full stdout log on disk", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-process-runner-"));
    const stdoutPath = path.join(tempDir, "stdout.log");
    const stderrPath = path.join(tempDir, "stderr.log");

    const result = await runCommand({
      spec: {
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdout.write('BEGIN\\n');",
            "for (let index = 0; index < 6000; index += 1) {",
            "  process.stdout.write(`chunk-${String(index).padStart(4, '0')}-${'x'.repeat(64)}\\n`);",
            "}",
            "process.stdout.write('END\\n');"
          ].join("")
        ],
        cwd: tempDir
      },
      stdoutPath,
      stderrPath
    });
    const stdoutLog = await readFile(stdoutPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("BEGIN");
    expect(result.stdout).toContain("END");
    expect(result.stdout).toContain(OUTPUT_TRUNCATION_MARKER.trim());
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(Buffer.byteLength(stdoutLog, "utf8"));
    expect(stdoutLog).toContain("BEGIN");
    expect(stdoutLog).toContain("END");
    expect(stdoutLog).not.toContain(OUTPUT_TRUNCATION_MARKER.trim());
  });
});
