import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./process-runner", () => ({
  runCommand: vi.fn()
}));

import { OrchestratorRunner } from "./orchestrator-runner";
import { runCommand } from "./process-runner";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }))));
  vi.clearAllMocks();
});

describe("OrchestratorRunner", () => {
  it("omits exec-only flags when resuming an existing Codex session", () => {
    const runner = new OrchestratorRunner();
    const command = runner.buildCommand(
      "/tmp/workspace",
      "session-123",
      "이어서 진행해줘",
      "/tmp/workspace/.lithium/orchestrator/reply.md",
      "gpt-5.4",
      "xhigh"
    );

    expect(command.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(command.args).not.toContain("--add-dir");
    expect(command.args[command.args.indexOf("--output-last-message") + 2]).toBe("session-123");
    expect(command.args.at(-1)).toBe("이어서 진행해줘");
  });

  it("captures the Codex session id and builder delegation from plain markdown files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "lithium-orch-"));
    tempDirs.push(workspace);
    const requestDir = path.join(workspace, ".lithium", "orchestrator", "TH001");
    const requestPaths = {
      builder: path.join(requestDir, "builder.md"),
      strategist: path.join(requestDir, "strategist.md"),
      automation: path.join(requestDir, "automation.md")
    };
    const outputPath = path.join(requestDir, "reply.md");

    vi.mocked(runCommand).mockImplementationOnce(async (options) => {
      await writeFile(outputPath, "바로 실행할 builder 작업을 정리했습니다.", "utf8");
      await writeFile(
        requestPaths.builder,
        [
          "# Builder Request",
          "Execution: live",
          "Model: gpt-5.3-codex",
          "Reasoning: high",
          "",
          "Run the local eval-only comparison and summarize the metric gap."
        ].join("\n"),
        "utf8"
      );

      return {
        startedAt: "2026-03-24T12:00:00.000Z",
        endedAt: "2026-03-24T12:00:05.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: [
          "{\"type\":\"thread.started\",\"thread_id\":\"orch-thread-1\"}",
          "{\"type\":\"turn.completed\"}"
        ].join("\n"),
        stderr: ""
      };
    });

    const runner = new OrchestratorRunner();
    const result = await runner.runTurn({
      workspacePath: workspace,
      prompt: "이어서 진행해줘",
      runtimeContext: "# Runtime Context",
      stdoutPath: path.join(requestDir, "orchestrator.stdout.log"),
      stderrPath: path.join(requestDir, "orchestrator.stderr.log"),
      outputPath,
      requestPaths
    });

    expect(result.sessionId).toBe("orch-thread-1");
    expect(result.requestedLane).toBe("builder");
    expect(result.delegatedPrompt).toContain("eval-only comparison");
    expect(result.delegation).toEqual({
      lane: "builder",
      prompt: "Run the local eval-only comparison and summarize the metric gap.",
      executionMode: "live",
      model: "gpt-5.3-codex",
      reasoningEffort: "high"
    });
    expect(result.delegations).toEqual([
      {
        lane: "builder",
        prompt: "Run the local eval-only comparison and summarize the metric gap.",
        executionMode: "live",
        model: "gpt-5.3-codex",
        reasoningEffort: "high"
      }
    ]);
    expect(result.finalMessage).toContain("builder 작업");
    expect(result.command.args).toContain("--json");
    expect(result.command.args).toContain("--output-last-message");
  });

  it("captures parallel builder and strategist delegations from separate request files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "lithium-orch-par-"));
    tempDirs.push(workspace);
    const requestDir = path.join(workspace, ".lithium", "orchestrator", "TH009");
    const requestPaths = {
      builder: path.join(requestDir, "builder.md"),
      strategist: path.join(requestDir, "strategist.md"),
      automation: path.join(requestDir, "automation.md")
    };
    const outputPath = path.join(requestDir, "reply.md");

    vi.mocked(runCommand).mockImplementationOnce(async () => {
      await writeFile(outputPath, "두 lane을 병렬로 준비했습니다.", "utf8");
      await writeFile(
        requestPaths.builder,
        [
          "Execution: sync",
          "Model: gpt-5.3-codex",
          "",
          "Run the cheap local eval-only probe and save the metric."
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        requestPaths.strategist,
        [
          "Model: gpt-5.4-pro",
          "Intensity: extended",
          "",
          "Investigate the public leaderboard context and identify the strongest comparison point."
        ].join("\n"),
        "utf8"
      );

      return {
        startedAt: "2026-03-25T01:00:00.000Z",
        endedAt: "2026-03-25T01:00:04.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "{\"type\":\"thread.started\",\"thread_id\":\"orch-thread-9\"}",
        stderr: ""
      };
    });

    const runner = new OrchestratorRunner();
    const result = await runner.runTurn({
      workspacePath: workspace,
      prompt: "리서치랑 로컬 실험을 같이 진행해줘",
      runtimeContext: "# Runtime Context",
      stdoutPath: path.join(requestDir, "orchestrator.stdout.log"),
      stderrPath: path.join(requestDir, "orchestrator.stderr.log"),
      outputPath,
      requestPaths
    });

    expect(result.sessionId).toBe("orch-thread-9");
    expect(result.delegations).toEqual([
      {
        lane: "builder",
        prompt: "Run the cheap local eval-only probe and save the metric.",
        executionMode: "sync",
        model: "gpt-5.3-codex",
        reasoningEffort: undefined
      },
      {
        lane: "strategist",
        prompt: "Investigate the public leaderboard context and identify the strongest comparison point.",
        model: "gpt-5.4-pro",
        reasoningIntensity: "extended",
        attachExplicitWorkspaceFiles: undefined
      }
    ]);
  });

  it("captures multiple parallel strategist delegations from one strategist request file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "lithium-orch-multi-strat-"));
    tempDirs.push(workspace);
    const requestDir = path.join(workspace, ".lithium", "orchestrator", "TH010");
    const requestPaths = {
      builder: path.join(requestDir, "builder.md"),
      strategist: path.join(requestDir, "strategist.md"),
      automation: path.join(requestDir, "automation.md")
    };
    const outputPath = path.join(requestDir, "reply.md");

    vi.mocked(runCommand).mockImplementationOnce(async () => {
      await writeFile(outputPath, "research branches prepared", "utf8");
      await writeFile(
        requestPaths.strategist,
        [
          "Model: gpt-5.4-pro",
          "Intensity: extended",
          "",
          "Review the top-level branch priority and decision gate.",
          "",
          "---",
          "",
          "Model: gpt-5.4-pro",
          "Intensity: extended",
          "",
          "Compare the freshest public baselines that matter after the current gate."
        ].join("\n"),
        "utf8"
      );

      return {
        startedAt: "2026-03-25T01:00:00.000Z",
        endedAt: "2026-03-25T01:00:04.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "{\"type\":\"thread.started\",\"thread_id\":\"orch-thread-10\"}",
        stderr: ""
      };
    });

    const runner = new OrchestratorRunner();
    const result = await runner.runTurn({
      workspacePath: workspace,
      prompt: "세부 연구 판단을 병렬로 나눠줘",
      runtimeContext: "# Runtime Context",
      stdoutPath: path.join(requestDir, "orchestrator.stdout.log"),
      stderrPath: path.join(requestDir, "orchestrator.stderr.log"),
      outputPath,
      requestPaths
    });

    expect(result.requestedLane).toBe("strategist");
    expect(result.delegations).toEqual([
      {
        lane: "strategist",
        prompt: "Review the top-level branch priority and decision gate.",
        model: "gpt-5.4-pro",
        reasoningIntensity: "extended",
        attachExplicitWorkspaceFiles: undefined
      },
      {
        lane: "strategist",
        prompt: "Compare the freshest public baselines that matter after the current gate.",
        model: "gpt-5.4-pro",
        reasoningIntensity: "extended",
        attachExplicitWorkspaceFiles: undefined
      }
    ]);
  });

  it("prepares each lane request directory before the orchestrator writes into split paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "lithium-orch-split-"));
    tempDirs.push(workspace);
    const requestPaths = {
      builder: path.join(workspace, ".lithium", "orchestrator", "builder", "request.md"),
      strategist: path.join(workspace, ".lithium", "orchestrator", "strategist", "request.md"),
      automation: path.join(workspace, ".lithium", "orchestrator", "automation", "request.md")
    };
    const outputPath = path.join(workspace, ".lithium", "orchestrator", "reply.md");

    vi.mocked(runCommand).mockImplementationOnce(async () => {
      await writeFile(requestPaths.strategist, "Investigate the public context.", "utf8");
      await writeFile(outputPath, "Strategist lane를 준비했습니다.", "utf8");

      return {
        startedAt: "2026-03-25T02:00:00.000Z",
        endedAt: "2026-03-25T02:00:01.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "{\"type\":\"thread.resumed\",\"thread_id\":\"orch-thread-split\"}",
        stderr: ""
      };
    });

    const runner = new OrchestratorRunner();
    const result = await runner.runTurn({
      workspacePath: workspace,
      sessionId: "orch-thread-split",
      prompt: "분리된 lane 경로로도 이어서 진행해줘",
      runtimeContext: "# Runtime Context",
      stdoutPath: path.join(workspace, ".lithium", "orchestrator", "stdout.log"),
      stderrPath: path.join(workspace, ".lithium", "orchestrator", "stderr.log"),
      outputPath,
      requestPaths
    });

    expect(result.sessionId).toBe("orch-thread-split");
    expect(result.requestedLane).toBe("strategist");
    expect(result.delegatedPrompt).toBe("Investigate the public context.");
  });
});
