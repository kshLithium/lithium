import { afterEach, describe, expect, it, vi } from "vitest";

const { runCommandMock } = vi.hoisted(() => ({
  runCommandMock: vi.fn()
}));

vi.mock("./process-runner", () => ({
  runCommand: runCommandMock
}));

import { RouterRunner } from "./router-runner";

describe("RouterRunner", () => {
  afterEach(() => {
    runCommandMock.mockReset();
  });

  it("falls back to the original prompt and a default reason when router JSON is incomplete", async () => {
    runCommandMock.mockResolvedValue({
      startedAt: "2026-03-20T00:00:00.000Z",
      endedAt: "2026-03-20T00:00:01.000Z",
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify({
        route: "builder"
      }),
      stderr: ""
    });

    const runner = new RouterRunner();
    const result = await runner.route({
      workspacePath: "/tmp/lithium",
      prompt: "Continue with the latest builder task.",
      stdoutPath: "/tmp/router.stdout.log",
      stderrPath: "/tmp/router.stderr.log",
      outputPath: "/tmp/router.output.log"
    });

    expect(result.decision).toEqual({
      route: "builder",
      rewrittenPrompt: "Continue with the latest builder task.",
      reasonShort: "Router chose builder from the latest chat context."
    });
  });

  it("falls back cleanly to strategist when router output is malformed", async () => {
    runCommandMock.mockResolvedValue({
      startedAt: "2026-03-20T00:00:00.000Z",
      endedAt: "2026-03-20T00:00:01.000Z",
      exitCode: 0,
      timedOut: false,
      stdout: "not valid router output",
      stderr: ""
    });

    const runner = new RouterRunner();
    const result = await runner.route({
      workspacePath: "/tmp/lithium",
      prompt: "What should we research next?",
      stdoutPath: "/tmp/router.stdout.log",
      stderrPath: "/tmp/router.stderr.log",
      outputPath: "/tmp/router.output.log"
    });

    expect(result.decision).toEqual({
      route: "strategist",
      rewrittenPrompt: "What should we research next?",
      reasonShort: "Router output was malformed, so the message fell back to strategist."
    });
  });
});
