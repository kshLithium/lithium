import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS, type AutomationCycleRecord, type AutomationSessionRecord, type AutomationStepRecord } from "../../shared/types";
import { AppService } from "./app-service";

describe("AppService automation loop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts async strategist delegations in the background instead of blocking on consultStrategist", async () => {
    const service = new AppService("/tmp");
    const appService = service as any;
    const strategistStep: AutomationStepRecord = {
      id: "AS001",
      sessionId: "AU001",
      threadId: "TH001",
      cycleId: "AY001",
      kind: "literature-search",
      lane: "strategist",
      workerMode: "async",
      title: "Run the next strategist research branch",
      prompt: "Review the latest local results.",
      status: "running",
      summary: "Step started.",
      startedSideEffects: [],
      completedSideEffects: [],
      changedFiles: [],
      evidence: [],
      checkpointRequired: false,
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z"
    };
    const session: AutomationSessionRecord = {
      id: "AU001",
      threadId: "TH001",
      objective: "Continue the local automation loop.",
      displayObjective: "Continue the local automation loop.",
      mode: "continuous",
      status: "running",
      allowedActions: ["strategize", "experiment-run"],
      evidenceMode: "strict",
      budget: {
        maxSteps: 10,
        maxRuntimeMinutes: 60,
        maxRetries: 3,
        usedSteps: 0,
        usedRetries: 0
      },
      currentStepSummary: "Planning the next cycle.",
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z"
    };
    const cycle: AutomationCycleRecord = {
      id: "AY001",
      sessionId: "AU001",
      threadId: "TH001",
      title: "Automation cycle",
      objective: "Continue the local automation loop.",
      plannerPrompt: "Plan the next bounded cycle.",
      status: "running",
      phase: "workers",
      summary: "Running workers.",
      laneStates: [],
      activeLaneStepIds: [],
      completedLaneStepIds: [],
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z",
      startedAt: "2026-03-26T00:00:00.000Z"
    };
    const controller = {
      running: true,
      pauseRequested: false,
      stopRequested: false,
      redirectInstruction: "",
      activeBuilderRuns: new Map<string, string>(),
      activeStrategistSessions: new Map<string, string>()
    };

    appService.createAutomationStep = vi.fn().mockResolvedValue(strategistStep);
    appService.startAutomationStrategistLane = vi.fn().mockResolvedValue({
      step: {
        ...strategistStep,
        resumeCursor: "ors-auto-real-au001-ay001",
        startedSideEffects: ["oracle-session:ors-auto-real-au001-ay001", "decision-artifacts:D001"]
      },
      strategistSlug: "ors-auto-real-au001-ay001"
    });
    appService.consultStrategist = vi.fn();

    const result = await appService.runAutomationDelegatedWorkerTurn(
      "/tmp",
      session,
      cycle,
      controller,
      {
        lane: "strategist",
        prompt: "Review the latest local results.",
        workerMode: "async"
      },
      "",
      DEFAULT_APP_SETTINGS
    );

    expect(appService.startAutomationStrategistLane).toHaveBeenCalledTimes(1);
    expect(appService.consultStrategist).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      lane: "strategist",
      pending: true
    });
    expect(controller.activeStrategistSessions.get("AS001")).toBe("ors-auto-real-au001-ay001");
  });

  it("preserves sync strategist worker modes in cycle lane state", () => {
    const service = new AppService("/tmp");
    const appService = service as any;

    const laneStates = appService.buildCycleLaneStatesFromDelegations([
      {
        lane: "strategist",
        prompt: "Wait for the strategist before continuing.",
        workerMode: "sync"
      }
    ]);

    expect(laneStates).toHaveLength(1);
    expect(laneStates[0]?.workerMode).toBe("sync");
  });

  it("answers running automation questions directly without interrupting the active automation loop", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-automation-chat-"));

    try {
      const now = "2026-03-26T00:00:00.000Z";
      const codexRunner = {
        runTask: vi.fn().mockResolvedValue({
          command: {
            command: "codex",
            args: ["exec"],
            cwd: workspacePath
          },
          startedAt: now,
          endedAt: now,
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          finalMessage: [
            "쉽게 말하면 현재 자동화는 로컬 practical baseline 기준으로는 좋아졌지만, GitHub 공식 상위권을 이 맥북에서 재현해서 이긴 건 아닙니다.",
            "최근 확정된 로컬 최고점은 full-prefix-256 exact 기준 2.46836251입니다.",
            "LITHIUM_STATUS",
            '{"machine_summary":"Answered the running automation question directly from saved artifacts.","result":"success"}'
          ].join("\n")
        })
      };
      const service = new AppService(workspacePath, {
        codexRunner,
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;

      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id;
      expect(threadId).toBeTruthy();

      const session: AutomationSessionRecord = {
        id: "AU001",
        threadId: threadId ?? "TH001",
        objective: "Keep the local automation loop running.",
        displayObjective: "Keep the local automation loop running.",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "experiment-run", "result-analysis"],
        evidenceMode: "strict",
        budget: {
          maxSteps: 12,
          maxRuntimeMinutes: 120,
          maxRetries: 4,
          usedSteps: 3,
          usedRetries: 0
        },
        activeLaneStepIds: [],
        currentStepSummary: "Run the next builder execution branch",
        lastUserInstruction: "Keep the local automation loop running.",
        queuedUserInstruction: undefined,
        createdAt: now,
        updatedAt: now,
        startedAt: now
      };
      await appService.store.writeAutomationSession(workspacePath, session);

      const interruptSpy = vi.spyOn(appService, "interruptAutomationSession");

      const snapshot = await service.sendChatMessage({
        workspacePath,
        threadId,
        prompt: "지금까지 실험결과 어떰? 쉽게 설명좀해줘."
      });

      expect(interruptSpy).not.toHaveBeenCalled();
      expect(codexRunner.runTask).toHaveBeenCalledTimes(1);
      expect(snapshot.latestAutomationSession?.status).toBe("running");
      expect(snapshot.latestAutomationSession?.lastUserInstruction).toBe(
        "Keep the local automation loop running."
      );
      expect(snapshot.runs).toHaveLength(0);
      const conversationEntries = snapshot.conversationEntries ?? [];
      expect(
        conversationEntries.some(
          (entry) =>
            entry.role === "user" &&
            entry.automationSessionId === "AU001" &&
            entry.body.includes("쉽게 설명좀해줘")
        )
      ).toBe(true);
      expect(
        conversationEntries.some(
          (entry) =>
            entry.role === "assistant" &&
            entry.source === "automation" &&
            entry.automationSessionId === "AU001" &&
            entry.body.includes("GitHub 공식 상위권")
        )
      ).toBe(true);
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("treats softened Korean stop requests as an immediate automation stop", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-automation-stop-"));

    try {
      const now = "2026-03-27T00:00:00.000Z";
      const service = new AppService(workspacePath, {
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;

      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id;
      expect(threadId).toBeTruthy();

      const session: AutomationSessionRecord = {
        id: "AU001",
        threadId: threadId ?? "TH001",
        objective: "Keep the local automation loop running.",
        displayObjective: "Keep the local automation loop running.",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "experiment-run", "result-analysis"],
        evidenceMode: "strict",
        budget: {
          maxSteps: 12,
          maxRuntimeMinutes: 120,
          maxRetries: 4,
          usedSteps: 3,
          usedRetries: 0
        },
        activeLaneStepIds: [],
        currentStepSummary: "Run the next builder execution branch",
        lastUserInstruction: "Keep the local automation loop running.",
        queuedUserInstruction: undefined,
        createdAt: now,
        updatedAt: now,
        startedAt: now
      };
      await appService.store.writeAutomationSession(workspacePath, session);

      const interruptSpy = vi.spyOn(appService, "interruptAutomationSession");

      const snapshot = await service.sendChatMessage({
        workspacePath,
        threadId,
        prompt: "잠깐 연구 중단해줘"
      });

      expect(interruptSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "AU001",
          instruction: "잠깐 연구 중단해줘",
          stopNow: true
        })
      );
      expect(snapshot.latestAutomationSession?.status).toBe("idle");
      expect(snapshot.latestAutomationSession?.currentStepSummary).toBe("Automation stopped by the user.");
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("does not let background work on another workspace steal the selected workspace", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "lithium-workspace-selection-"));
    const selectedWorkspacePath = path.join(workspaceRoot, "real-real");
    const backgroundWorkspacePath = path.join(workspaceRoot, "real");

    try {
      const service = new AppService(selectedWorkspacePath, {
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });

      await service.initProject(selectedWorkspacePath);
      await service.initProject(backgroundWorkspacePath);
      await service.getSnapshot(backgroundWorkspacePath);

      const appState = await service.getAppState({
        platform: "darwin",
        settings: DEFAULT_APP_SETTINGS
      });

      expect(appState.selectedWorkspacePath).toBe(selectedWorkspacePath);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("stops persisted strategist sessions even when the in-memory controller lost track of them", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-automation-stop-"));

    try {
      const now = "2026-03-26T00:00:00.000Z";
      const oracleRunner = {
        consult: vi.fn(),
        terminateSession: vi.fn().mockResolvedValue(undefined)
      };
      const service = new AppService(workspacePath, {
        oracleRunner: oracleRunner as any,
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;
      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id ?? "TH001";

      const session: AutomationSessionRecord = {
        id: "AU001",
        threadId,
        objective: "Keep the local automation loop running.",
        displayObjective: "Keep the local automation loop running.",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "experiment-run", "result-analysis"],
        evidenceMode: "strict",
        budget: {
          maxSteps: 12,
          maxRuntimeMinutes: 120,
          maxRetries: 4,
          usedSteps: 3,
          usedRetries: 0
        },
        activeCycleId: "AY001",
        activeLaneStepIds: ["AS001"],
        latestStepId: "AS001",
        currentStepSummary: "Background strategist research is still running while automation continues.",
        lastUserInstruction: "Keep the local automation loop running.",
        createdAt: now,
        updatedAt: now,
        startedAt: now
      };
      const step: AutomationStepRecord = {
        id: "AS001",
        sessionId: "AU001",
        threadId,
        cycleId: "AY001",
        kind: "literature-search",
        lane: "strategist",
        workerMode: "async",
        title: "Run the next strategist research branch",
        prompt: "Review the latest local results.",
        status: "running",
        summary: "Step started.",
        resumeCursor: "ors-auto-real-au001-ay060",
        startedSideEffects: ["oracle-session:ors-auto-real-au001-ay060"],
        completedSideEffects: [],
        changedFiles: [],
        evidence: [],
        checkpointRequired: false,
        createdAt: now,
        updatedAt: now
      };
      const cycle: AutomationCycleRecord = {
        id: "AY001",
        sessionId: "AU001",
        threadId,
        title: "Automation cycle",
        objective: "Keep the local automation loop running.",
        plannerPrompt: "Plan the next bounded cycle.",
        status: "running",
        phase: "workers",
        summary: "Run the next strategist research branch",
        laneStates: [
          {
            lane: "strategist",
            title: "Run the next strategist research branch",
            status: "running",
            workerMode: "async",
            summary: "Run the next strategist research branch",
            stepId: "AS001",
            resumeCursor: "ors-auto-real-au001-ay060",
            updatedAt: now
          }
        ],
        activeLaneStepIds: ["AS001"],
        completedLaneStepIds: [],
        createdAt: now,
        updatedAt: now,
        startedAt: now
      };

      await appService.store.writeAutomationSession(workspacePath, session);
      await appService.store.writeAutomationCycle(workspacePath, cycle);
      await appService.store.writeAutomationStep(workspacePath, step);

      const snapshot = await appService.interruptAutomationSession({
        workspacePath,
        sessionId: "AU001",
        instruction: "자동연구 중지",
        stopNow: true
      });

      expect(oracleRunner.terminateSession).toHaveBeenCalledWith("ors-auto-real-au001-ay060");
      expect(snapshot.latestAutomationSession?.status).toBe("idle");
      expect(snapshot.latestAutomationSession?.currentStepSummary).toBe("Automation stopped by the user.");
      const persistedStep = snapshot.automationSteps.find((entry: AutomationStepRecord) => entry.id === "AS001");
      expect(persistedStep?.status).toBe("cancelled");
      expect(persistedStep?.summary).toBe("Stopped by the user.");
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("uses the configured strategist model and intensity when no explicit strategist override is provided", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-strategist-defaults-"));

    try {
      const now = "2026-03-27T00:00:00.000Z";
      const oracleRunner = {
        consult: vi.fn().mockResolvedValue({
          command: {
            command: "oracle",
            args: ["--model", "gpt-5.4-pro"],
            cwd: workspacePath
          },
          sessionId: "ors-defaults",
          startedAt: now,
          endedAt: now,
          exitCode: 0,
          stdout: "",
          stderr: "",
          outputText: "Strategist summary."
        })
      };
      const service = new AppService(workspacePath, {
        oracleRunner: oracleRunner as any,
        getAppSettings: async () => ({
          ...DEFAULT_APP_SETTINGS,
          strategistModel: "gpt-5.4-pro",
          strategistReasoningIntensity: "extended"
        })
      });
      const appService = service as any;

      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id;

      oracleRunner.consult.mockResolvedValueOnce({
        command: {
          command: "oracle",
          args: ["--model", "gpt-5.4-pro"],
          cwd: workspacePath
        },
        sessionId: "ors-defaults",
        startedAt: now,
        endedAt: now,
        exitCode: 0,
        stdout: "",
        stderr: "",
        outputText: "Strategist summary. The next experiment is ready."
      });

      await appService.consultStrategist(
        {
          workspacePath,
          threadId,
          prompt: "Plan the next experiment."
        },
        {
          strategistSessionReady: true
        }
      );

      expect(oracleRunner.consult).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.4-pro",
          browserThinkingTime: "extended"
        })
      );
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("surfaces real builder narration without synthetic orchestrator copy", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-chat-progress-"));

    try {
      const service = new AppService(workspacePath, {
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;
      const snapshot = await service.initProject(workspacePath);
      const threadId = snapshot.activeThread?.id ?? "TH001";
      const stdoutPath = path.join(workspacePath, ".lithium", "runs", "live-progress.stdout.log");

      await writeFile(stdoutPath, 'val_progress:125/256\n{"type":"item.completed","item":{"type":"agent_message","text":"중간 상태를 확인하고 있습니다."}}\n', "utf8");
      await appService.appendConversationEntry(workspacePath, {
        threadId,
        role: "user",
        source: "user",
        body: "이 진행 상황은 한국어로 보여줘."
      });

      appService.setChatProgress(workspacePath, {
        lane: "builder",
        threadId,
        progressSummary: "",
        progressDetails: [],
        activeCommand: "python train_gpt_mlx.py",
        stdoutPath,
        stderrPath: path.join(workspacePath, ".lithium", "runs", "live-progress.stderr.log"),
        operationId: "automation-builder"
      });

      const progress = await service.inspectChatProgress({
        workspacePath,
        threadId
      });

      expect(progress).not.toBeNull();
      expect(progress?.lane).toBe("orchestrator");
      expect(progress?.progressSummary).toBe("중간 상태를 확인하고 있습니다.");
      expect(progress?.progressDetails).toEqual([]);
      expect(progress?.activeCommand).toBeNull();
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("removes worker lane labels from parallel automation progress shown to the user", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-chat-progress-parallel-"));

    try {
      const service = new AppService(workspacePath, {
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;
      const snapshot = await service.initProject(workspacePath);
      const threadId = snapshot.activeThread?.id ?? "TH001";
      const builderStdoutPath = path.join(workspacePath, ".lithium", "runs", "parallel-builder.stdout.log");

      await writeFile(builderStdoutPath, "val_progress:50/256\n", "utf8");

      appService.setChatProgress(workspacePath, {
        lane: "builder",
        threadId,
        progressSummary: "",
        progressDetails: [],
        activeCommand: "python train_gpt_mlx.py",
        stdoutPath: builderStdoutPath,
        stderrPath: path.join(workspacePath, ".lithium", "runs", "parallel-builder.stderr.log"),
        operationId: "automation-builder"
      });
      appService.setChatProgress(workspacePath, {
        lane: "strategist",
        threadId,
        progressSummary: "README와 recent logs를 같이 좁혀 보고 있습니다.",
        progressDetails: ["baseline과 novelty 후보를 가르는 중입니다."],
        activeCommand: null,
        stdoutPath: path.join(workspacePath, ".lithium", "decisions", "parallel-strategist.stdout.log"),
        stderrPath: path.join(workspacePath, ".lithium", "decisions", "parallel-strategist.stderr.log"),
        operationId: "automation-strategist"
      });

      const progress = await service.inspectChatProgress({
        workspacePath,
        threadId
      });

      expect(progress).not.toBeNull();
      expect(progress?.lane).toBe("orchestrator");
      expect(progress?.progressSummary).toBe("README와 recent logs를 같이 좁혀 보고 있습니다.");
      expect(progress?.progressDetails).toEqual([]);
      expect(progress?.progressDetails.join("\n")).not.toContain("Builder");
      expect(progress?.progressDetails.join("\n")).not.toContain("Strategist");
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("does not synthesize localized strategist fallback copy", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-chat-progress-language-"));

    try {
      const service = new AppService(workspacePath, {
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;
      const snapshot = await service.initProject(workspacePath);
      const threadId = snapshot.activeThread?.id ?? "TH001";

      await appService.appendConversationEntry(workspacePath, {
        threadId,
        role: "user",
        source: "user",
        body: "다음 진행은 한국어로만 짧게 알려줘."
      });

      appService.setChatProgress(workspacePath, {
        lane: "strategist",
        threadId,
        progressSummary: "Reading documents",
        progressDetails: [],
        activeCommand: null,
        stdoutPath: path.join(workspacePath, ".lithium", "decisions", "language-strategist.stdout.log"),
        stderrPath: path.join(workspacePath, ".lithium", "decisions", "language-strategist.stderr.log"),
        operationId: "automation-strategist"
      });

      const progress = await service.inspectChatProgress({
        workspacePath,
        threadId
      });

      expect(progress).not.toBeNull();
      expect(progress?.progressSummary).toBe("Reading documents");
      expect(progress?.progressDetails).toEqual([]);
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("records redirect-style automation chat messages in the conversation and session state", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-automation-redirect-"));

    try {
      const now = "2026-03-26T00:00:00.000Z";
      const service = new AppService(workspacePath, {
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;
      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id;

      expect(threadId).toBeTruthy();

      const session: AutomationSessionRecord = {
        id: "AU001",
        threadId: threadId ?? "TH001",
        objective: "Keep the local automation loop running.",
        displayObjective: "Keep the local automation loop running.",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "experiment-run", "result-analysis"],
        evidenceMode: "strict",
        budget: {
          maxSteps: 12,
          maxRuntimeMinutes: 120,
          maxRetries: 4,
          usedSteps: 3,
          usedRetries: 0
        },
        activeLaneStepIds: [],
        currentStepSummary: "Run the next builder execution branch",
        lastUserInstruction: "Keep the local automation loop running.",
        queuedUserInstruction: undefined,
        createdAt: now,
        updatedAt: now,
        startedAt: now
      };
      await appService.store.writeAutomationSession(workspacePath, session);

      const snapshot = await service.interruptAutomationSession({
        workspacePath,
        sessionId: "AU001",
        instruction: "공식 기준점 대비 개선 여부를 더 우선해서 보면서 이어가"
      });

      expect(snapshot.latestAutomationSession?.status).toBe("running");
      expect(snapshot.latestAutomationSession?.lastUserInstruction).toBe(
        "공식 기준점 대비 개선 여부를 더 우선해서 보면서 이어가"
      );
      expect(snapshot.latestAutomationSession?.queuedUserInstruction).toBe(
        "공식 기준점 대비 개선 여부를 더 우선해서 보면서 이어가"
      );
      expect(
        snapshot.conversationEntries?.some(
          (entry) =>
            entry.role === "user" &&
            entry.automationSessionId === "AU001" &&
            entry.body === "공식 기준점 대비 개선 여부를 더 우선해서 보면서 이어가"
        )
      ).toBe(true);
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("includes the latest user steering and recent user chat in the automation planner prompt", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-automation-planner-"));

    try {
      const prompts: string[] = [];
      const orchestratorRunner = {
        runTurn: vi.fn(async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return {
            sessionId: "planner-session",
            finalMessage: "",
            requestedLane: null,
            delegatedPrompt: "",
            delegation: null,
            delegations: []
          };
        })
      };
      const now = "2026-03-26T00:00:00.000Z";
      const service = new AppService(workspacePath, {
        orchestratorRunner: orchestratorRunner as any,
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;
      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id;

      expect(threadId).toBeTruthy();

      const session: AutomationSessionRecord = {
        id: "AU001",
        threadId: threadId ?? "TH001",
        objective: "Keep the local automation loop running.",
        displayObjective: "Keep the local automation loop running.",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "experiment-run", "result-analysis"],
        evidenceMode: "strict",
        budget: {
          maxSteps: 12,
          maxRuntimeMinutes: 120,
          maxRetries: 4,
          usedSteps: 3,
          usedRetries: 0
        },
        activeLaneStepIds: [],
        currentStepSummary: "Plan and launch the next bounded automation cycle",
        lastUserInstruction: "공식 상위권 baseline 대비 gap을 더 중요하게 봐",
        queuedUserInstruction: undefined,
        createdAt: now,
        updatedAt: now,
        startedAt: now
      };
      await appService.store.writeAutomationSession(workspacePath, session);
      await appService.appendConversationEntry(workspacePath, {
        threadId: threadId ?? "TH001",
        role: "user",
        source: "user",
        body: "이번엔 warm38 주변 미세조정보다 다른 알고리즘 family를 먼저 봐줘.",
        automationSessionId: "AU001"
      });

      const snapshot = await service.getSnapshot(workspacePath);
      const controller = appService.getAutomationController(workspacePath, "AU001");

      await appService.runAutomationOrchestratorCycle(
        workspacePath,
        session,
        controller,
        snapshot,
        "",
        DEFAULT_APP_SETTINGS
      );

      expect(orchestratorRunner.runTurn).toHaveBeenCalled();
      expect(prompts[0]).toContain("현재 가장 우선할 사용자 지시: 공식 상위권 baseline 대비 gap을 더 중요하게 봐");
      expect(prompts[0]).toContain("최근 사용자 메시지:");
      expect(prompts[0]).toContain("이번엔 warm38 주변 미세조정보다 다른 알고리즘 family를 먼저 봐줘.");
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("does not collapse repeated automation paragraphs at save time", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-automation-dedupe-"));

    try {
      const now = "2026-03-26T00:00:00.000Z";
      const service = new AppService(workspacePath, {
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;
      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id;

      expect(threadId).toBeTruthy();

      const session: AutomationSessionRecord = {
        id: "AU001",
        threadId: threadId ?? "TH001",
        objective: "Keep the local automation loop running.",
        displayObjective: "Keep the local automation loop running.",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "experiment-run", "result-analysis"],
        evidenceMode: "strict",
        budget: {
          maxSteps: 12,
          maxRuntimeMinutes: 120,
          maxRetries: 4,
          usedSteps: 3,
          usedRetries: 0
        },
        activeLaneStepIds: [],
        currentStepSummary: "Run the next builder execution branch",
        createdAt: now,
        updatedAt: now,
        startedAt: now
      };

      await appService.appendAutomationAssistantEntry(workspacePath, {
        session,
        body: [
          "다음 bounded cycle은 schedule 축의 warm36 한 점입니다.",
          "",
          "TIED_EMBED_LR=0.0475 시도는 크게 졌습니다.",
          "",
          "다음 bounded cycle은 schedule 축의 warm36 한 점입니다."
        ].join("\n")
      });

      const snapshot = await service.getSnapshot(workspacePath);
      const latestEntry = snapshot.conversationEntries?.at(-1);

      expect(latestEntry?.role).toBe("assistant");
      expect(latestEntry?.source).toBe("automation");
      expect(latestEntry?.body.match(/warm36 한 점입니다\./g)?.length).toBe(2);
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("turns strategist advisor output into a high-level automation update instead of echoing the raw reply", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-automation-advisor-"));

    try {
      const now = "2026-03-26T00:00:00.000Z";
      const service = new AppService(workspacePath, {
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;
      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id;

      expect(threadId).toBeTruthy();

      const session: AutomationSessionRecord = {
        id: "AU001",
        threadId: threadId ?? "TH001",
        objective: "Keep the local automation loop running.",
        displayObjective: "Keep the local automation loop running.",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "experiment-run", "result-analysis"],
        evidenceMode: "strict",
        budget: {
          maxSteps: 12,
          maxRuntimeMinutes: 120,
          maxRetries: 4,
          usedSteps: 3,
          usedRetries: 0
        },
        activeLaneStepIds: [],
        currentStepSummary: "Resolve the next branch and keep automation moving",
        createdAt: now,
        updatedAt: now,
        startedAt: now
      };
      await appService.store.writeAutomationSession(workspacePath, session);

      const decisionOutput = [
        "방금 raw stronger-proxy 확인까지 끝났으니, 이제는 warm36_gclip02를 로컬 practical baseline으로 고정하고 같은 warm36 레시피에서 grad clip만 한 칸 더 낮추는 단일 training-side probe로 이어가는 게 맞습니다.",
        "이 문단은 사용자에게 그대로 보이면 너무 길고 디테일합니다.",
        "",
        "LITHIUM_HANDOFF",
        JSON.stringify({
          machine_summary: "warm36_gclip02를 practical baseline으로 고정하고 grad clip 0.1 probe 한 번만 더 여는 쪽이 가장 값싼 다음 수입니다.",
          rationale: "raw stronger-proxy 확인까지 끝나서 지금은 새 축을 넓히기보다 이미 이기고 있는 grad clip 축을 한 칸 더 밀어보는 편이 기대값이 가장 높습니다.",
          run_actions: ["warm36_te0045_scalarlr0035_gclip01 단일 probe를 바로 실행하세요."]
        })
      ].join("\n");
      const decisionPath = path.join(workspacePath, ".lithium", "decisions", "D001.output.txt");
      const decision: any = {
        id: "D001",
        threadId: threadId ?? "TH001",
        prompt: "Decide the next bounded step.",
        displayPrompt: "[Autopilot] Keep the local automation loop running.",
        inputFiles: [],
        rawOutput: decisionOutput,
        summary: "warm36_gclip02를 practical baseline으로 고정하고 grad clip 0.1 probe 한 번만 더 여는 쪽이 가장 값싼 다음 수입니다.",
        rationale:
          "raw stronger-proxy 확인까지 끝나서 지금은 새 축을 넓히기보다 이미 이기고 있는 grad clip 축을 한 칸 더 밀어보는 편이 기대값이 가장 높습니다.",
        handoff: {
          schemaVersion: "lithium_handoff_v1",
          role: "strategist",
          summary: "warm36_gclip02를 practical baseline으로 고정하고 grad clip 0.1 probe 한 번만 더 여는 쪽이 가장 값싼 다음 수입니다.",
          machineSummary:
            "warm36_gclip02를 practical baseline으로 고정하고 grad clip 0.1 probe 한 번만 더 여는 쪽이 가장 값싼 다음 수입니다.",
          rationale:
            "raw stronger-proxy 확인까지 끝나서 지금은 새 축을 넓히기보다 이미 이기고 있는 grad clip 축을 한 칸 더 밀어보는 편이 기대값이 가장 높습니다.",
          files: [],
          risks: [],
          runActions: ["warm36_te0045_scalarlr0035_gclip01 단일 probe를 바로 실행하세요."],
          successCriteria: [],
          openQuestions: []
        },
        model: "gpt-5.4-pro",
        engine: "browser",
        status: "completed",
        command: {
          command: "oracle",
          args: ["--slug", "ors-auto-real-au001-ay001-as001"],
          cwd: workspacePath
        },
        stdoutPath: path.join(workspacePath, ".lithium", "decisions", "D001.stdout.log"),
        stderrPath: path.join(workspacePath, ".lithium", "decisions", "D001.stderr.log"),
        outputPath: decisionPath,
        createdAt: now
      };

      appService.consultStrategist = vi.fn(async () => {
        await writeFile(decisionPath, decisionOutput, "utf8");
        await appService.store.writeDecision(workspacePath, decision);
        return await appService.store.getSnapshot(workspacePath);
      });

      const result = await appService.consultAutomationContinuationAdvisor(workspacePath, {
        session,
        reason: "controller-failure"
      });

      expect(result.userMessage).toContain("전략 판단은");
      expect(result.userMessage).toContain("다음 bounded step은");
      expect(result.userMessage).not.toContain("방금 raw stronger-proxy 확인까지 끝났으니");
      expect(result.userMessage).not.toContain("…");
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("stores full automation worker replies in a dedicated worker history log", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-worker-history-"));

    try {
      const now = "2026-03-26T00:00:00.000Z";
      const service = new AppService(workspacePath, {
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;
      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id;

      expect(threadId).toBeTruthy();

      const session: AutomationSessionRecord = {
        id: "AU001",
        threadId: threadId ?? "TH001",
        objective: "Keep the local automation loop running.",
        displayObjective: "Keep the local automation loop running.",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "experiment-run", "result-analysis"],
        evidenceMode: "strict",
        budget: {
          maxSteps: 12,
          maxRuntimeMinutes: 120,
          maxRetries: 4,
          usedSteps: 3,
          usedRetries: 0
        },
        activeLaneStepIds: ["AS001", "AS002"],
        latestCycleId: "AY001",
        activeCycleId: "AY001",
        currentStepSummary: "Run the next worker branches",
        createdAt: now,
        updatedAt: now,
        startedAt: now
      };
      const cycle: AutomationCycleRecord = {
        id: "AY001",
        sessionId: "AU001",
        threadId: threadId ?? "TH001",
        title: "Automation cycle",
        objective: "Keep the local automation loop running.",
        plannerPrompt: "Plan the next bounded cycle.",
        status: "running",
        phase: "workers",
        summary: "Running workers.",
        laneStates: [],
        activeLaneStepIds: ["AS001", "AS002"],
        completedLaneStepIds: [],
        createdAt: now,
        updatedAt: now,
        startedAt: now
      };
      const strategistStep: AutomationStepRecord = {
        id: "AS001",
        sessionId: "AU001",
        threadId: threadId ?? "TH001",
        cycleId: "AY001",
        kind: "strategize",
        lane: "strategist",
        workerMode: "sync",
        title: "Run the next strategist branch",
        prompt: "Review the latest local results.",
        status: "running",
        summary: "Step started.",
        startedSideEffects: [],
        completedSideEffects: [],
        changedFiles: [],
        evidence: [],
        checkpointRequired: false,
        createdAt: now,
        updatedAt: now
      };
      const builderStep: AutomationStepRecord = {
        id: "AS002",
        sessionId: "AU001",
        threadId: threadId ?? "TH001",
        cycleId: "AY001",
        kind: "experiment-run",
        lane: "builder",
        workerMode: "async",
        title: "Run the next builder branch",
        prompt: "Execute the next bounded experiment.",
        status: "running",
        summary: "Step started.",
        startedSideEffects: [],
        completedSideEffects: [],
        changedFiles: [],
        evidence: [],
        checkpointRequired: false,
        createdAt: now,
        updatedAt: now
      };

      await appService.store.writeAutomationSession(workspacePath, session);
      await appService.store.writeAutomationCycle(workspacePath, cycle);
      await appService.store.writeAutomationStep(workspacePath, strategistStep);
      await appService.store.writeAutomationStep(workspacePath, builderStep);

      const decisionOutput = [
        "방금 raw stronger-proxy 확인까지 끝났으니, 이제는 warm36_gclip02를 baseline으로 유지합니다.",
        "",
        "LITHIUM_HANDOFF",
        JSON.stringify({
          machine_summary: "warm36_gclip02 baseline 유지 후 grad clip 0.1 probe 권장"
        })
      ].join("\n");
      const decisionPath = path.join(workspacePath, ".lithium", "decisions", "D001.output.txt");
      await writeFile(decisionPath, decisionOutput, "utf8");
      await appService.store.writeDecision(workspacePath, {
        id: "D001",
        threadId: threadId ?? "TH001",
        prompt: "Review the latest local results.",
        displayPrompt: "[Autopilot] Keep the local automation loop running.",
        inputFiles: [],
        rawOutput: decisionOutput,
        summary: "warm36_gclip02 baseline 유지 후 grad clip 0.1 probe 권장",
        rationale: "현재 이기는 축을 한 칸 더 밀어보는 편이 가장 값쌉니다.",
        handoff: {
          schemaVersion: "lithium_handoff_v1",
          role: "strategist",
          summary: "warm36_gclip02 baseline 유지 후 grad clip 0.1 probe 권장",
          machineSummary: "warm36_gclip02 baseline 유지 후 grad clip 0.1 probe 권장",
          files: [],
          risks: [],
          runActions: ["warm36_te0045_scalarlr0035_gclip01 단일 probe 실행"],
          successCriteria: [],
          openQuestions: []
        },
        model: "gpt-5.4-pro",
        engine: "browser",
        status: "completed",
        command: {
          command: "oracle",
          args: ["--slug", "ors-auto-real-au001-ay001-as001"],
          cwd: workspacePath
        },
        stdoutPath: path.join(workspacePath, ".lithium", "decisions", "D001.stdout.log"),
        stderrPath: path.join(workspacePath, ".lithium", "decisions", "D001.stderr.log"),
        outputPath: decisionPath,
        createdAt: now
      });

      const runOutput = [
        "Implemented the workspace step and captured the latest result.",
        "",
        "LITHIUM_STATUS",
        JSON.stringify({
          machine_summary: "warm36_gclip02 raw stronger-proxy exact 2.45820982로 practical baseline 승격",
          result: "success"
        })
      ].join("\n");
      const runPath = path.join(workspacePath, ".lithium", "runs", "R001.output.txt");
      await writeFile(runPath, runOutput, "utf8");
      await appService.store.writeRun(workspacePath, {
        id: "R001",
        threadId: threadId ?? "TH001",
        taskId: "T001",
        prompt: "Execute the next bounded experiment.",
        displayPrompt: "[Autopilot] Execute the next bounded experiment.",
        model: "gpt-5.4",
        status: "completed",
        exitCode: 0,
        pid: null,
        command: {
          command: "codex",
          args: ["exec"],
          cwd: workspacePath
        },
        stdoutPath: path.join(workspacePath, ".lithium", "runs", "R001.stdout.log"),
        stderrPath: path.join(workspacePath, ".lithium", "runs", "R001.stderr.log"),
        finalMessagePath: runPath,
        finalMessage: runOutput,
        handoff: {
          schemaVersion: "lithium_handoff_v1",
          role: "builder",
          summary: "warm36_gclip02 raw stronger-proxy exact 2.45820982로 practical baseline 승격",
          machineSummary: "warm36_gclip02 raw stronger-proxy exact 2.45820982로 practical baseline 승격",
          result: "success",
          files: [],
          risks: [],
          runActions: ["같은 축에서 grad clip 0.1 probe 검토"],
          successCriteria: [],
          openQuestions: []
        },
        changedFiles: [],
        finalization: "auto",
        createdAt: now,
        startedAt: now,
        endedAt: now
      });

      await appService.completeAutomationStep(workspacePath, session, strategistStep, {
        status: "completed",
        summary: "warm36_gclip02 baseline 유지 후 grad clip 0.1 probe 권장",
        decisionId: "D001",
        changedFiles: [],
        evidence: []
      });
      await appService.completeAutomationStep(workspacePath, session, builderStep, {
        status: "completed",
        summary: "warm36_gclip02 raw stronger-proxy exact 2.45820982로 practical baseline 승격",
        runId: "R001",
        changedFiles: [],
        evidence: []
      });

      const workerHistoryPath = appService.store.buildPaths(workspacePath).workerHistoryLog;
      const historyEntries = (await readFile(workerHistoryPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(historyEntries).toHaveLength(2);
      expect(historyEntries[0]).toMatchObject({
        lane: "strategist",
        automationStepId: "AS001",
        artifactId: "D001",
        replyPath: decisionPath
      });
      expect(String(historyEntries[0].replyBody)).toContain("방금 raw stronger-proxy 확인까지 끝났으니");
      expect(historyEntries[1]).toMatchObject({
        lane: "builder",
        automationStepId: "AS002",
        artifactId: "R001",
        replyPath: runPath
      });
      expect(String(historyEntries[1].replyBody)).toContain("Implemented the workspace step");
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
