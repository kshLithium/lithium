import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../../shared/types";
import type { AppSettings, CommandSpec, RemoteWorkspaceProfile } from "../../shared/types";
import { AppService } from "./app-service";
import { ProjectStore } from "./project-store";
import type {
  RemoteWorkspaceCommandResult,
  RemoteWorkspaceMetadata,
  RemoteWorkspaceServiceLike
} from "./remote-workspace-service";

EventEmitter.defaultMaxListeners = 50;

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupTempDirs(tempDirs.splice(0));
});

describe("AppService", () => {
  it("runs the strategist -> builder -> manuscript loop with fake runners", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:00:00.000Z",
        endedAt: "2026-03-18T01:00:05.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "SUMMARY: Define the no-op builder check.",
          "NEXT_TASK: Make no file changes and return exactly these lines: SUMMARY: smoke test only FILES: none RESULT: success",
          "RATIONALE: We only want to validate the loop."
        ].join("\n")
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => ({
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:01:00.000Z",
        endedAt: "2026-03-18T01:01:04.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        finalMessage: [
          "Smoke test only. I made no file changes and verified the loop wiring.",
          "",
          "LITHIUM_STATUS",
          "SUMMARY: smoke test only",
          "FILES: none",
          "RESULT: success"
        ].join("\n")
      }))
    };
    const app = new AppService(workspace, {
      oracleRunner,
      codexRunner
    });

    await app.initProject(workspace);
    const strategistSnapshot = await app.consultStrategist({
      workspacePath: workspace,
      prompt: "Smoke test the loop."
    });

    expect(strategistSnapshot.latestDecision?.summary).toBe("Define the no-op builder check.");
    expect(strategistSnapshot.latestTask).toBeNull();
    expect(strategistSnapshot.latestDecision?.handoff?.role).toBe("strategist");
    expect(strategistSnapshot.latestDecision?.contextPackPath).toBeUndefined();
    expect(oracleRunner.consult).toHaveBeenCalledTimes(1);
    expect(oracleRunner.consult).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        browserThinkingTime: "heavy",
        files: [expect.stringContaining(".strategist.runtime.md")]
      })
    );
    const strategistConsultCall = ((oracleRunner.consult as any).mock?.calls?.[0]?.[0] ?? null) as
      | { files?: string[] }
      | null;
    const strategistRuntimePath =
      strategistConsultCall && Array.isArray(strategistConsultCall.files)
        ? strategistConsultCall.files[0]
        : undefined;

    expect(strategistRuntimePath).toBeTruthy();
    await expect(readFile(strategistRuntimePath!, "utf8")).resolves.toContain("# Lithium Runtime Context");

    const builderSnapshot = await app.runBuilderTask({
      workspacePath: workspace,
      prompt: "Make no file changes and return exactly these lines: SUMMARY: smoke test only FILES: none RESULT: success"
    });

    expect(builderSnapshot.latestRun?.status).toBe("completed");
    expect(builderSnapshot.latestRun?.finalMessage).toContain("I made no file changes");
    expect(builderSnapshot.latestRun?.finalMessage).toContain("RESULT: success");
    expect(builderSnapshot.latestRun?.handoff?.role).toBe("builder");
    expect(builderSnapshot.latestRun?.contextPackPath).toContain(".lithium/context/R001.builder.md");
    expect(codexRunner.runTask).toHaveBeenCalledTimes(1);
    expect(codexRunner.runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
        runtimeContext: expect.stringContaining("Latest strategist summary: Define the no-op builder check."),
        artifactContext: expect.stringContaining("## Latest Decision")
      })
    );

    const paperSnapshot = await app.updateManuscript(workspace);

    expect(paperSnapshot.manuscript?.content).toContain("Define the no-op builder check.");
    expect(paperSnapshot.manuscript?.content).toContain("smoke test only");
    expect(paperSnapshot.memory?.sessionSummary).toContain("Latest research run: R001");
  });

  it("routes every chat message through codex before forwarding research requests to the strategist", async () => {
    const workspace = await createWorkspace();
    const routerRunner = {
      route: vi.fn(async () => ({
        decision: {
          route: "strategist" as const,
          rewrittenPrompt: "Compare the related work and decide the next literature move.",
          reasonShort: "The user asked for research judgment."
        },
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:10:00.000Z",
        endedAt: "2026-03-18T01:10:02.000Z",
        exitCode: 0,
        timedOut: false,
        rawOutput: ""
      }))
    };
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:10:03.000Z",
        endedAt: "2026-03-18T01:10:06.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "SUMMARY: Literature comparison complete.",
          "NEXT_TASK: Keep the builder idle.",
          "RATIONALE: This was a research-only request."
        ].join("\n")
      }))
    };
    const app = new AppService(workspace, {
      routerRunner,
      oracleRunner
    });

    await app.initProject(workspace);
    const snapshot = await app.sendChatMessage({
      workspacePath: workspace,
      prompt: "What should we read next before changing code?"
    });

    expect(routerRunner.route).toHaveBeenCalledTimes(1);
    expect(oracleRunner.consult).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Compare the related work and decide the next literature move."
      })
    );
    expect(snapshot.latestDecision?.summary).toBe("Literature comparison complete.");
  });

  it("writes chat and prompt traces to an append-only jsonl log", async () => {
    const workspace = await createWorkspace();
    const routerRunner = {
      route: vi.fn(async () => ({
        decision: {
          route: "strategist" as const,
          rewrittenPrompt: "Research modern SVM variants and identify one concrete next step.",
          reasonShort: "The user asked for research."
        },
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:10:00.000Z",
        endedAt: "2026-03-18T01:10:02.000Z",
        exitCode: 0,
        timedOut: false,
        rawOutput: ""
      }))
    };
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:10:03.000Z",
        endedAt: "2026-03-18T01:10:06.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "최신 SVM 변형을 먼저 정리하겠습니다.",
          "",
          "LITHIUM_HANDOFF",
          JSON.stringify({
            summary: "현대 SVM 계열을 먼저 정리해야 한다.",
            next_task: "Survey post-2020 SVM variants and build a gap table."
          })
        ].join("\n")
      }))
    };
    const app = new AppService(workspace, {
      routerRunner,
      oracleRunner
    });

    await app.initProject(workspace);
    await app.sendChatMessage({
      workspacePath: workspace,
      prompt: "새로운 svm 알고리즘에 대해서 리서치해줘"
    });

    const promptLogPath = path.join(workspace, ".lithium", "prompt-log.jsonl");
    const raw = await readFile(promptLogPath, "utf8");
    const entries = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "chat.user",
      "chat.router",
      "strategist.request",
      "strategist.response"
    ]);
    expect(entries[0]?.prompt).toBe("새로운 svm 알고리즘에 대해서 리서치해줘");
    expect(entries[1]?.rewrittenPrompt).toBe(
      "Research modern SVM variants and identify one concrete next step."
    );
    expect(entries[2]?.runtimeContext).toEqual(expect.stringContaining("# Lithium Runtime Context"));
    expect(entries[3]?.summary).toBe("현대 SVM 계열을 먼저 정리해야 한다.");
  });

  it("rejects truncated strategist outputs instead of persisting them into thread memory", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:10:03.000Z",
        endedAt: "2026-03-18T01:10:06.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: "I’m"
      }))
    };
    const app = new AppService(workspace, {
      oracleRunner
    });

    await app.initProject(workspace);

    await expect(
      app.consultStrategist({
        workspacePath: workspace,
        prompt: "Identify the main research question."
      })
    ).rejects.toThrow(/truncated or non-final/i);

    const snapshot = await app.getSnapshot(workspace);
    expect(snapshot.latestDecision).toBeNull();
    expect(snapshot.activeThread?.summary).not.toBe("I’m");
  });

  it("keeps strategist automation prompts close to the user's original objective", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:10:03.000Z",
        endedAt: "2026-03-18T01:10:06.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "LITHIUM_HANDOFF",
          JSON.stringify({
            summary: "지금은 최신 SVM 계열을 먼저 정리하는 게 맞습니다.",
            next_task: "notes/algorithm-landscape.md에 최신 SVM 계열과 차별화 포인트를 정리해라.",
            rationale: "새 방향을 논하기 전에 현재 계열 지형을 정리해야 한다.",
            files: ["notes/algorithm-landscape.md"],
            risks: [],
            paper_actions: [],
            run_actions: [],
            success_criteria: ["노트에 최신 SVM 계열과 차별화 포인트가 정리된다."],
            open_questions: ["어떤 축에서 기존 SVM과 차별화할 것인가?"]
          })
        ].join("\n")
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => ({
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:10:07.000Z",
        endedAt: "2026-03-18T01:10:08.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        finalMessage: [
          "Research note only.",
          "",
          "LITHIUM_STATUS",
          '{"summary":"research note only","result":"success"}'
        ].join("\n")
      })),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      oracleRunner,
      codexRunner,
      getAppSettings: async () => ({
        ...DEFAULT_APP_SETTINGS,
        strategistSessionReady: true
      })
    });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "새로운 svm 알고리즘에 대해서 리서치하고 우리도 하나 발명해줘",
      mode: "checkpoint",
      maxSteps: 64,
      maxRuntimeMinutes: 24 * 60,
      maxRetries: 8,
      paperWriteEnabled: false
    });
    const sessionId = createdSnapshot.latestAutomationSession?.id;

    expect(sessionId).toBeTruthy();

    await app.startAutomationSession({
      workspacePath: workspace,
      sessionId: sessionId as string
    });

    await vi.waitFor(async () => {
      expect(oracleRunner.consult).toHaveBeenCalledTimes(1);
    });

    expect(oracleRunner.consult).toHaveBeenCalledTimes(1);
    expect(oracleRunner.consult).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("새로운 svm 알고리즘에 대해서 리서치하고 우리도 하나 발명해줘"),
        files: [expect.stringContaining(".strategist.runtime.md")],
        strategistSessionReady: true
      })
    );

    const strategistCalls = oracleRunner.consult.mock.calls as unknown as Array<
      [{ prompt?: string; files?: string[] }]
    >;
    const strategistInput = strategistCalls[0]?.[0];
    expect(strategistInput?.prompt).not.toContain("Remaining budget");
    expect(strategistInput?.prompt).not.toContain("Project context is attached");
    expect(strategistInput?.prompt).not.toContain("Choose the single highest-value next bounded action");
    expect(strategistInput?.prompt).not.toContain("NEXT_TASK:");
    expect(strategistInput?.prompt).not.toContain("If you cite sources, use normal markdown links.");
    expect(strategistInput?.prompt).toBe("새로운 svm 알고리즘에 대해서 리서치하고 우리도 하나 발명해줘");
    await vi.waitFor(async () => {
      expect(codexRunner.buildTaskCommand).toHaveBeenCalledTimes(1);
    });
    const builderCalls = codexRunner.buildTaskCommand?.mock.calls as unknown as Array<
      [string, string]
    >;
    const builderPrompt = builderCalls?.[0]?.[1] ?? "";
    expect(builderPrompt).toContain("새로운 svm 알고리즘에 대해서 리서치하고 우리도 하나 발명해줘");
    expect(builderPrompt).toContain("Strategist summary:");
    expect(builderCalls?.[0]?.[1]).toContain("Success criteria:");
    expect(builderCalls?.[0]?.[1]).toContain("Open questions:");
    const promptLog = await readFile(path.join(workspace, ".lithium", "prompt-log.jsonl"), "utf8");
    expect(promptLog).toContain("## Latest Decision");

    await app.interruptAutomationSession({
      workspacePath: workspace,
      sessionId: sessionId as string,
      instruction: "Stop test automation.",
      stopNow: true
    });

    await vi.waitFor(async () => {
      const snapshot = await app.getSnapshot(workspace);
      expect(snapshot.latestAutomationSession?.status).toBe("idle");
      expect(snapshot.latestAutomationSession?.currentStepSummary).toBe("Automation stopped by the user.");
      expect(snapshot.latestAutomationCheckpoint?.status).not.toBe("pending");
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  it("keeps automation running and records a status update when the user asks for progress", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      consult: vi.fn(async (): Promise<any> => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          command: { command: "npx", args: ["oracle"], cwd: workspace },
          startedAt: "2026-03-18T01:10:03.000Z",
          endedAt: "2026-03-18T01:10:08.000Z",
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          outputText: "SUMMARY: delayed strategist response."
        };
      }),
      terminateSession: vi.fn(async () => undefined)
    };
    const app = new AppService(workspace, {
      oracleRunner,
      getAppSettings: async () => ({
        ...DEFAULT_APP_SETTINGS,
        strategistSessionReady: true
      })
    });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "새로운 tabular OOD detection 방향을 길게 연구해줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 4,
      paperWriteEnabled: false
    });
    const sessionId = createdSnapshot.latestAutomationSession?.id;

    await app.startAutomationSession({
      workspacePath: workspace,
      sessionId: sessionId as string
    });

    await vi.waitFor(() => {
      expect(oracleRunner.consult).toHaveBeenCalledTimes(1);
    });
    const terminateCallsBeforeInterrupt = oracleRunner.terminateSession.mock.calls.length;

    await app.interruptAutomationSession({
      workspacePath: workspace,
      sessionId: sessionId as string,
      instruction: "지금까지 진행사항 보고좀",
      stopNow: false
    });

    expect(oracleRunner.terminateSession.mock.calls.length).toBe(terminateCallsBeforeInterrupt);
    const snapshotAfterInterrupt = await app.getSnapshot(workspace);
    expect(snapshotAfterInterrupt.latestAutomationSession?.status).toBe("running");
    expect(snapshotAfterInterrupt.latestAutomationSession?.latestCheckpointId).toBeUndefined();
    expect(snapshotAfterInterrupt.latestAutomationCheckpoint?.status).toBe("approved");
    expect(snapshotAfterInterrupt.latestAutomationCheckpoint?.title).toBe("Automation update");
    expect(snapshotAfterInterrupt.latestAutomationCheckpoint?.userResponse).toBe("지금까지 진행사항 보고좀");
    expect(snapshotAfterInterrupt.latestAutomationCheckpoint?.summary).toContain(
      "현재 단계 작업을 계속 진행하고 있습니다."
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  it("stops running automation when the user sends a stop-style chat message", async () => {
    const workspace = await createWorkspace();
    let releaseConsult!: () => void;
    const oracleRunner = {
      consult: vi.fn(async (): Promise<any> => {
        await new Promise<void>((resolve) => {
          releaseConsult = resolve;
        });

        return {
          command: { command: "npx", args: ["oracle"], cwd: workspace },
          startedAt: "2026-03-18T01:10:03.000Z",
          endedAt: "2026-03-18T01:10:08.000Z",
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          outputText: "SUMMARY: delayed strategist response."
        };
      }),
      terminateSession: vi.fn(async () => undefined)
    };
    const app = new AppService(workspace, {
      oracleRunner,
      getAppSettings: async () => ({
        ...DEFAULT_APP_SETTINGS,
        strategistSessionReady: true
      })
    });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "실험 자동연구를 계속 진행해줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 4,
      paperWriteEnabled: false
    });
    const sessionId = createdSnapshot.latestAutomationSession?.id;
    const threadId = createdSnapshot.activeThreadId ?? createdSnapshot.threads[0]?.id;

    await app.startAutomationSession({
      workspacePath: workspace,
      sessionId: sessionId as string
    });

    await vi.waitFor(() => {
      expect(oracleRunner.consult).toHaveBeenCalledTimes(1);
    });

    const stoppedSnapshot = await app.sendChatMessage({
      workspacePath: workspace,
      threadId: threadId as string,
      prompt: "연구 중단"
    });

    expect(stoppedSnapshot.latestAutomationSession?.status).toBe("idle");
    expect(stoppedSnapshot.latestAutomationSession?.stopReason).toBe("연구 중단");
    expect(stoppedSnapshot.latestAutomationCheckpoint?.title).toBe("Automation interrupted");
    expect(stoppedSnapshot.latestAutomationCheckpoint?.status).toBe("approved");
    expect(stoppedSnapshot.latestAutomationCheckpoint?.userResponse).toBe("연구 중단");
    expect(oracleRunner.terminateSession).toHaveBeenCalled();

    releaseConsult();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("keeps continuous automation running and replans after a failed builder step", async () => {
    const workspace = await createWorkspace();
    let releaseSecondConsult!: () => void;
    const oracleRunner = {
      consult: vi.fn(async (input: { prompt: string }): Promise<any> => {
        if (oracleRunner.consult.mock.calls.length === 1) {
          return {
            command: { command: "npx", args: ["oracle"], cwd: workspace },
            startedAt: "2026-03-18T01:10:03.000Z",
            endedAt: "2026-03-18T01:10:04.000Z",
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            outputText: "SUMMARY: Try the first implementation path."
          };
        }

        await new Promise<void>((resolve) => {
          releaseSecondConsult = resolve;
        });

        return {
          command: { command: "npx", args: ["oracle"], cwd: workspace },
          startedAt: "2026-03-18T01:10:05.000Z",
          endedAt: "2026-03-18T01:10:06.000Z",
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          outputText: `SUMMARY: Recover after the failed builder step.\nRATIONALE: ${input.prompt}`
        };
      }),
      terminateSession: vi.fn(async () => undefined)
    };
    let builderCallCount = 0;
    const codexRunner = {
      runTask: vi.fn(async () => {
        throw new Error("runTask should not be used in automation live-run tests");
      }),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) => {
        builderCallCount += 1;
        return builderCallCount === 1
          ? buildFailedBuilderCommand(cwd, prompt, outputPath)
          : buildDelayedBuilderCommand(cwd, prompt, outputPath, 5_000);
      })
    };
    const app = new AppService(workspace, {
      oracleRunner,
      codexRunner,
      getAppSettings: async () => ({
        ...DEFAULT_APP_SETTINGS,
        strategistSessionReady: true
      })
    });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "빌드 오류가 나도 자동으로 계속 해결해줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 3,
      paperWriteEnabled: false
    });
    const sessionId = createdSnapshot.latestAutomationSession?.id;

    await app.startAutomationSession({
      workspacePath: workspace,
      sessionId: sessionId as string
    });

    await vi.waitFor(() => {
      expect(oracleRunner.consult).toHaveBeenCalledTimes(2);
    }, { timeout: 5_000 });

    const snapshot = await app.getSnapshot(workspace);
    expect(snapshot.latestAutomationSession?.status).toBe("running");
    expect(snapshot.latestAutomationSession?.latestCheckpointId).toBeUndefined();
    expect(snapshot.latestAutomationSession?.budget.usedRetries).toBe(1);
    expect(snapshot.latestAutomationCheckpoint?.title).toBe("Automation update");
    expect(snapshot.latestAutomationCheckpoint?.summary).toContain("자동으로 다음 복구 경로를 정리하고 있습니다.");
    expect(snapshot.latestAutomationCheckpoint?.status).toBe("approved");
    expect((oracleRunner.consult.mock.calls[1]?.[0] as { prompt?: string })?.prompt).toMatch(/failed|실패/);

    releaseSecondConsult();

    await app.interruptAutomationSession({
      workspacePath: workspace,
      sessionId: sessionId as string,
      instruction: "Stop test automation.",
      stopNow: true
    });
  });

  it("routes pending automation checkpoint questions to a builder chat reply instead of strategist replanning", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const routerRunner = {
      route: vi.fn(async () => {
        throw new Error("router should not run for pending automation checkpoint questions");
      })
    };
    const oracleRunner = {
      consult: vi.fn(async () => {
        throw new Error("strategist should not run for pending automation checkpoint questions");
      })
    };
    const codexRunner = {
      runTask: vi.fn(async () => {
        throw new Error("runTask should not be used in this test.");
      }),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      store,
      routerRunner,
      oracleRunner,
      codexRunner
    });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "parameter-golf 자동 연구를 이어가줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 4,
      paperWriteEnabled: false
    });
    const session = createdSnapshot.latestAutomationSession!;
    const now = new Date().toISOString();

    await store.writeAutomationCheckpoint(workspace, {
      id: "AC910",
      sessionId: session.id,
      threadId: session.threadId,
      status: "pending",
      title: "Automation interrupted after app restart",
      summary: "Automation stopped when Lithium restarted during the builder step.",
      whatChanged: [],
      evidence: ["R041"],
      risks: ["Automation stopped when Lithium restarted during the builder step."],
      nextActions: ["Resume automation to continue from the latest saved state."],
      createdAt: now,
      updatedAt: now
    });
    await store.writeAutomationSession(workspace, {
      ...session,
      status: "idle",
      latestCheckpointId: "AC910",
      currentStepSummary: "Automation was interrupted when Lithium restarted. Waiting for your direction.",
      stopReason: "Automation stopped when Lithium restarted during the builder step.",
      endedAt: now,
      updatedAt: now
    });

    const snapshot = await app.sendChatMessage({
      workspacePath: workspace,
      prompt: "그래서 깃헙 상위권 기준으로 이미 좋아진거임?"
    });

    expect(routerRunner.route).not.toHaveBeenCalled();
    expect(oracleRunner.consult).not.toHaveBeenCalled();
    expect(codexRunner.buildTaskCommand).toHaveBeenCalledTimes(1);
    expect(snapshot.latestRun?.status).toBe("running");
    expect(snapshot.latestRun?.displayPrompt).toBe("그래서 깃헙 상위권 기준으로 이미 좋아진거임?");
    expect(snapshot.latestRun?.prompt).toContain("사용자 질문: 그래서 깃헙 상위권 기준으로 이미 좋아진거임?");
    expect(snapshot.latestRun?.prompt).toContain("새 strategist 재계획으로 보내지 말고");
    expect(snapshot.latestAutomationCheckpoint?.status).toBe("pending");
    expect(snapshot.latestAutomationSession?.status).toBe("idle");
  });

  it("does not turn checkpoint-question approvals into redirect instructions", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const oracleRunner = {
      consult: vi.fn(async () => {
        throw new Error("strategist should not run for checkpoint questions");
      })
    };
    const codexRunner = {
      runTask: vi.fn(async () => {
        throw new Error("runTask should not be used in this test.");
      }),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      store,
      oracleRunner,
      codexRunner
    });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "parameter-golf 자동 연구를 이어가줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 4,
      paperWriteEnabled: false
    });
    const session = createdSnapshot.latestAutomationSession!;
    const now = new Date().toISOString();

    await store.writeAutomationCheckpoint(workspace, {
      id: "AC911",
      sessionId: session.id,
      threadId: session.threadId,
      status: "pending",
      title: "Automation interrupted after app restart",
      summary: "Automation stopped when Lithium restarted during the builder step.",
      whatChanged: [],
      evidence: ["R042"],
      risks: ["Automation stopped when Lithium restarted during the builder step."],
      nextActions: ["Resume automation to continue from the latest saved state."],
      createdAt: now,
      updatedAt: now
    });
    await store.writeAutomationSession(workspace, {
      ...session,
      status: "idle",
      latestCheckpointId: "AC911",
      currentStepSummary: "Automation was interrupted when Lithium restarted. Waiting for your direction.",
      stopReason: "Automation stopped when Lithium restarted during the builder step.",
      endedAt: now,
      updatedAt: now
    });

    const snapshot = await app.approveAutomationCheckpoint({
      workspacePath: workspace,
      sessionId: session.id,
      checkpointId: "AC911",
      response: "왜 여기서 멈춘거야?"
    });

    expect(oracleRunner.consult).not.toHaveBeenCalled();
    expect(codexRunner.buildTaskCommand).toHaveBeenCalledTimes(1);
    expect(snapshot.latestRun?.prompt).toContain("사용자 질문: 왜 여기서 멈춘거야?");
    expect(snapshot.latestAutomationCheckpoint?.status).toBe("pending");
    expect(snapshot.latestAutomationSession?.status).toBe("idle");
    expect(snapshot.latestAutomationSession?.queuedUserInstruction).toBeUndefined();
  });

  it("stops continuous automation for review after exhausting the retry budget", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      consult: vi.fn(async (): Promise<any> => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:10:03.000Z",
        endedAt: "2026-03-18T01:10:04.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: "SUMMARY: Attempt the next fix."
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => {
        throw new Error("runTask should not be used in automation live-run tests");
      }),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildFailedBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      oracleRunner,
      codexRunner,
      getAppSettings: async () => ({
        ...DEFAULT_APP_SETTINGS,
        strategistSessionReady: true
      })
    });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "빌드 실패를 고쳐줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 1,
      paperWriteEnabled: false
    });
    const sessionId = createdSnapshot.latestAutomationSession?.id;

    await app.startAutomationSession({
      workspacePath: workspace,
      sessionId: sessionId as string
    });

    await vi.waitFor(async () => {
      const snapshot = await app.getSnapshot(workspace);
      expect(snapshot.latestAutomationSession?.status).toBe("idle");
      expect(snapshot.latestAutomationSession?.budget.usedRetries).toBe(1);
      expect(snapshot.latestAutomationCheckpoint?.title).toBe("Automation needs review after a failed run");
    }, { timeout: 5_000 });
  });

  it("marks the strategist step failed and surfaces a blocked checkpoint when strategist output is empty", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      consult: vi.fn(async (): Promise<any> => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:10:03.000Z",
        endedAt: "2026-03-18T01:10:04.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: ""
      }))
    };
    const app = new AppService(workspace, {
      oracleRunner,
      getAppSettings: async () => ({
        ...DEFAULT_APP_SETTINGS,
        strategistSessionReady: true
      })
    });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "parameter-golf 프로젝트를 리서치해줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 4,
      paperWriteEnabled: false
    });

    await app.startAutomationSession({
      workspacePath: workspace,
      sessionId: createdSnapshot.latestAutomationSession?.id as string
    });

    await vi.waitFor(async () => {
      const snapshot = await app.getSnapshot(workspace);
      expect(snapshot.latestAutomationSession?.status).toBe("idle");
      expect(snapshot.latestAutomationCheckpoint?.title).toBe("Automation blocked on the strategist run");
      expect(snapshot.latestAutomationSession?.currentStepSummary).toBe(
        "Blocked on the strategist run. Waiting for your direction."
      );
      expect(snapshot.automationSteps?.at(-1)?.status).toBe("failed");
      expect(snapshot.automationSteps?.at(-1)?.summary).toContain(
        "Oracle strategist run completed without producing output."
      );
    }, { timeout: 5_000 });
  });

  it("consumes queued user instructions once instead of reusing stale instructions across later builder steps", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      consult: vi.fn(async (): Promise<any> => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:10:03.000Z",
        endedAt: "2026-03-18T01:10:04.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: "SUMMARY: Follow the redirected baseline experiment."
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => {
        throw new Error("runTask should not be used in automation live-run tests");
      }),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const store = new ProjectStore();
    const app = new AppService(workspace, {
      oracleRunner,
      codexRunner,
      store,
      getAppSettings: async () => ({
        ...DEFAULT_APP_SETTINGS,
        strategistSessionReady: true
      })
    });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "원래 objective로 baseline을 잡아줘",
      mode: "continuous",
      maxSteps: 1,
      maxRuntimeMinutes: 30,
      maxRetries: 2,
      paperWriteEnabled: false
    });
    const session = createdSnapshot.latestAutomationSession!;

    await store.writeAutomationSession(workspace, {
      ...session,
      lastUserInstruction: "이전 stale instruction",
      queuedUserInstruction: "새 redirect instruction",
      updatedAt: new Date().toISOString()
    });

    await app.startAutomationSession({
      workspacePath: workspace,
      sessionId: session.id
    });

    await vi.waitFor(async () => {
      const snapshot = await app.getSnapshot(workspace);
      expect(snapshot.latestRun?.status).toBe("completed");
      expect(snapshot.latestAutomationSession?.status).toBe("idle");
      expect(snapshot.latestAutomationSession?.queuedUserInstruction).toBeUndefined();
    }, { timeout: 5_000 });

    const builderPrompt = (codexRunner.buildTaskCommand.mock.calls[0]?.[1] as string) ?? "";
    expect(builderPrompt).toContain("새 redirect instruction");
    expect(builderPrompt).not.toContain("이전 stale instruction");
  });

  it("runs live builder tasks from a single nested repository and activates its virtualenv", async () => {
    const workspace = await createWorkspace();
    const repoPath = path.join(workspace, "official");
    const virtualEnvPath = path.join(repoPath, ".venv");

    await mkdir(repoPath, { recursive: true });
    await mkdir(path.join(virtualEnvPath, "bin"), { recursive: true });
    await writeFile(path.join(virtualEnvPath, "bin", "python3"), "", "utf8");
    execFileSync("git", ["init"], { cwd: repoPath });

    const codexRunner = {
      runTask: vi.fn(async () => {
        throw new Error("runTask should not be used in live builder tests");
      }),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildExecutionContextCaptureCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      codexRunner
    });

    await app.initProject(workspace);
    await app.startBuilderTask({
      workspacePath: workspace,
      prompt: "Capture the live builder execution context."
    });

    await vi.waitFor(async () => {
      const snapshot = await app.getSnapshot(workspace);
      expect(snapshot.latestRun?.status).toBe("completed");
    });

    const snapshot = await app.getSnapshot(workspace);
    const canonicalRepoPath = await realpath(repoPath).catch(() => repoPath);
    const canonicalVirtualEnvPath = await realpath(virtualEnvPath).catch(() => virtualEnvPath);
    expect(snapshot.latestRun?.command.cwd).toBe(canonicalRepoPath);
    expect(snapshot.latestRun?.finalMessage).toContain(`cwd=${canonicalRepoPath}`);
    expect(snapshot.latestRun?.finalMessage).toContain(`venv=${canonicalVirtualEnvPath}`);
  });

  it("auto-finalizes builder runs once output exists even if the process never exits", async () => {
    const workspace = await createWorkspace();
    const previousFinalizationThreshold = process.env.LITHIUM_RUN_FINALIZATION_THRESHOLD_MS;
    const previousHungThreshold = process.env.LITHIUM_RUN_HUNG_THRESHOLD_MS;
    process.env.LITHIUM_RUN_FINALIZATION_THRESHOLD_MS = "50";
    process.env.LITHIUM_RUN_HUNG_THRESHOLD_MS = "5000";

    try {
      const codexRunner = {
        runTask: vi.fn(async () => {
          throw new Error("runTask should not be used in live builder tests");
        }),
        buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
          buildOutputThenHangBuilderCommand(cwd, prompt, outputPath)
        )
      };
      const app = new AppService(workspace, {
        codexRunner
      });

      await app.initProject(workspace);
      const startedSnapshot = await app.startBuilderTask({
        workspacePath: workspace,
        prompt: "Finalize once the output file exists."
      });
      const runId = startedSnapshot.latestRun?.id;

      expect(runId).toBeTruthy();

      const completedSnapshot = await (app as any).waitForAutomationRun(workspace, runId, {
        running: true,
        pauseRequested: false,
        stopRequested: false,
        redirectInstruction: "",
        activeRunId: runId,
        activeStrategistSlug: null
      });

      expect(completedSnapshot.latestRun?.status).toBe("completed");
      expect(completedSnapshot.latestRun?.finalization).toBe("auto");
      expect(completedSnapshot.latestRun?.finalMessage).toContain("Completed builder task");
    } finally {
      restoreEnv("LITHIUM_RUN_FINALIZATION_THRESHOLD_MS", previousFinalizationThreshold);
      restoreEnv("LITHIUM_RUN_HUNG_THRESHOLD_MS", previousHungThreshold);
    }
  });

  it("fails hung builder runs instead of waiting forever for a missing final message", async () => {
    const workspace = await createWorkspace();
    const previousFinalizationThreshold = process.env.LITHIUM_RUN_FINALIZATION_THRESHOLD_MS;
    const previousHungThreshold = process.env.LITHIUM_RUN_HUNG_THRESHOLD_MS;
    process.env.LITHIUM_RUN_FINALIZATION_THRESHOLD_MS = "50";
    process.env.LITHIUM_RUN_HUNG_THRESHOLD_MS = "100";

    try {
      const codexRunner = {
        runTask: vi.fn(async () => {
          throw new Error("runTask should not be used in live builder tests");
        }),
        buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
          buildSilentHungBuilderCommand(cwd, prompt, outputPath)
        )
      };
      const app = new AppService(workspace, {
        codexRunner
      });

      await app.initProject(workspace);
      const startedSnapshot = await app.startBuilderTask({
        workspacePath: workspace,
        prompt: "Detect the stalled builder."
      });
      const runId = startedSnapshot.latestRun?.id;

      expect(runId).toBeTruthy();

      const failedSnapshot = await (app as any).waitForAutomationRun(workspace, runId, {
        running: true,
        pauseRequested: false,
        stopRequested: false,
        redirectInstruction: "",
        activeRunId: runId,
        activeStrategistSlug: null
      });

      expect(failedSnapshot.latestRun?.status).toBe("failed");
      expect(failedSnapshot.latestRun?.finalization).toBe("auto");
      expect(failedSnapshot.latestRun?.finalMessage).toContain(
        "Builder run stalled without producing a final answer."
      );
    } finally {
      restoreEnv("LITHIUM_RUN_FINALIZATION_THRESHOLD_MS", previousFinalizationThreshold);
      restoreEnv("LITHIUM_RUN_HUNG_THRESHOLD_MS", previousHungThreshold);
    }
  });

  it("waits through a quiet active command before treating the builder as hung", async () => {
    const workspace = await createWorkspace();
    const previousFinalizationThreshold = process.env.LITHIUM_RUN_FINALIZATION_THRESHOLD_MS;
    const previousHungThreshold = process.env.LITHIUM_RUN_HUNG_THRESHOLD_MS;
    const previousActiveHungThreshold = process.env.LITHIUM_RUN_ACTIVE_COMMAND_HUNG_THRESHOLD_MS;
    process.env.LITHIUM_RUN_FINALIZATION_THRESHOLD_MS = "50";
    process.env.LITHIUM_RUN_HUNG_THRESHOLD_MS = "100";
    process.env.LITHIUM_RUN_ACTIVE_COMMAND_HUNG_THRESHOLD_MS = "800";

    try {
      const codexRunner = {
        runTask: vi.fn(async () => {
          throw new Error("runTask should not be used in live builder tests");
        }),
        buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
          buildQuietActiveCommandBuilder(cwd, prompt, outputPath, 250)
        )
      };
      const app = new AppService(workspace, {
        codexRunner
      });

      await app.initProject(workspace);
      const startedSnapshot = await app.startBuilderTask({
        workspacePath: workspace,
        prompt: "Wait for the long compare to finish."
      });
      const runId = startedSnapshot.latestRun?.id;

      expect(runId).toBeTruthy();

      const completedSnapshot = await (app as any).waitForAutomationRun(workspace, runId, {
        running: true,
        pauseRequested: false,
        stopRequested: false,
        redirectInstruction: "",
        activeRunId: runId,
        activeStrategistSlug: null
      });

      expect(completedSnapshot.latestRun?.status).toBe("completed");
      expect(completedSnapshot.latestRun?.finalMessage).toContain("quiet active command completed");
    } finally {
      restoreEnv("LITHIUM_RUN_FINALIZATION_THRESHOLD_MS", previousFinalizationThreshold);
      restoreEnv("LITHIUM_RUN_HUNG_THRESHOLD_MS", previousHungThreshold);
      restoreEnv(
        "LITHIUM_RUN_ACTIVE_COMMAND_HUNG_THRESHOLD_MS",
        previousActiveHungThreshold
      );
    }
  });

  it("ignores shell snapshot cleanup warnings when reconstructing a missing builder final message", async () => {
    const workspace = await createWorkspace();
    const app = new AppService(workspace);
    const outputPath = path.join(workspace, "missing.output.txt");
    const stdoutPath = path.join(workspace, "run.stdout.log");
    const stderrPath = path.join(workspace, "run.stderr.log");

    await writeFile(
      stdoutPath,
      [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            status: "failed",
            aggregated_output: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'mlx'\n"
          }
        })
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      stderrPath,
      '2026-03-23T08:36:33.551502Z WARN codex_core::shell_snapshot: Failed to delete shell snapshot at "/tmp/x": Os { code: 2, kind: NotFound, message: "No such file or directory" }\n',
      "utf8"
    );

    const finalMessage = await (app as any).readRunFinalMessage(outputPath, stdoutPath, stderrPath);

    expect(finalMessage).toContain("ModuleNotFoundError: No module named 'mlx'");
    expect(finalMessage).not.toContain("shell_snapshot");
  });

  it("reconciles stale running automation sessions after the app restarts", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const app = new AppService(workspace, { store });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "parameter-golf 프로젝트를 끝까지 검토해줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 4,
      paperWriteEnabled: false
    });
    const session = createdSnapshot.latestAutomationSession!;
    const stepId = (await store.allocateAutomationStep(workspace)).id;
    const now = new Date().toISOString();

    await store.writeAutomationStep(workspace, {
      id: stepId,
      sessionId: session.id,
      threadId: session.threadId,
      kind: "strategize",
      lane: "strategist",
      title: "Plan the next bounded research step",
      prompt: "Continue the research automation.",
      status: "running",
      summary: "Step started.",
      changedFiles: [],
      evidence: [],
      checkpointRequired: false,
      createdAt: now,
      updatedAt: now
    });
    await store.writeAutomationSession(workspace, {
      ...session,
      status: "running",
      latestStepId: stepId,
      latestCheckpointId: undefined,
      currentStepSummary: "Plan the next bounded research step",
      stopReason: undefined,
      endedAt: undefined,
      updatedAt: now
    });

    const restartedApp = new AppService(workspace, { store });
    const snapshot = await restartedApp.getSnapshot(workspace);

    expect(snapshot.latestAutomationSession?.status).toBe("idle");
    expect(snapshot.latestAutomationSession?.currentStepSummary).toBe(
      "Automation was interrupted when Lithium restarted. Waiting for your direction."
    );
    expect(snapshot.latestAutomationCheckpoint?.title).toBe("Automation interrupted after app restart");
    expect(snapshot.automationSteps?.find((step) => step.id === stepId)?.status).toBe("failed");
  });

  it("clears stale stop metadata when automation resumes", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const app = new AppService(workspace, { store });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "parameter-golf를 다시 이어서 진행해줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 4,
      paperWriteEnabled: false
    });
    const session = createdSnapshot.latestAutomationSession!;
    const now = new Date().toISOString();

    await store.writeAutomationSession(workspace, {
      ...session,
      status: "idle",
      currentStepSummary: "Automation was interrupted when Lithium restarted. Waiting for your direction.",
      stopReason: "Automation interrupted after app restart",
      endedAt: now,
      updatedAt: now
    });

    const resumedSnapshot = await app.resumeAutomationSession({
      workspacePath: workspace,
      sessionId: session.id
    });

    expect(resumedSnapshot.latestAutomationSession?.id).toBe(session.id);
    expect(resumedSnapshot.latestAutomationSession?.status).toBe("running");
    expect(resumedSnapshot.latestAutomationSession?.currentStepSummary).toBe("Automation resumed.");
    expect(resumedSnapshot.latestAutomationSession?.stopReason).toBeUndefined();
    expect(resumedSnapshot.latestAutomationSession?.endedAt).toBeUndefined();
  });

  it("clears stale stop metadata when a checkpoint is approved", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const app = new AppService(workspace, { store });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "parameter-golf를 다시 이어서 진행해줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 4,
      paperWriteEnabled: false
    });
    const session = createdSnapshot.latestAutomationSession!;
    const now = new Date().toISOString();

    await store.writeAutomationCheckpoint(workspace, {
      id: "AC900",
      sessionId: session.id,
      threadId: session.threadId,
      status: "pending",
      title: "Automation interrupted after app restart",
      summary: "Automation stopped when Lithium restarted during the builder step.",
      whatChanged: [],
      evidence: [],
      risks: ["Automation stopped when Lithium restarted during the builder step."],
      nextActions: ["Resume automation to continue from the latest saved state."],
      createdAt: now,
      updatedAt: now
    });
    await store.writeAutomationSession(workspace, {
      ...session,
      status: "idle",
      latestCheckpointId: "AC900",
      currentStepSummary: "Automation was interrupted when Lithium restarted. Waiting for your direction.",
      stopReason: "Automation stopped when Lithium restarted during the builder step.",
      endedAt: now,
      updatedAt: now
    });

    const resumedSnapshot = await app.approveAutomationCheckpoint({
      workspacePath: workspace,
      sessionId: session.id,
      checkpointId: "AC900",
      response: "계속 연구 진행"
    });

    expect(resumedSnapshot.latestAutomationSession?.id).toBe(session.id);
    expect(resumedSnapshot.latestAutomationSession?.status).toBe("running");
    expect(resumedSnapshot.latestAutomationSession?.stopReason).toBeUndefined();
    expect(resumedSnapshot.latestAutomationSession?.endedAt).toBeUndefined();
  });

  it("does not treat an app-restart interruption as a fresh builder failure when resuming automation", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:30:03.000Z",
        endedAt: "2026-03-18T01:30:05.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "이전 판단을 이어서 바로 실행하겠습니다.",
          "",
          "LITHIUM_HANDOFF",
          JSON.stringify({
            summary: "이전 판단을 이어서 바로 실행하겠습니다."
          })
        ].join("\n")
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => ({
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:41:10.000Z",
        endedAt: "2026-03-18T01:41:12.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        finalMessage: [
          "이어진 builder step을 실행했습니다.",
          "",
          "LITHIUM_STATUS",
          '{"summary":"recovery resumed cleanly","result":"success"}'
        ].join("\n")
      })),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, { store, oracleRunner, codexRunner });

    await app.initProject(workspace);
    const createdSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "parameter-golf를 다시 이어서 진행해줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 4,
      paperWriteEnabled: false
    });
    const session = createdSnapshot.latestAutomationSession!;
    const activeThread = createdSnapshot.activeThread!;
    const now = "2026-03-18T01:30:00.000Z";
    const taskId = (await store.allocateTask(workspace)).id;
    const runPaths = await store.allocateRun(workspace);

    await store.writeTask(workspace, {
      id: taskId,
      threadId: activeThread.id,
      sourceDecisionId: undefined,
      title: "Detached builder task",
      prompt: "Continue the detached builder task.",
      status: "failed",
      createdAt: now,
      updatedAt: now
    });
    await store.writeRun(workspace, {
      id: runPaths.id,
      threadId: activeThread.id,
      taskId,
      prompt: "Continue the detached builder task.",
      displayPrompt: "[autopilot] Continue the detached builder task.",
      model: "gpt-5.4",
      status: "failed",
      exitCode: null,
      pid: null,
      command: buildImmediateBuilderCommand(workspace, "Continue the detached builder task.", runPaths.outputPath),
      stdoutPath: runPaths.stdoutPath,
      stderrPath: runPaths.stderrPath,
      finalMessagePath: runPaths.outputPath,
      finalMessage: [
        "Builder run ended without writing a final answer.",
        "",
        "LITHIUM_STATUS",
        '{"summary":"Builder run ended without writing a final answer.","result":"failed"}'
      ].join("\n"),
      handoff: undefined,
      changedFiles: [],
      contextPackPath: undefined,
      finalization: "auto",
      createdAt: now,
      startedAt: now,
      endedAt: "2026-03-18T01:31:00.000Z"
    });
    await store.writeAutomationCheckpoint(workspace, {
      id: "AC900",
      sessionId: session.id,
      threadId: session.threadId,
      status: "pending",
      title: "Automation interrupted after app restart",
      summary: "Automation stopped when Lithium restarted during the builder step.",
      whatChanged: [],
      evidence: [],
      risks: ["Automation stopped when Lithium restarted during the builder step."],
      nextActions: ["Resume automation to continue from the latest saved state."],
      createdAt: "2026-03-18T01:31:05.000Z",
      updatedAt: "2026-03-18T01:31:05.000Z"
    });
    await store.writeAutomationSession(workspace, {
      ...session,
      status: "idle",
      latestCheckpointId: "AC900",
      currentStepSummary: "Automation was interrupted when Lithium restarted. Waiting for your direction.",
      stopReason: "Automation stopped when Lithium restarted during the builder step.",
      endedAt: "2026-03-18T01:31:05.000Z",
      updatedAt: "2026-03-18T01:31:05.000Z"
    });

    await app.approveAutomationCheckpoint({
      workspacePath: workspace,
      sessionId: session.id,
      checkpointId: "AC900",
      response: "이어서 진행"
    });

    await vi.waitFor(() => {
      expect(oracleRunner.consult).toHaveBeenCalled();
    });

    const strategistCalls = oracleRunner.consult.mock.calls as unknown as Array<[{ prompt?: string }]>;
    const strategistPrompt = strategistCalls[0]?.[0]?.prompt ?? "";
    expect(strategistPrompt).toContain("이어서 진행");
    expect(strategistPrompt).not.toContain("직전 builder step이 실패되었습니다.");
    expect(strategistPrompt).not.toContain("직전 실패 요약: Builder run ended without writing a final answer.");
  });

  it("keeps detached builder runs alive after restart when their recorded process still exists", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const app = new AppService(workspace, { store });

    await app.initProject(workspace);
    const sessionSnapshot = await app.createAutomationSession({
      workspacePath: workspace,
      objective: "parameter-golf 기준선을 정리해줘",
      mode: "continuous",
      maxSteps: 12,
      maxRuntimeMinutes: 30,
      maxRetries: 4,
      paperWriteEnabled: false
    });
    const activeThread = sessionSnapshot.activeThread!;
    const now = new Date().toISOString();
    const taskId = (await store.allocateTask(workspace)).id;
    const runPaths = await store.allocateRun(workspace);

    await Promise.all([
      writeFile(runPaths.stdoutPath, "", "utf8"),
      writeFile(runPaths.stderrPath, "", "utf8"),
      writeFile(runPaths.outputPath, "", "utf8")
    ]);

    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)", runPaths.outputPath],
      {
        cwd: workspace,
        stdio: "ignore"
      }
    );

    await store.writeTask(workspace, {
      id: taskId,
      threadId: activeThread.id,
      sourceDecisionId: undefined,
      title: "Detached builder task",
      prompt: "Continue the detached builder task.",
      status: "running",
      createdAt: now,
      updatedAt: now
    });
    await store.writeRun(workspace, {
      id: runPaths.id,
      threadId: activeThread.id,
      taskId,
      prompt: "Continue the detached builder task.",
      displayPrompt: "Continue the detached builder task.",
      model: "gpt-5.4",
      status: "running",
      exitCode: null,
      pid: child.pid ?? null,
      command: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)", runPaths.outputPath],
        cwd: workspace
      },
      stdoutPath: runPaths.stdoutPath,
      stderrPath: runPaths.stderrPath,
      finalMessagePath: runPaths.outputPath,
      finalMessage: "",
      handoff: null,
      changedFiles: [],
      contextPackPath: undefined,
      finalization: null,
      createdAt: now,
      startedAt: now,
      endedAt: undefined
    });

    const reconciledSnapshot = await app.getSnapshot(workspace);

    expect(reconciledSnapshot.latestAutomationSession?.status).toBe("idle");
    expect(reconciledSnapshot.latestRun?.status).toBe("running");
    expect(reconciledSnapshot.latestRun?.pid).toBe(child.pid ?? null);

    const inspection = await app.inspectBuilderRun({
      workspacePath: workspace,
      runId: runPaths.id
    });

    expect(inspection?.active).toBe(true);
    expect(await processGone(child.pid ?? -1)).toBe(false);

    await app.terminateBuilderRun({
      workspacePath: workspace,
      runId: runPaths.id
    });
    await vi.waitFor(async () => {
      expect(await processGone(child.pid ?? -1)).toBe(true);
    });
  });

  it("resumes a running automation builder step after app restart instead of interrupting the session", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const previousFinalizationThreshold = process.env.LITHIUM_RUN_FINALIZATION_THRESHOLD_MS;
    process.env.LITHIUM_RUN_FINALIZATION_THRESHOLD_MS = "20";

    try {
      const app = new AppService(workspace, { store });

      await app.initProject(workspace);
      const createdSnapshot = await app.createAutomationSession({
        workspacePath: workspace,
        objective: "parameter-golf 기준선을 자동으로 이어서 실험해줘",
        mode: "checkpoint",
        maxSteps: 12,
        maxRuntimeMinutes: 30,
        maxRetries: 4,
        paperWriteEnabled: false
      });
      const activeThread = createdSnapshot.activeThread!;
      const session = createdSnapshot.latestAutomationSession!;
      const runPaths = await store.allocateRun(workspace);
      const stepAllocation = await store.allocateAutomationStep(workspace);
      const taskId = (await store.allocateTask(workspace)).id;
      const now = new Date().toISOString();
      const command = buildOutputThenHangBuilderCommand(
        workspace,
        "Continue the MLX experiment after restart.",
        runPaths.outputPath
      );

      await Promise.all([
        writeFile(runPaths.stdoutPath, "", "utf8"),
        writeFile(runPaths.stderrPath, "", "utf8"),
        writeFile(runPaths.outputPath, "", "utf8")
      ]);

      const child = spawn(command.command, command.args, {
        cwd: command.cwd,
        stdio: "ignore"
      });

      await store.writeTask(workspace, {
        id: taskId,
        threadId: activeThread.id,
        sourceDecisionId: undefined,
        title: "Resume detached automation run",
        prompt: "Continue the MLX experiment after restart.",
        status: "running",
        createdAt: now,
        updatedAt: now
      });
      await store.writeRun(workspace, {
        id: runPaths.id,
        threadId: activeThread.id,
        taskId,
        prompt: "Continue the MLX experiment after restart.",
        displayPrompt: "[autopilot] Continue the MLX experiment after restart.",
        model: "gpt-5.4",
        status: "running",
        exitCode: null,
        pid: child.pid ?? null,
        command,
        stdoutPath: runPaths.stdoutPath,
        stderrPath: runPaths.stderrPath,
        finalMessagePath: runPaths.outputPath,
        finalMessage: "",
        handoff: null,
        changedFiles: [],
        contextPackPath: undefined,
        finalization: null,
        createdAt: now,
        startedAt: now,
        endedAt: undefined
      });
      await store.writeAutomationStep(workspace, {
        id: stepAllocation.id,
        sessionId: session.id,
        threadId: activeThread.id,
        kind: "experiment-run",
        lane: "builder",
        title: "Let Codex choose and execute the next bounded step",
        prompt: "Continue the MLX experiment after restart.",
        status: "running",
        summary: "Step started.",
        runId: runPaths.id,
        changedFiles: [],
        evidence: [],
        checkpointRequired: false,
        createdAt: now,
        updatedAt: now
      });
      await store.writeAutomationSession(workspace, {
        ...session,
        status: "running",
        latestStepId: stepAllocation.id,
        currentStepSummary: "Let Codex choose and execute the next bounded step",
        updatedAt: now
      });

      const restartedApp = new AppService(workspace, { store });
      const firstSnapshot = await restartedApp.getSnapshot(workspace);

      expect(firstSnapshot.latestAutomationSession?.status).toBe("running");
      expect(firstSnapshot.latestAutomationSession?.stopReason).toBeUndefined();

      await vi.waitFor(
        async () => {
          const snapshot = await restartedApp.getSnapshot(workspace);
          expect(snapshot.latestRun?.id).toBe(runPaths.id);
          expect(snapshot.latestRun?.status).toBe("completed");
          expect(snapshot.latestAutomationSession?.status).toBe("idle");
          expect(snapshot.latestAutomationCheckpoint?.title).toBe("Checkpoint ready");
          expect(snapshot.latestAutomationCheckpoint?.summary).toContain("builder completed before the process stalled");
          expect(snapshot.latestAutomationCheckpoint?.summary).not.toContain("restarted");
          expect(snapshot.latestAutomationSession?.stopReason).toBeUndefined();
        },
        {
          timeout: 5_000
        }
      );

      await vi.waitFor(async () => {
        expect(await processGone(child.pid ?? -1)).toBe(true);
      });
    } finally {
      restoreEnv("LITHIUM_RUN_FINALIZATION_THRESHOLD_MS", previousFinalizationThreshold);
    }
  });

  it("terminates detached builder processes even when no live registry handle exists", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const app = new AppService(workspace, { store });

    await app.initProject(workspace);
    const snapshot = await store.getSnapshot(workspace);
    const activeThread = snapshot.activeThread!;
    const now = new Date().toISOString();
    const taskId = (await store.allocateTask(workspace)).id;
    const runPaths = await store.allocateRun(workspace);

    await Promise.all([
      writeFile(runPaths.stdoutPath, "", "utf8"),
      writeFile(runPaths.stderrPath, "", "utf8"),
      writeFile(runPaths.outputPath, "", "utf8")
    ]);

    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)", runPaths.outputPath],
      {
        cwd: workspace,
        stdio: "ignore"
      }
    );

    await store.writeTask(workspace, {
      id: taskId,
      threadId: activeThread.id,
      sourceDecisionId: undefined,
      title: "Manual detached run",
      prompt: "Stop the detached run.",
      status: "running",
      createdAt: now,
      updatedAt: now
    });
    await store.writeRun(workspace, {
      id: runPaths.id,
      threadId: activeThread.id,
      taskId,
      prompt: "Stop the detached run.",
      displayPrompt: "Stop the detached run.",
      model: "gpt-5.4",
      status: "running",
      exitCode: null,
      pid: child.pid ?? null,
      command: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)", runPaths.outputPath],
        cwd: workspace
      },
      stdoutPath: runPaths.stdoutPath,
      stderrPath: runPaths.stderrPath,
      finalMessagePath: runPaths.outputPath,
      finalMessage: "",
      handoff: null,
      changedFiles: [],
      contextPackPath: undefined,
      finalization: null,
      createdAt: now,
      startedAt: now,
      endedAt: undefined
    });

    const terminatedSnapshot = await app.terminateBuilderRun({
      workspacePath: workspace,
      runId: runPaths.id
    });

    expect(terminatedSnapshot.latestRun?.status).toBe("cancelled");
    expect(terminatedSnapshot.latestRun?.finalMessage).toContain("recovering a detached builder process");
    await vi.waitFor(async () => {
      expect(await processGone(child.pid ?? -1)).toBe(true);
    });
  });

  it("surfaces strategist chat progress while a response is still in flight", async () => {
    const workspace = await createWorkspace();
    let releaseConsult!: () => void;
    const oracleRunner = {
      consult: vi.fn(async (input: { stdoutPath: string }) => {
        await writeFile(
          input.stdoutPath,
          "Reusing ChatGPT browser session.\nWaiting for ChatGPT response...\n",
          "utf8"
        );
        await new Promise<void>((resolve) => {
          releaseConsult = resolve;
        });
        return {
          command: { command: "npx", args: ["oracle"], cwd: workspace },
          startedAt: "2026-03-18T01:10:03.000Z",
          endedAt: "2026-03-18T01:10:06.000Z",
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          outputText: [
            "SUMMARY: Literature comparison complete.",
            "NEXT_TASK: Keep the builder idle.",
            "RATIONALE: This was a research-only request."
          ].join("\n")
        };
      })
    };
    const app = new AppService(workspace, {
      oracleRunner
    });

    await app.initProject(workspace);
    const pendingSnapshot = app.consultStrategist({
      workspacePath: workspace,
      prompt: "What should we read next before changing code?"
    });

    await vi.waitFor(async () => {
      const progress = await app.inspectChatProgress({
        workspacePath: workspace
      });

      expect(progress?.lane).toBe("strategist");
      expect(progress?.progressSummary).toBe("Thinking…");
      expect(progress?.progressDetails).toEqual([]);
      expect(progress?.stdoutTail).toContain("Reusing ChatGPT browser session.");
    });

    releaseConsult();
    await pendingSnapshot;

    expect(
      await app.inspectChatProgress({
        workspacePath: workspace
      })
    ).toBeNull();
  });

  it("routes every chat message through codex before launching builder work", async () => {
    const workspace = await createWorkspace();
    const routerRunner = {
      route: vi.fn(async () => ({
        decision: {
          route: "builder" as const,
          rewrittenPrompt: "Update paper/main.tex to reflect the new experiment summary.",
          reasonShort: "The user asked for a concrete manuscript edit."
        },
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:20:00.000Z",
        endedAt: "2026-03-18T01:20:02.000Z",
        exitCode: 0,
        timedOut: false,
        rawOutput: ""
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => ({
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:20:00.000Z",
        endedAt: "2026-03-18T01:20:01.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        finalMessage: ""
      })),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      routerRunner,
      codexRunner
    });

    await app.initProject(workspace);
    const snapshot = await app.sendChatMessage({
      workspacePath: workspace,
      prompt: "Write the updated experiment summary into the paper."
    });

    expect(routerRunner.route).toHaveBeenCalledTimes(1);
    expect(codexRunner.buildTaskCommand).toHaveBeenCalledTimes(1);
    expect(snapshot.latestRun?.prompt).toBe("Update paper/main.tex to reflect the new experiment summary.");
    expect(snapshot.latestRun?.status).toBe("running");
    expect(snapshot.latestRun?.endedAt).toBeUndefined();
  });

  it("replaces an active builder run with the latest builder task instead of surfacing a raw error", async () => {
    const workspace = await createWorkspace();
    const codexRunner = {
      runTask: vi.fn(async () => {
        throw new Error("runTask should not be used in this test.");
      }),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildDelayedBuilderCommand(cwd, prompt, outputPath, prompt.includes("first") ? 5_000 : 25)
      )
    };
    const app = new AppService(workspace, { codexRunner });

    await app.initProject(workspace);

    const firstSnapshot = await app.startBuilderTask({
      workspacePath: workspace,
      prompt: "Implement the first svm version."
    });

    expect(firstSnapshot.latestRun?.status).toBe("running");

    const secondSnapshot = await app.startBuilderTask({
      workspacePath: workspace,
      prompt: "Implement the final svm version."
    });

    expect(secondSnapshot.latestRun?.status).toBe("running");
    expect(secondSnapshot.latestRun?.prompt).toBe("Implement the final svm version.");
    expect(secondSnapshot.latestRun?.id).not.toBe(firstSnapshot.latestRun?.id);

    const cancelledRun = await app.inspectBuilderRun({
      workspacePath: workspace,
      runId: firstSnapshot.latestRun?.id
    });
    expect(cancelledRun?.run?.status).toBe("cancelled");
    expect(cancelledRun?.active).toBe(false);
    expect(cancelledRun?.run?.finalMessage).toContain("Lithium cancelled this task before it finished.");
    expect(cancelledRun?.run?.finalMessage).not.toContain("OpenAI Codex v");
    expect(cancelledRun?.run?.changedFiles).toEqual([]);

    await app.terminateBuilderRun({
      workspacePath: workspace,
      runId: secondSnapshot.latestRun?.id
    });
  });

  it("isolates live builder runs across workspaces even when artifact ids overlap", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const codexRunner = {
      runTask: vi.fn(async () => {
        throw new Error("runTask should not be used in this test.");
      }),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildDelayedBuilderCommand(cwd, prompt, outputPath, 5_000)
      )
    };
    const appA = new AppService(workspaceA, { codexRunner });
    const appB = new AppService(workspaceB, { codexRunner });

    await appA.initProject(workspaceA);
    await appB.initProject(workspaceB);

    const runA = await appA.startBuilderTask({
      workspacePath: workspaceA,
      prompt: "Implement workspace A task."
    });
    const runB = await appB.startBuilderTask({
      workspacePath: workspaceB,
      prompt: "Implement workspace B task."
    });

    expect(runA.latestRun?.id).toBe("R001");
    expect(runB.latestRun?.id).toBe("R001");

    const inspectionA = await appA.inspectBuilderRun({
      workspacePath: workspaceA,
      runId: runA.latestRun?.id
    });
    const inspectionB = await appB.inspectBuilderRun({
      workspacePath: workspaceB,
      runId: runB.latestRun?.id
    });

    expect(inspectionA?.active).toBe(true);
    expect(inspectionA?.run?.prompt).toBe("Implement workspace A task.");
    expect(inspectionB?.active).toBe(true);
    expect(inspectionB?.run?.prompt).toBe("Implement workspace B task.");

    await appA.terminateBuilderRun({
      workspacePath: workspaceA,
      runId: runA.latestRun?.id
    });
    await appB.terminateBuilderRun({
      workspacePath: workspaceB,
      runId: runB.latestRun?.id
    });
  });

  it("does not surface codex json event streams after terminating a builder run", async () => {
    const workspace = await createWorkspace();
    const codexRunner = {
      runTask: vi.fn(async () => {
        throw new Error("runTask should not be used in this test.");
      }),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildJsonlDelayedBuilderCommand(cwd, prompt, outputPath, 5_000)
      )
    };
    const app = new AppService(workspace, { codexRunner });

    await app.initProject(workspace);
    const snapshot = await app.startBuilderTask({
      workspacePath: workspace,
      prompt: "Investigate the new svm direction."
    });

    await app.terminateBuilderRun({
      workspacePath: workspace,
      runId: snapshot.latestRun?.id
    });

    const inspection = await app.inspectBuilderRun({
      workspacePath: workspace,
      runId: snapshot.latestRun?.id
    });

    expect(inspection?.run?.status).toBe("cancelled");
    expect(inspection?.run?.finalMessage).toContain("Lithium cancelled this task before it finished.");
    expect(inspection?.run?.finalMessage).not.toContain('{"type":"thread.started"');
    expect(inspection?.run?.finalMessage).not.toContain('"type":"command_execution"');
  });

  it("supports mixed routing and persists a structured router trace", async () => {
    const workspace = await createWorkspace();
    const routerRunner = {
      route: vi.fn(async () => ({
        decision: {
          route: "mixed" as const,
          rewrittenPrompt: "Decide the best paper revision, then carry it out.",
          reasonShort: "The request needs both planning and concrete execution."
        },
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:30:00.000Z",
        endedAt: "2026-03-18T01:30:02.000Z",
        exitCode: 0,
        timedOut: false,
        rawOutput: "LITHIUM_ROUTE\n{\"route\":\"mixed\"}"
      }))
    };
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:30:03.000Z",
        endedAt: "2026-03-18T01:30:05.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "SUMMARY: Planned the paper revision.",
          "NEXT_TASK: Update paper/main.tex with the selected revision.",
          "RATIONALE: Mixed mode should hand off immediately to the builder."
        ].join("\n")
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => ({
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:41:10.000Z",
        endedAt: "2026-03-18T01:41:12.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        finalMessage: [
          "Prepared the parser patch plan.",
          "",
          "LITHIUM_STATUS",
          '{"summary":"prepared parser patch plan","result":"success"}'
        ].join("\n")
      })),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      routerRunner,
      oracleRunner,
      codexRunner
    });

    await app.initProject(workspace);
    const snapshot = await app.sendChatMessage({
      workspacePath: workspace,
      prompt: "Figure out the right paper revision and then apply it."
    });

    expect(snapshot.latestDecision?.summary).toBe("Planned the paper revision.");
    expect(snapshot.latestRun?.prompt).toContain("Decide the best paper revision, then carry it out.");
    expect(snapshot.latestRun?.prompt).toContain("Strategist summary: Planned the paper revision.");
    expect(snapshot.latestRun?.prompt).toContain("Strategist rationale: Mixed mode should hand off immediately to the builder.");
    expect(snapshot.latestRun?.prompt).toContain("The latest strategist research and project state are in the runtime context.");
    expect(snapshot.latestRouterTrace?.finalRoute).toBe("mixed");
    const trace = JSON.parse(
      await readFile(path.join(workspace, ".lithium", "routes", "Q001.json"), "utf8")
    );
    expect(trace).toMatchObject({
      route: "mixed",
      finalRoute: "mixed",
      downstreamDecisionId: "D001",
      downstreamRunId: "R001"
    });
  });

  it("does not re-inject a truncated strategist summary when a natural strategist reply already exists", async () => {
    const workspace = await createWorkspace();
    const routerRunner = {
      route: vi.fn(async () => ({
        decision: {
          route: "mixed" as const,
          rewrittenPrompt: "연구 자동화를 이어가되 먼저 다음 recovery step을 정해라.",
          reasonShort: "The request needs a strategist pass and then concrete execution."
        },
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:30:00.000Z",
        endedAt: "2026-03-18T01:30:02.000Z",
        exitCode: 0,
        timedOut: false,
        rawOutput: "LITHIUM_ROUTE\n{\"route\":\"mixed\"}"
      }))
    };
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:30:03.000Z",
        endedAt: "2026-03-18T01:30:05.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "이번 실패는 오케스트레이션 복구로 보는 게 맞습니다.",
          "",
          "LITHIUM_HANDOFF",
          JSON.stringify({
            summary:
              "이번 실패는 오케스트레이션 복구로 보는 게 맞습니다. 업로드된 runtime에는 latest builder summary가 그대로…",
            rationale: "Natural reply already captures the user-facing guidance."
          })
        ].join("\n")
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => ({
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:41:10.000Z",
        endedAt: "2026-03-18T01:41:12.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        finalMessage: [
          "복구 step을 정했습니다.",
          "",
          "LITHIUM_STATUS",
          '{"summary":"recovery step chosen","result":"success"}'
        ].join("\n")
      })),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      routerRunner,
      oracleRunner,
      codexRunner
    });

    await app.initProject(workspace);
    const snapshot = await app.sendChatMessage({
      workspacePath: workspace,
      prompt: "연구 자동화 다시 시작 이어서"
    });

    expect(snapshot.latestRun?.prompt).toContain("Strategist answer:\n이번 실패는 오케스트레이션 복구로 보는 게 맞습니다.");
    expect(snapshot.latestRun?.prompt).not.toContain("Strategist summary:");
  });

  it("lets hidden /build override force the builder while still recording the router decision", async () => {
    const workspace = await createWorkspace();
    const routerRunner = {
      route: vi.fn(async () => ({
        decision: {
          route: "strategist" as const,
          rewrittenPrompt: "Refine the argument before coding anything.",
          reasonShort: "The raw prompt looked exploratory."
        },
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:40:00.000Z",
        endedAt: "2026-03-18T01:40:01.000Z",
        exitCode: 0,
        timedOut: false,
        rawOutput: "LITHIUM_ROUTE\n{\"route\":\"strategist\"}"
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => ({
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:41:10.000Z",
        endedAt: "2026-03-18T01:41:12.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        finalMessage: [
          "Prepared the parser patch plan.",
          "",
          "LITHIUM_STATUS",
          '{"summary":"prepared parser patch plan","result":"success"}'
        ].join("\n")
      })),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      routerRunner,
      codexRunner
    });

    await app.initProject(workspace);
    const snapshot = await app.sendChatMessage({
      workspacePath: workspace,
      prompt: "/build Update paper/main.tex directly."
    });

    expect(snapshot.latestRun?.status).toBe("running");
    expect(snapshot.latestRun?.prompt).toBe("Refine the argument before coding anything.");
    const trace = JSON.parse(
      await readFile(path.join(workspace, ".lithium", "routes", "Q001.json"), "utf8")
    );
    expect(trace).toMatchObject({
      requestedRoute: "builder",
      route: "strategist",
      finalRoute: "builder"
    });
  });

  it("reuses the latest saved builder task when /build is sent without a body", async () => {
    const workspace = await createWorkspace();
    const routerRunner = {
      route: vi.fn(async () => ({
        decision: {
          route: "strategist" as const,
          rewrittenPrompt: "Patch the parser and cover it with regression tests.",
          reasonShort: "The latest task is already concrete enough for builder execution."
        },
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:42:00.000Z",
        endedAt: "2026-03-18T01:42:01.000Z",
        exitCode: 0,
        timedOut: false,
        rawOutput: "LITHIUM_ROUTE\n{\"route\":\"strategist\"}"
      }))
    };
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:41:00.000Z",
        endedAt: "2026-03-18T01:41:03.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "SUMMARY: The parser failure is isolated.",
          "NEXT_TASK: Fix the parser and add a regression test.",
          "RATIONALE: The builder can take this directly."
        ].join("\n")
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => ({
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:41:10.000Z",
        endedAt: "2026-03-18T01:41:12.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        finalMessage: [
          "Prepared the parser patch plan.",
          "",
          "LITHIUM_STATUS",
          '{"summary":"prepared parser patch plan","result":"success"}'
        ].join("\n")
      })),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      routerRunner,
      oracleRunner,
      codexRunner
    });

    await app.initProject(workspace);
    await app.consultStrategist({
      workspacePath: workspace,
      prompt: "Figure out the parser bug and tell me the next builder step."
    });
    await app.runBuilderTask({
      workspacePath: workspace,
      prompt: "Fix the parser and add a regression test."
    });

    const snapshot = await app.sendChatMessage({
      workspacePath: workspace,
      prompt: "/build"
    });

    expect(routerRunner.route).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: "Fix the parser and add a regression test."
      })
    );
    expect(snapshot.latestRun?.status).toBe("running");
    expect(snapshot.latestRun?.displayPrompt).toBe("Fix the parser and add a regression test.");
    expect(snapshot.latestRun?.prompt).toBe("Patch the parser and cover it with regression tests.");
  });

  it("lets hidden /research override force strategist routing while still recording the router decision", async () => {
    const workspace = await createWorkspace();
    const routerRunner = {
      route: vi.fn(async () => ({
        decision: {
          route: "builder" as const,
          rewrittenPrompt: "Apply the draft directly to the paper.",
          reasonShort: "The router saw a direct edit request."
        },
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:45:00.000Z",
        endedAt: "2026-03-18T01:45:01.000Z",
        exitCode: 0,
        timedOut: false,
        rawOutput: "LITHIUM_ROUTE\n{\"route\":\"builder\"}"
      }))
    };
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:45:02.000Z",
        endedAt: "2026-03-18T01:45:05.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "SUMMARY: Research override honored.",
          "NEXT_TASK: Keep the builder idle.",
          "RATIONALE: The user explicitly forced strategist mode."
        ].join("\n")
      }))
    };
    const app = new AppService(workspace, {
      routerRunner,
      oracleRunner
    });

    await app.initProject(workspace);
    const snapshot = await app.sendChatMessage({
      workspacePath: workspace,
      prompt: "/research Should we actually revise the paper like that?"
    });

    expect(snapshot.latestDecision?.summary).toBe("Research override honored.");
    const trace = JSON.parse(
      await readFile(path.join(workspace, ".lithium", "routes", "Q001.json"), "utf8")
    );
    expect(trace).toMatchObject({
      requestedRoute: "strategist",
      route: "builder",
      finalRoute: "strategist"
    });
  });

  it("lets hidden /plan override force strategist routing while still recording the router decision", async () => {
    const workspace = await createWorkspace();
    const routerRunner = {
      route: vi.fn(async () => ({
        decision: {
          route: "builder" as const,
          rewrittenPrompt: "Apply the draft directly to the paper.",
          reasonShort: "The router saw a direct edit request."
        },
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:45:00.000Z",
        endedAt: "2026-03-18T01:45:01.000Z",
        exitCode: 0,
        timedOut: false,
        rawOutput: "LITHIUM_ROUTE\n{\"route\":\"builder\"}"
      }))
    };
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:45:02.000Z",
        endedAt: "2026-03-18T01:45:05.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "SUMMARY: Planning override honored.",
          "NEXT_TASK: Keep the builder idle.",
          "RATIONALE: The user explicitly forced strategist planning mode."
        ].join("\n")
      }))
    };
    const app = new AppService(workspace, {
      routerRunner,
      oracleRunner
    });

    await app.initProject(workspace);
    const snapshot = await app.sendChatMessage({
      workspacePath: workspace,
      prompt: "/plan Figure out the next experiment before touching code."
    });

    expect(snapshot.latestDecision?.summary).toBe("Planning override honored.");
    const trace = JSON.parse(
      await readFile(path.join(workspace, ".lithium", "routes", "Q001.json"), "utf8")
    );
    expect(trace).toMatchObject({
      requestedRoute: "strategist",
      route: "builder",
      finalRoute: "strategist"
    });
  });

  it("chains mixed router decisions from strategist into builder work", async () => {
    const workspace = await createWorkspace();
    const routerRunner = {
      route: vi.fn(async () => ({
        decision: {
          route: "mixed" as const,
          rewrittenPrompt: "Compare the literature first, then draft the code plan.",
          reasonShort: "The request needs both analysis and implementation."
        },
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T01:30:00.000Z",
        endedAt: "2026-03-18T01:30:02.000Z",
        exitCode: 0,
        timedOut: false,
        rawOutput: "LITHIUM_ROUTE\n{\"route\":\"mixed\"}"
      }))
    };
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T01:30:03.000Z",
        endedAt: "2026-03-18T01:30:06.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "SUMMARY: Mixed request handled by strategist first.",
          "NEXT_TASK: Update paper/main.tex with the planned implementation.",
          "RATIONALE: The mixed request starts with a decision step."
        ].join("\n")
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => {
        throw new Error("runTask should not be used in this test.");
      }),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      routerRunner,
      oracleRunner,
      codexRunner
    });

    await app.initProject(workspace);
    const snapshot = await app.sendChatMessage({
      workspacePath: workspace,
      prompt: "I need research context and then implementation."
    });

    expect(routerRunner.route).toHaveBeenCalledTimes(1);
    expect(oracleRunner.consult).toHaveBeenCalledTimes(1);
    expect(snapshot.latestDecision?.summary).toBe("Mixed request handled by strategist first.");
    expect(snapshot.latestRun?.status).toBe("running");
    expect(snapshot.latestRun?.prompt).toContain("Compare the literature first, then draft the code plan.");
    expect(snapshot.latestRun?.prompt).toContain("Strategist summary: Mixed request handled by strategist first.");
    expect(snapshot.latestRun?.prompt).toContain("Strategist rationale: The mixed request starts with a decision step.");
    expect(snapshot.latestRun?.prompt).toContain("The latest strategist research and project state are in the runtime context.");
  });

  it("separates strategist history by thread while keeping project memory shared", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      consult: vi.fn(async ({ prompt }: { prompt: string; slug: string }) => {
        if (prompt.includes("alpha")) {
          return {
            command: { command: "npx", args: ["oracle"], cwd: workspace },
            startedAt: "2026-03-18T02:00:00.000Z",
            endedAt: "2026-03-18T02:00:03.000Z",
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            outputText: [
              "SUMMARY: Alpha strategist summary.",
              "NEXT_TASK: Keep alpha thread idle.",
              "RATIONALE: Alpha thread stores the first plan."
            ].join("\n")
          };
        }

        return {
          command: { command: "npx", args: ["oracle"], cwd: workspace },
          startedAt: "2026-03-18T02:01:00.000Z",
          endedAt: "2026-03-18T02:01:03.000Z",
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          outputText: [
            "SUMMARY: Beta strategist summary.",
            "NEXT_TASK: Keep beta thread idle.",
            "RATIONALE: Beta thread stores the second plan."
          ].join("\n")
        };
      })
    };
    const app = new AppService(workspace, { oracleRunner });

    const initialSnapshot = await app.initProject(workspace);
    const alphaThreadId = initialSnapshot.activeThreadId;
    expect(alphaThreadId).toBeTruthy();

    const alphaSnapshot = await app.consultStrategist({
      workspacePath: workspace,
      prompt: "Plan the alpha thread."
    });
    expect(alphaSnapshot.latestDecision?.summary).toBe("Alpha strategist summary.");
    expect(alphaSnapshot.activeThreadId).toBe(alphaThreadId);

    const betaThreadSnapshot = await app.createThread({
      workspacePath: workspace,
      title: "Beta thread"
    });
    expect(betaThreadSnapshot.activeThread?.title).toBe("Beta thread");
    expect(betaThreadSnapshot.latestDecision).toBeNull();

    const betaSnapshot = await app.consultStrategist({
      workspacePath: workspace,
      prompt: "Plan the beta thread."
    });
    expect(betaSnapshot.latestDecision?.summary).toBe("Beta strategist summary.");
    expect(betaSnapshot.decisions).toHaveLength(1);
    expect(betaSnapshot.memory?.sessionSummary).toContain("Active Thread: Beta thread");

    const restoredAlpha = await app.selectThread({
      workspacePath: workspace,
      threadId: alphaThreadId!
    });
    expect(restoredAlpha.activeThreadId).toBe(alphaThreadId);
    expect(restoredAlpha.activeThread?.title).toBe("Plan the alpha thread.");
    expect(restoredAlpha.latestDecision?.summary).toBe("Alpha strategist summary.");
    expect(restoredAlpha.decisions).toHaveLength(1);
    expect(restoredAlpha.threads).toHaveLength(2);
    expect(restoredAlpha.memory?.sessionSummary).toContain("Active Thread: Plan the alpha thread.");

    const alphaAgainSnapshot = await app.consultStrategist({
      workspacePath: workspace,
      prompt: "Plan the alpha thread again."
    });
    expect(alphaAgainSnapshot.latestDecision?.summary).toBe("Alpha strategist summary.");

    const strategistCalls = oracleRunner.consult.mock.calls as unknown as Array<
      [{ slug: string; prompt: string; files: string[] }]
    >;
    expect(strategistCalls[0]?.[0]?.slug).toMatch(/^ors-strat-/);
    expect(strategistCalls[0]?.[0]?.slug).toContain(`-${alphaThreadId?.toLowerCase()}`);
    expect(strategistCalls[1]?.[0]?.slug).not.toBe(strategistCalls[0]?.[0]?.slug);
    expect(strategistCalls[2]?.[0]?.slug).toBe(strategistCalls[0]?.[0]?.slug);
    expect(strategistCalls[0]?.[0]?.files.some((file) => file.endsWith(".strategist.runtime.md"))).toBe(true);
    expect(strategistCalls[1]?.[0]?.files.some((file) => file.endsWith(".strategist.runtime.md"))).toBe(true);
    expect(strategistCalls[2]?.[0]?.files.some((file) => file.endsWith(".strategist.runtime.md"))).toBe(false);
  });

  it("stores manual thread memory separately and rebuilds the active context pack", async () => {
    const workspace = await createWorkspace();
    const app = new AppService(workspace);

    const initialSnapshot = await app.initProject(workspace);
    const alphaThreadId = initialSnapshot.activeThreadId;

    expect(alphaThreadId).toBeTruthy();

    await app.updateProjectMemory({
      workspacePath: workspace,
      projectBrief: "Shared research brief."
    });

    const alphaSnapshot = await app.updateThreadMemory({
      workspacePath: workspace,
      threadId: alphaThreadId ?? undefined,
      memory: "Track the alpha experiment assumptions and paper implications."
    });

    expect(alphaSnapshot.activeThread?.memory).toBe(
      "Track the alpha experiment assumptions and paper implications."
    );
    expect(alphaSnapshot.activeThread?.summary).toBe("No thread summary yet.");

    const alphaContext = await app.readWorkspaceFile({
      workspacePath: workspace,
      path: ".lithium/context/current-context.md"
    });

    expect(alphaContext.content).toContain(
      "Manual memory: Track the alpha experiment assumptions and paper implications."
    );
    expect(alphaContext.content).toContain("Project Brief: Shared research brief.");

    const betaSnapshot = await app.createThread({
      workspacePath: workspace,
      title: "Beta thread"
    });

    await app.updateThreadMemory({
      workspacePath: workspace,
      threadId: betaSnapshot.activeThreadId ?? undefined,
      memory: "Beta lane keeps the literature sweep and baseline audit."
    });

    const betaContext = await app.readWorkspaceFile({
      workspacePath: workspace,
      path: ".lithium/context/current-context.md"
    });

    expect(betaContext.content).toContain("Manual memory: Beta lane keeps the literature sweep and baseline audit.");
    expect(betaContext.content).not.toContain(
      "Manual memory: Track the alpha experiment assumptions and paper implications."
    );

    const restoredAlpha = await app.selectThread({
      workspacePath: workspace,
      threadId: alphaThreadId!
    });

    expect(restoredAlpha.activeThread?.memory).toBe(
      "Track the alpha experiment assumptions and paper implications."
    );
    expect(restoredAlpha.memory?.projectBrief).toBe("Shared research brief.");
  });

  it("imports and removes thread attachments while rebuilding the active context pack", async () => {
    const workspace = await createWorkspace();
    const sourceDir = await createTempDir("lithium-app-attachment-source-");
    const app = new AppService(workspace);

    await app.initProject(workspace);

    const notesPath = path.join(sourceDir, "experiment-notes.md");
    await writeFile(
      notesPath,
      "Track the current baseline, then attach the failed run notes to the thread.\n",
      "utf8"
    );

    const importedSnapshot = await app.importAttachments({
      workspacePath: workspace,
      filePaths: [notesPath]
    });
    const imported = importedSnapshot.activeThreadAttachments[0];

    expect(importedSnapshot.activeThreadAttachments).toHaveLength(1);
    expect(imported.name).toBe("experiment-notes.md");
    await expect(access(path.join(workspace, imported.relativePath))).resolves.toBeUndefined();

    const context = await app.readWorkspaceFile({
      workspacePath: workspace,
      path: ".lithium/context/current-context.md"
    });

    expect(context.content).toContain("## Thread Attachments");
    expect(context.content).toContain("experiment-notes.md");
    expect(context.content).toContain("Track the current baseline");

    const removedSnapshot = await app.removeAttachment({
      workspacePath: workspace,
      attachmentId: imported.id
    });

    expect(removedSnapshot.activeThreadAttachments).toHaveLength(0);
    await expect(access(path.join(workspace, imported.relativePath))).rejects.toThrow();
  });

  it("forwards active thread attachments to the strategist alongside the context pack", async () => {
    const workspace = await createWorkspace();
    const sourceDir = await createTempDir("lithium-strategist-attachment-source-");
    const attachmentPath = path.join(sourceDir, "notes.md");
    await writeFile(attachmentPath, "Use the attached baseline notes when planning the next task.\n", "utf8");

    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T03:00:00.000Z",
        endedAt: "2026-03-18T03:00:04.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "LITHIUM_HANDOFF",
          JSON.stringify({
            summary: "Use the attached notes to seed the next builder task.",
            next_task: "Read attachments/TH001/notes.md and update the experiment plan.",
            rationale: "The attachment contains the missing baseline observations.",
            files: ["attachments/TH001/notes.md"],
            risks: [],
            paper_actions: [],
            run_actions: [],
            success_criteria: ["Planner references the attachment."],
            open_questions: []
          })
        ].join("\n")
      }))
    };
    const app = new AppService(workspace, { oracleRunner });

    await app.initProject(workspace);
    await app.importAttachments({
      workspacePath: workspace,
      filePaths: [attachmentPath]
    });

    const snapshot = await app.consultStrategist({
      workspacePath: workspace,
      prompt: "Plan the next baseline experiment."
    });
    expect(oracleRunner.consult).toHaveBeenCalledTimes(1);
    const consultCall = oracleRunner.consult.mock.calls.at(0);

    if (!consultCall) {
      throw new Error("Strategist mock was not called.");
    }

    const [consultInput] = consultCall as unknown as [{ files: string[]; prompt: string }];
    expect(consultInput.files.some((file) => file.endsWith(".strategist.runtime.md"))).toBe(true);
    expect(consultInput.files.some((file) => file.endsWith("D001.strategist.md"))).toBe(false);
    expect(
      consultInput.files.some((file) => file.endsWith(path.join("attachments", "TH001", "notes.md")))
    ).toBe(true);
    expect(consultInput.prompt).toBe("Plan the next baseline experiment.");
    expect(snapshot.latestDecision?.handoff?.files).toContain("attachments/TH001/notes.md");
  });

  it("attaches explicitly requested repo files to strategist prompts and keeps same-thread follow-ups light", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      path.join(workspace, "README.md"),
      "# Test Workspace\n\nThis workspace contains a tiny SVM baseline.\n",
      "utf8"
    );
    await mkdir(path.join(workspace, "examples"), { recursive: true });
    await writeFile(
      path.join(workspace, "examples", "train_svm.py"),
      "print('train svm')\n",
      "utf8"
    );
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T03:03:00.000Z",
        endedAt: "2026-03-18T03:03:04.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: "SUMMARY: Repo-aware strategist response."
      }))
    };
    const app = new AppService(workspace, { oracleRunner });

    await app.initProject(workspace);
    await app.consultStrategist({
      workspacePath: workspace,
      prompt: "현재 저장소 기준으로 README.md와 examples/train_svm.py를 함께 보고 현재 구조를 짧게 요약해줘."
    });
    await app.consultStrategist({
      workspacePath: workspace,
      prompt: "방금 요약 기준으로 다음 연구 질문 2개만 짧게 제안해줘."
    });

    const strategistCalls = oracleRunner.consult.mock.calls as unknown as Array<
      [{ slug: string; files: string[]; prompt: string }]
    >;

    expect(strategistCalls).toHaveLength(2);
    expect(strategistCalls[0]?.[0]?.files).toEqual(
      expect.arrayContaining([expect.stringContaining(".strategist.runtime.md")])
    );
    expect(
      strategistCalls[0]?.[0]?.files.some((file) => file.endsWith(path.join("examples", "train_svm.py")))
    ).toBe(true);
    expect(strategistCalls[0]?.[0]?.files.some((file) => file.endsWith("README.md"))).toBe(true);
    expect(strategistCalls[0]?.[0]?.prompt).toBe(
      "현재 저장소 기준으로 README.md와 examples/train_svm.py를 함께 보고 현재 구조를 짧게 요약해줘."
    );
    await expect(readFile(strategistCalls[0]?.[0]?.files[0], "utf8")).resolves.toContain("## README Excerpt");
    expect(strategistCalls[1]?.[0]?.slug).toBe(strategistCalls[0]?.[0]?.slug);
    expect(strategistCalls[1]?.[0]?.files.some((file) => file.endsWith("README.md"))).toBe(false);
    expect(
      strategistCalls[1]?.[0]?.files.some((file) => file.endsWith(path.join("examples", "train_svm.py")))
    ).toBe(false);
    expect(
      strategistCalls[1]?.[0]?.files.some((file) => file.endsWith(".strategist.runtime.md"))
    ).toBe(false);
  });

  it("keeps generic strategist research prompts light and avoids attaching code by keyword alone", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      path.join(workspace, "README.md"),
      "# Test Workspace\n\nThis workspace contains a tiny SVM baseline.\n",
      "utf8"
    );
    await mkdir(path.join(workspace, "examples"), { recursive: true });
    await writeFile(
      path.join(workspace, "examples", "train_svm.py"),
      "print('train svm')\n",
      "utf8"
    );
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T03:04:00.000Z",
        endedAt: "2026-03-18T03:04:03.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: "SUMMARY: Research-only strategist response."
      }))
    };
    const app = new AppService(workspace, { oracleRunner });

    await app.initProject(workspace);
    await app.consultStrategist({
      workspacePath: workspace,
      prompt: "새로운 svm 알고리즘을 리서치해서 icml 급 가능성을 판단해줘."
    });

    const strategistCalls = oracleRunner.consult.mock.calls as unknown as Array<
      [{ files: string[]; runtimeContext: string }]
    >;
    expect(strategistCalls).toHaveLength(1);
    expect(
      strategistCalls[0]?.[0]?.files.some((file) => file.endsWith(path.join("examples", "train_svm.py")))
    ).toBe(false);
    expect(strategistCalls[0]?.[0]?.files.some((file) => file.endsWith("README.md"))).toBe(false);
    expect(
      strategistCalls[0]?.[0]?.files.some((file) => file.endsWith(".strategist.runtime.md"))
    ).toBe(true);
  });

  it("keeps automation-style strategist follow-ups light even when the display prompt contains repo file paths", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      path.join(workspace, "README.md"),
      "# Test Workspace\n\nThis workspace contains a tiny SVM baseline.\n",
      "utf8"
    );
    await mkdir(path.join(workspace, "examples"), { recursive: true });
    await writeFile(
      path.join(workspace, "examples", "train_svm.py"),
      "print('train svm')\n",
      "utf8"
    );
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T03:04:00.000Z",
        endedAt: "2026-03-18T03:04:03.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: "SUMMARY: Keep this strategist follow-up light."
      }))
    };
    const app = new AppService(workspace, { oracleRunner });

    await app.initProject(workspace);
    await app.consultStrategist({
      workspacePath: workspace,
      prompt: "방금 결과 기준으로 다음 판단만 짧게 정리해줘.",
      displayPrompt: "[Autopilot] README.md와 examples/train_svm.py를 다시 보고 다음 단계를 정리해줘.",
      attachExplicitWorkspaceFiles: false
    });

    const strategistCalls = oracleRunner.consult.mock.calls as unknown as Array<
      [{ files: string[]; prompt: string }]
    >;

    expect(strategistCalls).toHaveLength(1);
    expect(strategistCalls[0]?.[0]?.files.some((file) => file.endsWith(".strategist.runtime.md"))).toBe(true);
    expect(strategistCalls[0]?.[0]?.files.some((file) => file.endsWith("README.md"))).toBe(false);
    expect(
      strategistCalls[0]?.[0]?.files.some((file) => file.endsWith(path.join("examples", "train_svm.py")))
    ).toBe(false);
    expect(strategistCalls[0]?.[0]?.prompt).toBe("방금 결과 기준으로 다음 판단만 짧게 정리해줘.");
  });

  it("terminates the prior strategist browser session before starting a replacement consult", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      terminateSession: vi.fn(async () => undefined),
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T03:04:00.000Z",
        endedAt: "2026-03-18T03:04:03.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: "SUMMARY: Strategist response."
      }))
    };
    const app = new AppService(workspace, { oracleRunner });

    await app.initProject(workspace);
    await app.consultStrategist({
      workspacePath: workspace,
      prompt: "첫 번째 질문."
    });
    await app.consultStrategist({
      workspacePath: workspace,
      prompt: "두 번째 질문."
    });

    expect(oracleRunner.terminateSession).toHaveBeenCalled();
    const terminatedSlugs = (oracleRunner.terminateSession.mock.calls as unknown as Array<[string]>).map(
      ([slug]) => slug
    );
    expect(terminatedSlugs.every((slug) => /^ors-strat-/.test(slug))).toBe(true);
  });

  it("does not attach code files when the prompt explicitly says research first and code later", async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace, "examples"), { recursive: true });
    await writeFile(
      path.join(workspace, "examples", "train_svm.py"),
      "print('train svm')\n",
      "utf8"
    );
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T03:04:00.000Z",
        endedAt: "2026-03-18T03:04:03.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: "SUMMARY: Research-first strategist response."
      }))
    };
    const app = new AppService(workspace, { oracleRunner });

    await app.initProject(workspace);
    await app.consultStrategist({
      workspacePath: workspace,
      prompt:
        "새로운 그래프 샘플링 알고리즘을 깊게 리서치해줘. 구현보다 리서치와 메모를 우선하고, 코드 수정은 필요해질 때만 제안해."
    });

    const strategistCalls = oracleRunner.consult.mock.calls as unknown as Array<
      [{ files: string[]; runtimeContext: string }]
    >;
    expect(strategistCalls).toHaveLength(1);
    expect(
      strategistCalls[0]?.[0]?.files.some((file) => file.endsWith(path.join("examples", "train_svm.py")))
    ).toBe(false);
  });

  it("keeps broad literature-scan strategist prompts on runtime context only unless the user asks about the repo", async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace, "paper", "sections"), { recursive: true });
    await mkdir(path.join(workspace, "examples"), { recursive: true });
    await writeFile(path.join(workspace, "paper", "main.tex"), "\\documentclass{article}\n", "utf8");
    await writeFile(path.join(workspace, "paper", "main.bib"), "", "utf8");
    await writeFile(path.join(workspace, "paper", "sections", "abstract.tex"), "Test abstract\n", "utf8");
    await writeFile(path.join(workspace, "examples", "train_svm.py"), "print('train svm')\n", "utf8");
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T03:04:00.000Z",
        endedAt: "2026-03-18T03:04:03.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: "SUMMARY: Broad research strategist response."
      }))
    };
    const app = new AppService(workspace, { oracleRunner });

    await app.initProject(workspace);
    await app.consultStrategist({
      workspacePath: workspace,
      prompt:
        "새로운 그래프 압축 알고리즘의 유망한 연구 방향을 깊이 있게 조사해줘. 기존 접근법 분류, 한계, 공백, 벤치마크와 데이터셋, 신규 아이디어와 검증 가설까지 정리해줘."
    });

    const strategistCalls = oracleRunner.consult.mock.calls as unknown as Array<
      [{ files: string[]; runtimeContext: string }]
    >;
    expect(strategistCalls).toHaveLength(1);
    expect(
      strategistCalls[0]?.[0]?.files.filter((file) => !file.endsWith(".strategist.runtime.md"))
    ).toEqual([]);
  });

  it("keeps strategist uploads to runtime context only while carrying repo context inside the runtime note", async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace, "paper", "sections"), { recursive: true });
    await mkdir(path.join(workspace, "examples"), { recursive: true });
    await writeFile(path.join(workspace, "README.md"), "# Probe\n\nRepository summary.\n", "utf8");
    await writeFile(path.join(workspace, "paper", "main.tex"), "\\documentclass{article}\n", "utf8");
    await writeFile(path.join(workspace, "examples", "train_svm.py"), "print('train svm')\n", "utf8");
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T03:04:00.000Z",
        endedAt: "2026-03-18T03:04:03.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: "SUMMARY: Repo-aware strategist response."
      }))
    };
    const app = new AppService(workspace, { oracleRunner });

    await app.initProject(workspace);
    await app.consultStrategist({
      workspacePath: workspace,
      prompt: "현재 저장소 기준으로 README와 현재 논문 구조를 짧게 요약해줘."
    });

    const strategistCalls = oracleRunner.consult.mock.calls as unknown as Array<
      [{ files: string[]; prompt: string }]
    >;
    expect(strategistCalls).toHaveLength(1);
    const attachedRepoFiles = strategistCalls[0]?.[0]?.files.filter(
      (file) => !file.endsWith(".strategist.runtime.md")
    );
    expect(attachedRepoFiles).toHaveLength(1);
    expect(attachedRepoFiles?.[0]).toContain("README.md");
    expect(strategistCalls[0]?.[0]?.prompt).toBe("현재 저장소 기준으로 README와 현재 논문 구조를 짧게 요약해줘.");
    await expect(readFile(strategistCalls[0]?.[0]?.files[0], "utf8")).resolves.toContain("## README Excerpt");
    await expect(readFile(strategistCalls[0]?.[0]?.files[0], "utf8")).resolves.toContain("Repository summary.");
  });

  it("does not queue a builder task when the strategist returns only an idle follow-up", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T03:05:00.000Z",
        endedAt: "2026-03-18T03:05:03.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "LITHIUM_HANDOFF",
          JSON.stringify({
            summary: "현재 워크스페이스는 비어 있으니 다음 요청을 기다리면 된다."
          })
        ].join("\n")
      }))
    };
    const app = new AppService(workspace, { oracleRunner });

    await app.initProject(workspace);
    const snapshot = await app.consultStrategist({
      workspacePath: workspace,
      prompt: "현재 상태만 짧게 알려줘."
    });

    expect(snapshot.latestDecision?.summary).toContain("다음 요청을 기다리면 된다");
    expect(snapshot.latestDecision?.nextTask).toBeUndefined();
    expect(snapshot.latestTask).toBeNull();
    expect(snapshot.tasks).toHaveLength(0);
  });

  it("does not queue a builder task when the strategist returns an idle-like next_task phrase", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T03:06:00.000Z",
        endedAt: "2026-03-18T03:06:03.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "LITHIUM_HANDOFF",
          JSON.stringify({
            summary: "지금은 바로 실행할 작업이 없다.",
            next_task: "Keep the builder idle.",
            rationale: "No concrete workspace action is needed yet."
          })
        ].join("\n")
      }))
    };
    const app = new AppService(workspace, { oracleRunner });

    await app.initProject(workspace);
    const snapshot = await app.consultStrategist({
      workspacePath: workspace,
      prompt: "현재 상태만 알려줘."
    });

    expect(snapshot.latestDecision?.nextTask).toBeUndefined();
    expect(snapshot.latestTask).toBeNull();
    expect(snapshot.tasks).toHaveLength(0);
  });

  it("lets a strategist request override the default model and reasoning intensity", async () => {
    const workspace = await createWorkspace();
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T03:10:00.000Z",
        endedAt: "2026-03-18T03:10:04.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "LITHIUM_HANDOFF",
          JSON.stringify({
            summary: "Run the faster strategist pass.",
            next_task: "Keep the builder idle.",
            rationale: "This validates strategist runtime overrides.",
            files: [],
            risks: [],
            paper_actions: [],
            run_actions: [],
            success_criteria: [],
            open_questions: []
          })
        ].join("\n")
      }))
    };
    const app = new AppService(workspace, { oracleRunner });

    await app.initProject(workspace);

    const snapshot = await app.consultStrategist({
      workspacePath: workspace,
      prompt: "Use the faster strategist profile.",
      model: "gpt-5.4-pro",
      reasoningIntensity: "extended"
    });

    expect(oracleRunner.consult).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4-pro",
        browserThinkingTime: "extended"
      })
    );
    expect(snapshot.latestDecision?.model).toBe("gpt-5.4-pro");
  });

  it("lets a builder request override the default model and reasoning effort", async () => {
    const workspace = await createWorkspace();
    const codexRunner = {
      runTask: vi.fn(async () => ({
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-18T03:12:00.000Z",
        endedAt: "2026-03-18T03:12:03.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        finalMessage: [
          "Builder override smoke test.",
          "",
          "LITHIUM_STATUS",
          "SUMMARY: builder override smoke test",
          "FILES: none",
          "RESULT: success"
        ].join("\n")
      }))
    };
    const app = new AppService(workspace, { codexRunner });

    await app.initProject(workspace);

    const snapshot = await app.runBuilderTask({
      workspacePath: workspace,
      prompt: "Confirm the requested builder profile is passed through.",
      model: "gpt-5.3-codex",
      reasoningEffort: "high"
    });

    expect(codexRunner.runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.3-codex",
        reasoningEffort: "high"
      })
    );
    expect(snapshot.latestRun?.model).toBe("gpt-5.3-codex");
  });

  it("delegates strategist sign-in to the dedicated auth runner", async () => {
    const workspace = await createWorkspace();
    const chatgptAuthRunner = {
      signIn: vi.fn(async () => undefined),
      prepareReusableSession: vi.fn(async () => undefined)
    };
    const app = new AppService(workspace, { chatgptAuthRunner });

    await app.beginStrategistSignIn();

    expect(chatgptAuthRunner.signIn).toHaveBeenCalledTimes(1);
    expect(chatgptAuthRunner.prepareReusableSession).toHaveBeenCalledTimes(1);
  });

  it("skips reusable cookie rehydration when strategist runs already use the persistent browser profile", async () => {
    const workspace = await createWorkspace();
    const chatgptAuthRunner = {
      signIn: vi.fn(async () => undefined),
      prepareReusableSession: vi.fn(async () => undefined)
    };
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-18T02:10:00.000Z",
        endedAt: "2026-03-18T02:10:02.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: "SUMMARY: Reused strategist session is healthy."
      }))
    };
    const app = new AppService(workspace, {
      chatgptAuthRunner,
      oracleRunner
    });

    await app.consultStrategist(
      {
        workspacePath: workspace,
        prompt: "Say hello."
      },
      {
        strategistSessionReady: true
      }
    );

    expect(chatgptAuthRunner.prepareReusableSession).not.toHaveBeenCalled();
    expect(oracleRunner.consult).toHaveBeenCalledTimes(1);
  });

  it("creates an untitled workspace on the first research action when no folder is selected", async () => {
    const untitledRoot = await createTempDir("lithium-untitled-root-");
    const oracleRunner = {
      consult: vi.fn(async ({ workspacePath }: { workspacePath: string }) => ({
        command: { command: "npx", args: ["oracle"], cwd: workspacePath },
        startedAt: "2026-03-18T04:00:00.000Z",
        endedAt: "2026-03-18T04:00:04.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "SUMMARY: Start the untitled research session.",
          "NEXT_TASK: Keep the builder idle.",
          "RATIONALE: This validates lazy workspace creation."
        ].join("\n")
      }))
    };
    const app = new AppService("", {
      oracleRunner,
      untitledWorkspaceRoot: untitledRoot
    });

    const snapshot = await app.consultStrategist({
      prompt: "Start a new untitled session."
    });
    const runtimeState = await app.getAppState({
      platform: "darwin",
      electronVersion: "40.8.2",
      chromeVersion: "144.0.0.0",
      nodeVersion: "24.0.0",
      cwd: untitledRoot,
      oracleReady: true,
      codexReady: true,
      oracleChromePath: null,
      discordBotStatus: {
        state: "disabled",
        botTag: "",
        botUserId: "",
        lastError: null,
        workspacePath: ""
      },
      settings: {
        themePreference: "system",
        autopilotPromptLanguage: "auto",
        onboardingDismissed: false,
        strategistSessionReady: false,
        lastWorkspacePath: "",
        sidebarWidth: 220,
        codeCanvasWidth: 540,
        paperPreviewWidth: 780,
        strategistModel: "gpt-5.4",
        strategistReasoningIntensity: "heavy",
        builderModel: "gpt-5.4",
        builderReasoningEffort: "xhigh",
        discordBot: {
          enabled: false,
          token: "",
          workspacePath: "",
          allowedUserIds: [],
          allowedChannelIds: []
        },
        terminalConnectionProfiles: [],
        remoteWorkspaceProfiles: []
      }
    });

    expect(snapshot.project?.workspacePath).toBe(path.join(untitledRoot, "Untitled-1"));
    expect(snapshot.project?.name).toBe("Untitled-1");
    expect(runtimeState.selectedWorkspacePath).toBe(path.join(untitledRoot, "Untitled-1"));
    await expect(access(path.join(untitledRoot, "Untitled-1", ".lithium", "project.json"))).resolves.toBeUndefined();
  });

  it("creates nested workspace files and rejects paths outside the workspace", async () => {
    const workspace = await createWorkspace();
    const app = new AppService(workspace);

    const created = await app.saveWorkspaceFile({
      workspacePath: workspace,
      path: "experiments/quickstart.py",
      content: "print('hello')\n"
    });

    expect(created.relativePath).toBe("experiments/quickstart.py");
    expect(created.content).toContain("print('hello')");
    expect((await app.getSnapshot(workspace)).project).toBeNull();
    await expect(access(path.join(workspace, ".lithium", "project.json"))).rejects.toThrow();

    await expect(
      app.saveWorkspaceFile({
        workspacePath: workspace,
        path: "../outside.py",
        content: "print('nope')\n"
      })
    ).rejects.toThrow("Workspace files must stay inside the selected workspace.");
  });

  it("switches between session and sessionless folders without forcing initialization", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const app = new AppService("");

    await app.initProject(workspaceA);
    await mkdir(path.join(workspaceB, "paper"), { recursive: true });
    await writeFile(path.join(workspaceB, "paper", "draft.tex"), "\\section{Draft}\n", "utf8");

    app.setSelectedWorkspacePath(workspaceA);
    const snapshotA = await app.getSnapshot();
    expect(snapshotA.project?.workspacePath).toBe(workspaceA);

    app.setSelectedWorkspacePath(workspaceB);
    const snapshotB = await app.getSnapshot();
    const workspaceBFiles = await app.listWorkspaceFiles();
    expect(snapshotB.project).toBeNull();
    expect(workspaceBFiles.map((file) => file.relativePath)).toContain("paper/draft.tex");
    await expect(access(path.join(workspaceB, ".lithium", "project.json"))).rejects.toThrow();

    app.setSelectedWorkspacePath(workspaceA);
    const restoredA = await app.getSnapshot();
    expect(restoredA.project?.workspacePath).toBe(workspaceA);
    expect(restoredA.activeThread?.title).toBeTruthy();
  });

  it("reports remote workspace state and pushes saved files back to the remote target", async () => {
    const workspace = await createWorkspace();
    const remoteWorkspace = createRemoteWorkspaceServiceMock(workspace);
    const app = new AppService(workspace, {
      remoteWorkspaceService: remoteWorkspace.service
    });

    const runtimeState = await app.getAppState({
      platform: "darwin",
      electronVersion: "40.8.2",
      chromeVersion: "144.0.0.0",
      nodeVersion: "24.0.0",
      cwd: workspace,
      oracleReady: true,
      codexReady: true,
      oracleChromePath: null,
      discordBotStatus: {
        state: "disabled",
        botTag: "",
        botUserId: "",
        lastError: null,
        workspacePath: ""
      },
      settings: createDefaultSettings()
    });

    expect(runtimeState.selectedWorkspaceKind).toBe("ssh");
    expect(runtimeState.selectedWorkspaceLabel).toContain("GPU Box");

    await app.saveWorkspaceFile({
      workspacePath: workspace,
      path: "experiments/train.py",
      content: "print('remote')\n"
    });

    expect(remoteWorkspace.service.pushWorkspaceFile).toHaveBeenCalledWith(workspace, "experiments/train.py");
  });

  it("compiles paper remotely and pulls artifacts back into the mirror workspace", async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace, "paper"), { recursive: true });
    await writeFile(
      path.join(workspace, "paper", "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nRemote\n\\end{document}\n",
      "utf8"
    );

    const remoteWorkspace = createRemoteWorkspaceServiceMock(workspace, {
      pullWorkspaceFiles: vi.fn(async (_workspacePath, relativePaths) => {
        await writeFile(path.join(workspace, "paper", "main.pdf"), "pdf", "utf8");
        return relativePaths;
      })
    });
    const app = new AppService(workspace, {
      remoteWorkspaceService: remoteWorkspace.service
    });

    const snapshot = await app.compilePaper(workspace);

    expect(remoteWorkspace.service.runWorkspaceCommand).toHaveBeenCalledWith(
      workspace,
      expect.objectContaining({
        command: "tectonic"
      }),
      expect.objectContaining({
        stdoutPath: expect.stringContaining(".stdout.log"),
        stderrPath: expect.stringContaining(".stderr.log")
      })
    );
    expect(remoteWorkspace.service.pullWorkspaceFiles).toHaveBeenCalledWith(workspace, [
      "paper/main.pdf",
      "paper/main.synctex.gz",
      "paper/main.log"
    ]);
    expect(snapshot.project?.workspacePath).toBe(workspace);
  });

  it("defaults terminal sessions to the remote workspace bootstrap command", async () => {
    const workspace = await createWorkspace();
    const remoteWorkspace = createRemoteWorkspaceServiceMock(workspace, {
      buildTerminalBootstrapCommand: vi.fn(async () => "printf 'remote-attached\\n'")
    });
    const app = new AppService(workspace, {
      remoteWorkspaceService: remoteWorkspace.service
    });

    await app.initProject(workspace);
    const session = await app.createTerminalSession({
      workspacePath: workspace,
      forceNew: true
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    const updated = await app.getTerminalSession({
      workspacePath: workspace,
      sessionId: session.id
    });

    expect(remoteWorkspace.service.buildTerminalBootstrapCommand).toHaveBeenCalledWith(workspace);
    expect(updated?.output).toContain("remote-attached");

    await app.closeTerminalSession({
      workspacePath: workspace,
      sessionId: session.id
    });
  });
});

async function createWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lithium-app-"));
  tempDirs.push(workspace);
  return workspace;
}

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function cleanupTempDirs(dirs: string[]) {
  await Promise.all(
    dirs.map(async (dir) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    })
  );
}

function createDefaultSettings(): AppSettings {
  return {
    themePreference: "system",
    autopilotPromptLanguage: "auto",
    onboardingDismissed: false,
    strategistSessionReady: false,
    lastWorkspacePath: "",
    sidebarWidth: 220,
    codeCanvasWidth: 540,
    paperPreviewWidth: 780,
    strategistModel: "gpt-5.4",
    strategistReasoningIntensity: "heavy",
    builderModel: "gpt-5.4",
    builderReasoningEffort: "xhigh",
    discordBot: {
      enabled: false,
      token: "",
      workspacePath: "",
      allowedUserIds: [],
      allowedChannelIds: []
    },
    terminalConnectionProfiles: [],
    remoteWorkspaceProfiles: []
  };
}

function createRemoteWorkspaceServiceMock(
  workspacePath: string,
  overrides: Partial<RemoteWorkspaceServiceLike> = {}
) {
  const profile: RemoteWorkspaceProfile = {
    id: "gpu-box",
    name: "GPU Box",
    kind: "ssh",
    host: "gpu.example.org",
    username: "researcher",
    remotePath: "/workspace/project"
  };
  const metadata: RemoteWorkspaceMetadata = {
    version: 1,
    mirrorPath: workspacePath,
    label: "GPU Box (researcher@gpu.example.org:/workspace/project)",
    kind: "ssh",
    remoteHost: "researcher@gpu.example.org",
    remotePath: "/workspace/project",
    profile
  };

  const service = {
    connect: vi.fn(async () => ({
      workspacePath,
      metadata
    })),
    describe: vi.fn(async (candidatePath: string) => (candidatePath === workspacePath ? metadata : null)),
    syncWorkspace: vi.fn(async () => ({
      workspacePath,
      metadata
    })),
    pushWorkspaceFile: vi.fn(async () => undefined),
    pushWorkspaceFiles: vi.fn(async (_candidatePath: string, relativePaths: string[]) => relativePaths),
    pullWorkspaceFiles: vi.fn(async (_candidatePath: string, relativePaths: string[]) => relativePaths),
    buildTerminalBootstrapCommand: vi.fn(async () => null),
    runWorkspaceCommand: vi.fn(
      async (
        _candidatePath: string,
        spec: CommandSpec
      ): Promise<RemoteWorkspaceCommandResult> => ({
        command: spec,
        startedAt: "2026-03-20T00:00:00.000Z",
        endedAt: "2026-03-20T00:00:01.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "remote compile complete\n",
        stderr: ""
      })
    ),
    ...overrides
  } satisfies RemoteWorkspaceServiceLike;

  return {
    metadata,
    profile,
    service
  };
}

function buildImmediateBuilderCommand(cwd: string, prompt: string, outputPath: string) {
  return {
    command: "node",
    args: [
      "-e",
      [
        "const fs = require('node:fs');",
        "const outputPath = process.argv[1];",
        "const prompt = process.argv[2];",
        "fs.writeFileSync(outputPath, [",
        "  `Completed builder task for: ${prompt}`,",
        "  '',",
        "  'LITHIUM_STATUS',",
        "  'SUMMARY: routed builder task',",
        "  'FILES: paper/main.tex',",
        "  'RESULT: success'",
        "].join('\\n'));"
      ].join(" "),
      outputPath,
      prompt
    ],
    cwd
  };
}

function buildFailedBuilderCommand(cwd: string, prompt: string, outputPath: string) {
  return {
    command: "node",
    args: [
      "-e",
      [
        "const fs = require('node:fs');",
        "const outputPath = process.argv[1];",
        "const prompt = process.argv[2];",
        "fs.writeFileSync(outputPath, [",
        "  `Failed builder task for: ${prompt}`,",
        "  '',",
        "  'LITHIUM_STATUS',",
        "  'SUMMARY: build failed while applying the latest step',",
        "  'RISKS: build is still broken',",
        "  'RESULT: failed'",
        "].join('\\n'));",
        "process.exit(1);"
      ].join(" "),
      outputPath,
      prompt
    ],
    cwd
  };
}

function buildDelayedBuilderCommand(cwd: string, prompt: string, outputPath: string, delayMs: number) {
  return {
    command: "node",
    args: [
      "-e",
      [
        "console.error('OpenAI Codex v0.116.0-alpha.1 (research preview)');",
        "console.error('user');",
        "console.error('You are the Lithium builder running inside the active repository.');",
        "console.error('CONTEXT_PACK:');",
        "const fs = require('node:fs');",
        "const outputPath = process.argv[1];",
        "const prompt = process.argv[2];",
        "const delayMs = Number(process.argv[3]);",
        "setTimeout(() => {",
        "  fs.writeFileSync(outputPath, [",
        "    `Completed builder task for: ${prompt}`,",
        "    '',",
        "    'LITHIUM_STATUS',",
        "    'SUMMARY: routed builder task',",
        "    'FILES: experiments/svm.py',",
        "    'RESULT: success'",
        "  ].join('\\n'));",
        "  process.exit(0);",
        "}, delayMs);"
      ].join(" "),
      outputPath,
      prompt,
      String(delayMs)
    ],
    cwd
  };
}

function buildExecutionContextCaptureCommand(cwd: string, prompt: string, outputPath: string) {
  return {
    command: "node",
    args: [
      "-e",
      [
        "const fs = require('node:fs');",
        "const outputPath = process.argv[1];",
        "const prompt = process.argv[2];",
        "fs.writeFileSync(outputPath, [",
        "  `Captured builder task for: ${prompt}`,",
        "  `cwd=${process.cwd()}`,",
        "  `venv=${process.env.VIRTUAL_ENV || ''}`,",
        "  '',",
        "  'LITHIUM_STATUS',",
        "  JSON.stringify({ summary: 'captured execution context', result: 'success', files: [] })",
        "].join('\\n'));"
      ].join(" "),
      outputPath,
      prompt
    ],
    cwd
  };
}

function buildOutputThenHangBuilderCommand(cwd: string, prompt: string, outputPath: string) {
  return {
    command: "node",
    args: [
      "-e",
      [
        "const fs = require('node:fs');",
        "const outputPath = process.argv[1];",
        "const prompt = process.argv[2];",
        "setTimeout(() => {",
        "  fs.writeFileSync(outputPath, [",
        "    `Completed builder task for: ${prompt}`,",
        "    '',",
        "    'LITHIUM_STATUS',",
        "    JSON.stringify({ summary: 'builder completed before the process stalled', result: 'success', files: [] })",
        "  ].join('\\n'));",
        "}, 25);",
        "setInterval(() => {}, 1_000);"
      ].join(" "),
      outputPath,
      prompt
    ],
    cwd
  };
}

function buildSilentHungBuilderCommand(cwd: string, prompt: string, outputPath: string) {
  return {
    command: "node",
    args: [
      "-e",
      [
        "console.error(`Builder stalled for: ${process.argv[2]}`);",
        "setInterval(() => {}, 1_000);"
      ].join(" "),
      outputPath,
      prompt
    ],
    cwd
  };
}

function buildQuietActiveCommandBuilder(
  cwd: string,
  prompt: string,
  outputPath: string,
  delayMs: number
) {
  return {
    command: "node",
    args: [
      "-e",
      [
        "const fs = require('node:fs');",
        "const outputPath = process.argv[1];",
        "const prompt = process.argv[2];",
        "const delayMs = Number(process.argv[3]);",
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'abc' }));",
        "console.log(JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: '/bin/zsh -lc \"./scripts/run_mlx_eval_compare.sh\"', status: 'in_progress' } }));",
        "setTimeout(() => {",
        "  fs.writeFileSync(outputPath, [",
        "    `Completed builder task for: ${prompt}`,",
        "    '',",
        "    'LITHIUM_STATUS',",
        "    JSON.stringify({ summary: 'quiet active command completed', result: 'success', files: [] })",
        "  ].join('\\n'));",
        "  process.exit(0);",
        "}, delayMs);"
      ].join(" "),
      outputPath,
      prompt,
      String(delayMs)
    ],
    cwd
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "string") {
    process.env[key] = value;
    return;
  }

  delete process.env[key];
}

async function processGone(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function buildJsonlDelayedBuilderCommand(cwd: string, prompt: string, outputPath: string, delayMs: number) {
  return {
    command: "node",
    args: [
      "-e",
      [
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'abc' }));",
        "console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Checking the repo layout first.' } }));",
        "console.log(JSON.stringify({ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: '/bin/zsh -lc \"pwd\"', status: 'in_progress' } }));",
        "const fs = require('node:fs');",
        "const outputPath = process.argv[1];",
        "const prompt = process.argv[2];",
        "const delayMs = Number(process.argv[3]);",
        "setTimeout(() => {",
        "  fs.writeFileSync(outputPath, [",
        "    `Completed builder task for: ${prompt}`,",
        "    '',",
        "    'LITHIUM_STATUS',",
        "    'SUMMARY: routed builder task',",
        "    'FILES: experiments/svm.py',",
        "    'RESULT: success'",
        "  ].join('\\n'));",
        "  process.exit(0);",
        "}, delayMs);"
      ].join(" "),
      outputPath,
      prompt,
      String(delayMs)
    ],
    cwd
  };
}
