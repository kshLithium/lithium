import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./terminal-pty-registry", () => ({
  getLiveTerminal: vi.fn(),
  startLiveTerminal: vi.fn(),
  stopLiveTerminal: vi.fn(),
  writeToLiveTerminal: vi.fn()
}));

import { ResidentOrchestratorRunner } from "./resident-orchestrator-runner";
import {
  getLiveTerminal,
  startLiveTerminal,
  writeToLiveTerminal
} from "./terminal-pty-registry";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }))));
  vi.clearAllMocks();
});

describe("ResidentOrchestratorRunner", () => {
  it("keeps a resident host alive and collects the finished turn from files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "lithium-resident-orch-"));
    tempDirs.push(workspace);
    const requestDir = path.join(workspace, ".lithium", "orchestrator", "TH001");
    const requestPaths = {
      builder: path.join(requestDir, "builder.md"),
      strategist: path.join(requestDir, "strategist.md"),
      automation: path.join(requestDir, "automation.md")
    };
    const stdoutPath = path.join(requestDir, "orchestrator.stdout.log");
    const stderrPath = path.join(requestDir, "orchestrator.stderr.log");
    const outputPath = path.join(requestDir, "orchestrator.reply.md");

    vi.mocked(getLiveTerminal).mockReturnValueOnce(null).mockReturnValue({
      id: "__resident__",
      workspacePath: workspace,
      pid: 1234,
      shell: "sh",
      shellPath: "/bin/sh",
      cwd: workspace,
      cols: 120,
      rows: 32,
      startedAt: "2026-03-24T14:00:00.000Z"
    });
    vi.mocked(startLiveTerminal).mockResolvedValue({
      id: "__resident__",
      workspacePath: workspace,
      pid: 1234,
      shell: "sh",
      shellPath: "/bin/sh",
      cwd: workspace,
      cols: 120,
      rows: 32,
      startedAt: "2026-03-24T14:00:00.000Z"
    });
    vi.mocked(writeToLiveTerminal).mockImplementationOnce((_workspacePath, _id, command) => {
      const exitMatch = command.match(/>\s*'([^']+\/exit\.code)'/);

      void writeFile(stdoutPath, "{\"type\":\"thread.started\",\"thread_id\":\"resident-thread-1\"}\n", "utf8");
      void writeFile(outputPath, "상주 오케스트레이터가 답변했습니다.", "utf8");
      void writeFile(
        requestPaths.builder,
        [
          "Execution: live",
          "Model: gpt-5.4",
          "Reasoning: xhigh",
          "",
          "Run the local compare-only recovery step."
        ].join("\n"),
        "utf8"
      );

      if (exitMatch?.[1]) {
        void writeFile(exitMatch[1], "0", "utf8");
      }

      return true;
    });

    const runner = new ResidentOrchestratorRunner();
    const result = await runner.runTurn({
      workspacePath: workspace,
      sessionId: undefined,
      prompt: "이어서 진행해줘",
      runtimeContext: "# Lithium Runtime Context",
      stdoutPath,
      stderrPath,
      outputPath,
      requestPaths
    });

    expect(startLiveTerminal).toHaveBeenCalledTimes(1);
    expect(writeToLiveTerminal).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("resident-thread-1");
    expect(result.requestedLane).toBe("builder");
    expect(result.delegatedPrompt).toContain("compare-only");
    expect(result.delegation).toEqual({
      lane: "builder",
      prompt: "Run the local compare-only recovery step.",
      executionMode: "live",
      model: "gpt-5.4",
      reasoningEffort: "xhigh"
    });
    expect(result.finalMessage).toContain("상주 오케스트레이터");
  });
});
