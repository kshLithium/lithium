import { describe, expect, it } from "vitest";
import { ManuscriptEngine } from "./manuscript-engine";

describe("ManuscriptEngine", () => {
  it("projects the latest strategist and builder artifacts into results", () => {
    const engine = new ManuscriptEngine();
    const output = engine.updateResults({
      decision: {
        id: "D001",
        threadId: "TH001",
        prompt: "Plan next step",
        rawOutput: "",
        summary: "Summarize the latest research direction.",
        rationale: "We need a deterministic end-to-end loop first.",
        model: "gpt-5.4-pro",
        engine: "browser",
        status: "completed",
        command: { command: "npx", args: ["oracle"], cwd: "/tmp/project" },
        stdoutPath: "/tmp/project/stdout.log",
        stderrPath: "/tmp/project/stderr.log",
        outputPath: "/tmp/project/output.txt",
        createdAt: "2026-03-18T00:00:00.000Z"
      },
      run: {
        id: "R001",
        threadId: "TH001",
        taskId: "T001",
        prompt: "Run the smoke test builder task.",
        model: "gpt-5.4",
        status: "completed",
        exitCode: 0,
        pid: null,
        command: { command: "codex", args: ["exec"], cwd: "/tmp/project" },
        stdoutPath: "/tmp/project/run.stdout.log",
        stderrPath: "/tmp/project/run.stderr.log",
        finalMessagePath: "/tmp/project/run.output.txt",
        finalMessage: [
          "Smoke test only. No files changed.",
          "",
          "LITHIUM_STATUS",
          "SUMMARY: smoke test only",
          "FILES: none",
          "RESULT: success"
        ].join("\n"),
        changedFiles: [],
        finalization: "auto",
        createdAt: "2026-03-18T00:01:00.000Z",
        startedAt: "2026-03-18T00:01:00.000Z",
        endedAt: "2026-03-18T00:01:05.000Z"
      }
    });

    expect(output).toContain("Summarize the latest research direction.");
    expect(output).not.toContain("Proposed Next Task");
    expect(output).toContain("smoke test only");
  });
});
