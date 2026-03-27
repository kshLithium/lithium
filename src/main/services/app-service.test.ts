import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS, type AutomationCycleRecord, type AutomationSessionRecord, type AutomationStepRecord } from "../../shared/types";
import {
  AppService,
  buildAutomationContinuationAdvisorPrompt,
  buildAutomationStrategistPrompt,
  buildRequiredAutomationStrategistDelegation,
  buildOrchestratorParallelFollowupPrompt,
  buildOrchestratorWorkerFollowupPrompt,
  shouldRefreshAutomationStrategist,
  summarizeAutomationWorkerResultsForConversation,
  summarizeWorkerSnapshotsForConversation
} from "./app-service";

const ZIP_NOTES_FIXTURE_BASE64 =
  "UEsDBAoAAAAAACEQfFw1CU0iDwAAAA8AAAAJABwAbm90ZXMudHh0VVQJAAPOt8ZpzrfGaXV4CwABBPUBAAAEFAAAAGhlbGxvIGZyb20gemlwClBLAQIeAwoAAAAAACEQfFw1CU0iDwAAAA8AAAAJABgAAAAAAAEAAACkgQAAAABub3Rlcy50eHRVVAUAA863xml1eAsAAQT1AQAABBQAAABQSwUGAAAAAAEAAQBPAAAAUgAAAAAA";

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
      const threadId = initialized.activeThread?.id ?? "TH001";
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
      const threadId = initialized.activeThread?.id ?? "TH001";
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
          outputText: "Strategist summary. Review the uploaded evidence and proceed with the next experiment."
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

  it("packages richer strategist context and caps browser uploads to provider limits", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-strategist-context-"));
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "lithium-strategist-context-src-"));

    try {
      const now = "2026-03-27T00:00:00.000Z";
      const oracleRunner = {
        consult: vi.fn().mockResolvedValue({
          command: {
            command: "oracle",
            args: ["--model", "gpt-5.4-pro"],
            cwd: workspacePath
          },
          sessionId: "ors-context",
          startedAt: now,
          endedAt: now,
          exitCode: 0,
          stdout: "",
          stderr: "",
          outputText: "Strategist summary. The next experiment is ready."
        })
      };
      await mkdir(path.join(workspacePath, "src"), { recursive: true });
      await mkdir(path.join(workspacePath, "reports"), { recursive: true });
      await writeFile(path.join(workspacePath, "src", "train_model.py"), "print('train')\n", "utf8");
      await writeFile(path.join(workspacePath, "reports", "metrics.csv"), "step,score\n1,0.71\n", "utf8");
      await writeFile(path.join(workspacePath, "README.md"), "# Lithium\n\nResearch cockpit.\n", "utf8");

      const attachmentPaths = await Promise.all(
        Array.from({ length: 8 }, async (_value, index) => {
          const filePath = path.join(sourceDir, `note-${index + 1}.md`);
          await writeFile(filePath, `note ${index + 1}\n`, "utf8");
          return filePath;
        })
      );

      const service = new AppService(workspacePath, {
        oracleRunner: oracleRunner as any,
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;
      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id;

      await service.importAttachments({
        workspacePath,
        threadId,
        filePaths: attachmentPaths
      });

      await appService.consultStrategist(
        {
          workspacePath,
          threadId,
          prompt: "Review reports/metrics.csv and src/train_model.py with the attached notes and decide the next direction.",
          displayPrompt: "지금 파일들과 첨부를 반영해서 다음 방향을 정해줘."
        },
        {
          strategistSessionReady: true
        }
      );

      const consultInput = oracleRunner.consult.mock.calls.at(-1)?.[0];

      expect(consultInput.prompt).toContain("원래 사용자 메시지");
      expect(consultInput.prompt).toContain("정리된 strategist 작업 지시");
      expect(consultInput.files).toHaveLength(10);
      expect(consultInput.files.some((file: string) => file.endsWith(".strategist.runtime.md"))).toBe(true);
      expect(consultInput.files.some((file: string) => file.endsWith(".strategist.md"))).toBe(true);
      expect(consultInput.files.some((file: string) => file.endsWith(".strategist.digest.md"))).toBe(true);
      expect(consultInput.files).toContain(path.join(workspacePath, "reports", "metrics.csv"));
      expect(consultInput.files).toContain(path.join(workspacePath, "src", "train_model.py"));
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      await rm(sourceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("surfaces unsupported archives in strategist context while still uploading supported images", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-strategist-archive-"));
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "lithium-strategist-archive-src-"));

    try {
      const now = "2026-03-27T00:00:00.000Z";
      const oracleRunner = {
        consult: vi.fn().mockResolvedValue({
          command: {
            command: "oracle",
            args: ["--model", "gpt-5.4-pro"],
            cwd: workspacePath
          },
          sessionId: "ors-archive",
          startedAt: now,
          endedAt: now,
          exitCode: 0,
          stdout: "",
          stderr: "",
          outputText: "Strategist summary. The next experiment is ready."
        })
      };
      const service = new AppService(workspacePath, {
        oracleRunner: oracleRunner as any,
        getAppSettings: async () => DEFAULT_APP_SETTINGS
      });
      const appService = service as any;
      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id;
      const notesPath = path.join(sourceDir, "note.md");
      const chartPath = path.join(sourceDir, "chart.png");
      const archivePath = path.join(sourceDir, "bundle.zip");

      await writeFile(notesPath, "note\n", "utf8");
      await writeFile(chartPath, "png-bytes", "utf8");
      await writeFile(archivePath, Buffer.from(ZIP_NOTES_FIXTURE_BASE64, "base64"));

      await service.importAttachments({
        workspacePath,
        threadId,
        filePaths: [notesPath, chartPath, archivePath]
      });

      await appService.consultStrategist(
        {
          workspacePath,
          threadId,
          prompt: "Review chart.png and bundle.zip and explain what matters.",
          displayPrompt: "현재 상황을 풍부하게 설명해줘."
        },
        {
          strategistSessionReady: true
        }
      );

      const consultInput = oracleRunner.consult.mock.calls.at(-1)?.[0]!;
      expect(consultInput.files).toContain(
        path.join(workspacePath, "attachments", threadId!, "chart.png")
      );
      expect(consultInput.files.join("\n")).not.toContain("bundle.zip");
      expect(consultInput.prompt).toContain("직접 업로드");
      expect(consultInput.prompt).toContain("bundle.zip");

      const digestPath = consultInput.files.find((file: string) => file.endsWith(".strategist.digest.md"));
      const runtimePath = consultInput.files.find((file: string) => file.endsWith(".strategist.runtime.md"));
      expect(digestPath).toBeTruthy();
      expect(runtimePath).toBeTruthy();
      const digest = await readFile(digestPath!, "utf8");
      const runtime = await readFile(runtimePath!, "utf8");

      expect(digest).toContain("## Files Not Uploaded Directly");
      expect(digest).toContain("bundle.zip");
      expect(digest).toContain("Archive digest:");
      expect(digest).toContain("notes.txt");
      expect(runtime).toContain("Skipped direct uploads for this turn:");
      expect(runtime).toContain("bundle.zip");
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      await rm(sourceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("reuses the same strategist submission packaging for async strategist starts", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-strategist-async-"));
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "lithium-strategist-async-src-"));

    try {
      const oracleRunner = {
        startConsult: vi.fn().mockResolvedValue({
          command: {
            command: "oracle",
            args: ["--model", "gpt-5.4-pro"],
            cwd: workspacePath
          },
          sessionId: "ors-async-packaging",
          startedAt: "2026-03-28T00:00:00.000Z",
          pid: 1234,
          slug: "ors-async-packaging",
          model: "gpt-5.4-pro",
          files: [],
          outputPath: path.join(workspacePath, ".lithium", "decisions", "async.output.log"),
          stdoutPath: path.join(workspacePath, ".lithium", "decisions", "async.stdout.log"),
          stderrPath: path.join(workspacePath, ".lithium", "decisions", "async.stderr.log")
        })
      };
      const service = new AppService(workspacePath, {
        oracleRunner: oracleRunner as any,
        getAppSettings: async () => ({
          ...DEFAULT_APP_SETTINGS,
          strategistSessionReady: true
        })
      });
      const initialized = await service.initProject(workspacePath);
      const threadId = initialized.activeThread?.id ?? "TH001";
      const notesPath = path.join(sourceDir, "note.md");
      const chartPath = path.join(sourceDir, "chart.png");
      const archivePath = path.join(sourceDir, "bundle.zip");

      await writeFile(notesPath, "note\n", "utf8");
      await writeFile(chartPath, "png-bytes", "utf8");
      await writeFile(archivePath, Buffer.from(ZIP_NOTES_FIXTURE_BASE64, "base64"));

      await service.importAttachments({
        workspacePath,
        threadId,
        filePaths: [notesPath, chartPath, archivePath]
      });

      await (service as any).startAutomationStrategistLane(
        workspacePath,
        {
          id: "AU001",
          threadId,
          objective: "Continue the local automation loop.",
          displayObjective: "Continue the local automation loop.",
          mode: "continuous",
          status: "running",
          allowedActions: ["strategize"],
          evidenceMode: "strict",
          budget: {
            maxSteps: 10,
            maxRuntimeMinutes: 60,
            maxRetries: 3,
            usedSteps: 0,
            usedRetries: 0
          },
          currentStepSummary: "Researching the next direction.",
          createdAt: "2026-03-28T00:00:00.000Z",
          updatedAt: "2026-03-28T00:00:00.000Z"
        },
        {
          id: "AY001",
          sessionId: "AU001",
          threadId,
          title: "Automation cycle",
          objective: "Continue the local automation loop.",
          plannerPrompt: "Plan the next bounded cycle.",
          status: "running",
          phase: "workers",
          summary: "Running workers.",
          laneStates: [],
          activeLaneStepIds: [],
          completedLaneStepIds: [],
          createdAt: "2026-03-28T00:00:00.000Z",
          updatedAt: "2026-03-28T00:00:00.000Z",
          startedAt: "2026-03-28T00:00:00.000Z"
        },
        {
          id: "AS001",
          sessionId: "AU001",
          threadId,
          cycleId: "AY001",
          kind: "literature-search",
          lane: "strategist",
          workerMode: "async",
          title: "Run strategist packaging test",
          prompt: "Review the evidence.",
          status: "running",
          summary: "Step started.",
          startedSideEffects: [],
          completedSideEffects: [],
          changedFiles: [],
          evidence: [],
          checkpointRequired: false,
          createdAt: "2026-03-28T00:00:00.000Z",
          updatedAt: "2026-03-28T00:00:00.000Z"
        },
        {
          lane: "strategist",
          prompt: "Review chart.png and bundle.zip and summarize the current state.",
          attachExplicitWorkspaceFiles: true
        },
        "Autopilot review",
        {
          ...DEFAULT_APP_SETTINGS,
          strategistSessionReady: true
        },
        "automation-strategist"
      );

      expect(oracleRunner.startConsult).toHaveBeenCalledTimes(1);
      const startInput = oracleRunner.startConsult.mock.calls[0]?.[0];
      expect(startInput.prompt).toContain("Attached context files");
      expect(startInput.prompt).toContain("bundle.zip");
      expect(startInput.files).toEqual(
        expect.arrayContaining([
          expect.stringContaining(".strategist.runtime.md"),
          expect.stringContaining(".strategist.md"),
          expect.stringContaining("chart.png")
        ])
      );
      expect(startInput.files.join("\n")).not.toContain("bundle.zip");
    } finally {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      await rm(sourceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

  it("strips a leading echoed user steering paragraph from automation assistant replies", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-automation-echo-strip-"));

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
      await appService.appendConversationEntry(workspacePath, {
        threadId: session.threadId,
        role: "user",
        source: "user",
        body: "더 다양한 접근법을 리서치해야할 거 같은데 논문이나 학습사례나 좀 더 다양하게 리서치를 해보셈 최신 기술로다가 현재 너무 strate 모델이 놀고 있음",
        automationSessionId: session.id
      });

      await appService.appendAutomationAssistantEntry(workspacePath, {
        session,
        body: [
          "더 다양한 접근법을 리서치해야할 거 같은데 논문이나 학습사례나 좀 더 다양하게 리서치를 해보셈 최신 기술로다가 현재 너무 strate 모델이 놀고 있음",
          "",
          "이번 턴 요청 파일이 비어 있어서, 바로 다음 실행과 큐 메모를 새로 다시 써두겠습니다."
        ].join("\n\n")
      });

      const snapshot = await service.getSnapshot(workspacePath);
      const latestEntry = snapshot.conversationEntries?.at(-1);

      expect(latestEntry?.role).toBe("assistant");
      expect(latestEntry?.source).toBe("automation");
      expect(latestEntry?.body).toBe("이번 턴 요청 파일이 비어 있어서, 바로 다음 실행과 큐 메모를 새로 다시 써두겠습니다.");
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

  it("keeps single-lane builder followup prompts framed by portfolio guidance instead of raw worker output", () => {
    const originalPrompt = "지금 상황을 위에서 정리해줘.";
    const prompt = buildOrchestratorWorkerFollowupPrompt({
      originalPrompt,
      lane: "builder",
      workerPrompt: "Run the next bounded experiment.",
      snapshot: {
        latestDecision: {
          summary: "n7를 현재 gate로 유지하고 top1 local anchor 재현을 먼저 닫는 편이 맞습니다.",
          rationale: "지금은 새 novelty보다 비교축을 먼저 맞추는 편이 더 중요합니다.",
          handoff: {
            summary: "n7를 현재 gate로 유지하고 top1 local anchor 재현을 먼저 닫는 편이 맞습니다.",
            runActions: ["PR #549 local anchor 한 번을 먼저 확정하세요."],
            openQuestions: []
          }
        },
        latestRun: {
          finalMessage:
            "n17이 실제로 승격됐으니 이제는 softcap 이웃을 한 칸 더 보는 게 가장 자연스럽습니다. 이 문장은 worker raw reply라 그대로 보이면 안 됩니다.",
          finalMessagePath: "/tmp/raw-builder-output.txt",
          changedFiles: ["/tmp/exp.ts"],
          handoff: {
            summary: "softcap follow-up 후보를 하나로 줄였습니다.",
            runActions: ["softcap 32를 한 번 더 확인하세요."],
            openQuestions: []
          }
        }
      } as any
    });

    expect(prompt).toContain("Portfolio guidance: n7를 현재 gate로 유지하고 top1 local anchor 재현을 먼저 닫는 편이 맞습니다.");
    expect(prompt).toContain(
      "The current user request is already available in the thread context. Address it directly without restating it verbatim."
    );
    expect(prompt).toContain("Lead from the portfolio-level state, not the branch's play-by-play.");
    expect(prompt).not.toContain(originalPrompt);
    expect(prompt).not.toContain("n17이 실제로 승격됐으니");
    expect(prompt).not.toContain("/tmp/raw-builder-output.txt");
    expect(prompt).not.toContain("Changed files:");
    expect(prompt).not.toContain("Internal delegated reply");
  });

  it("orders research before execution in parallel followup prompts and omits raw worker replies", () => {
    const originalPrompt = "지금 뭐가 중요한지 위에서 정리해줘.";
    const prompt = buildOrchestratorParallelFollowupPrompt({
      originalPrompt,
      delegations: [
        { lane: "builder", prompt: "Run the next experiment." },
        { lane: "strategist", prompt: "Review the broader research direction." }
      ] as any,
      snapshot: {
        latestDecision: {
          summary: "공개 top1 local anchor를 먼저 닫아야 이후 점수 비교축이 맞습니다.",
          rationale: "지금은 experiment count보다 기준축 확정이 더 중요합니다.",
          rawOutput: "이 raw strategist 문단은 prompt에 그대로 들어가면 안 됩니다.",
          outputPath: "/tmp/raw-strategist-output.txt",
          handoff: {
            runActions: ["top1 local anchor run을 먼저 닫으세요."],
            openQuestions: []
          }
        },
        latestRun: {
          status: "completed",
          finalMessage: "builder raw reply도 여기에 그대로 보이면 안 됩니다.",
          finalMessagePath: "/tmp/raw-builder-output.txt",
          changedFiles: ["/tmp/exp.ts"],
          handoff: {
            summary: "실행 쪽 smoke는 이미 통과했습니다.",
            runActions: ["100-step baseline run을 마저 닫으세요."],
            openQuestions: []
          }
        }
      } as any
    });

    expect(prompt.indexOf("Research branch")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("Execution branch")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("Research branch")).toBeLessThan(prompt.indexOf("Execution branch"));
    expect(prompt).toContain(
      "The current user request is already available in the thread context. Address it directly without restating it verbatim."
    );
    expect(prompt).toContain("Prefer the research branch as the framing when it exists");
    expect(prompt).not.toContain(originalPrompt);
    expect(prompt).not.toContain("raw strategist 문단");
    expect(prompt).not.toContain("builder raw reply도");
    expect(prompt).not.toContain("/tmp/raw-strategist-output.txt");
    expect(prompt).not.toContain("/tmp/raw-builder-output.txt");
    expect(prompt).not.toContain("Internal delegated reply");
  });

  it("prefers strategist framing before execution in orchestrator snapshot summaries", () => {
    const summary = summarizeWorkerSnapshotsForConversation(
      [
        { lane: "builder", prompt: "Run the next experiment." },
        { lane: "strategist", prompt: "Review the broader research direction." }
      ] as any,
      {
        latestDecision: {
          summary: "비교 기준선을 먼저 닫는 게 지금 전체 우선순위입니다.",
          rationale: "새 실험보다 점수축 정리가 먼저입니다.",
          handoff: {
            runActions: ["top1 local anchor를 먼저 확정하세요."],
            openQuestions: []
          }
        },
        latestRun: {
          handoff: {
            summary: "baseline smoke는 이미 통과했습니다.",
            runActions: ["100-step baseline run을 마저 닫으세요."],
            openQuestions: []
          },
          finalMessage: ""
        }
      } as any
    );

    expect(summary).toContain("전체적으로는 비교 기준선을 먼저 닫는 게 지금 전체 우선순위입니다.");
    expect(summary).toContain("실행 쪽에서는 baseline smoke는 이미 통과했습니다.");
    expect(summary.indexOf("전체적으로는")).toBeLessThan(summary.indexOf("실행 쪽에서는"));
  });

  it("prefers strategist framing before execution in automation fallback summaries", () => {
    const summary = summarizeAutomationWorkerResultsForConversation([
      {
        lane: "builder",
        runSummary: "baseline smoke는 이미 통과했습니다.",
        runActions: ["100-step baseline run을 마저 닫으세요."]
      },
      {
        lane: "strategist",
        pending: false,
        decision: {
          summary: "비교 기준선을 먼저 닫는 게 지금 전체 우선순위입니다.",
          handoff: {
            summary: "비교 기준선을 먼저 닫는 게 지금 전체 우선순위입니다.",
            runActions: ["top1 local anchor를 먼저 확정하세요."],
            openQuestions: []
          }
        }
      }
    ] as any);

    expect(summary).toContain("전체적으로는 비교 기준선을 먼저 닫는 게 지금 전체 우선순위입니다.");
    expect(summary).toContain("실행 쪽에서는 baseline smoke는 이미 통과했습니다.");
    expect(summary.indexOf("전체적으로는")).toBeLessThan(summary.indexOf("실행 쪽에서는"));
  });

  it("refreshes strategist when the latest execution is newer than the latest strategic judgment", () => {
    expect(
      shouldRefreshAutomationStrategist({
        redirectInstruction: "",
        latestDecision: {
          createdAt: "2026-03-28T00:00:00.000Z"
        },
        latestRun: {
          createdAt: "2026-03-28T00:05:00.000Z",
          startedAt: "2026-03-28T00:05:00.000Z",
          endedAt: "2026-03-28T00:10:00.000Z",
          status: "completed"
        }
      } as any)
    ).toBe(true);

    expect(
      shouldRefreshAutomationStrategist({
        redirectInstruction: "",
        latestDecision: {
          createdAt: "2026-03-28T00:12:00.000Z"
        },
        latestRun: {
          createdAt: "2026-03-28T00:05:00.000Z",
          startedAt: "2026-03-28T00:05:00.000Z",
          endedAt: "2026-03-28T00:10:00.000Z",
          status: "completed"
        }
      } as any)
    ).toBe(false);
  });

  it("injects an async strategist delegation when planner only chose builder on stale strategy state", () => {
    const delegation = buildRequiredAutomationStrategistDelegation({
      existingDelegations: [{ lane: "builder", prompt: "Run the next bounded experiment." }] as any,
      hasAutomationDelegation: false,
      hasRunningBackgroundStrategist: false,
      session: {
        objective: "Keep researching and improving the parameter-golf baseline.",
        displayObjective: "Keep researching and improving the parameter-golf baseline."
      } as any,
      redirectInstruction: "",
      languagePreference: "en",
      snapshot: {
        latestDecision: {
          createdAt: "2026-03-28T00:00:00.000Z",
          summary: "n7를 gate로 두고 더 넓은 research scan은 후순위로 미뤄 둔 상태입니다."
        },
        latestRun: {
          createdAt: "2026-03-28T00:05:00.000Z",
          startedAt: "2026-03-28T00:05:00.000Z",
          endedAt: "2026-03-28T00:10:00.000Z",
          status: "completed",
          handoff: {
            summary: "n12 local run이 새 baseline으로 올라갔습니다."
          },
          finalMessage: ""
        },
        latestAutomationCheckpoint: null
      } as any
    });

    expect(delegation).toMatchObject({
      lane: "strategist",
      workerMode: "async",
      model: "gpt-5.4-pro",
      reasoningIntensity: "extended",
      attachExplicitWorkspaceFiles: false
    });
    expect(delegation?.prompt).toContain("Current user goal: Keep researching and improving the parameter-golf baseline.");
    expect(delegation?.prompt).toContain("Do not begin by repeating that wording verbatim.");
  });

  it("formats automation strategist prompts as labeled goals instead of raw user echoes", () => {
    const prompt = buildAutomationStrategistPrompt(
      {
        objective: "Keep researching and improving the parameter-golf baseline.",
        displayObjective: "Keep researching and improving the parameter-golf baseline."
      } as any,
      "",
      "auto",
      null,
      null,
      null
    );

    expect(prompt).toContain("Current user goal: Keep researching and improving the parameter-golf baseline.");
    expect(prompt).not.toMatch(/^Keep researching and improving the parameter-golf baseline\./);
    expect(prompt).toContain("Do not begin by repeating that wording verbatim.");
  });

  it("formats automation continuation advisor prompts as labeled goals instead of raw user echoes", () => {
    const prompt = buildAutomationContinuationAdvisorPrompt({
      session: {
        objective: "Research more diverse approaches and keep the strategist actively advising.",
        displayObjective: "Research more diverse approaches and keep the strategist actively advising."
      } as any,
      reason: "controller-failure",
      languagePreference: "auto",
      latestDecision: null,
      latestRun: null,
      latestCheckpoint: null,
      redirectInstruction: "",
      runSummary: "",
      runRisks: [],
      runActions: [],
      failureMessage: "controller issue"
    });

    expect(prompt).toContain(
      "Current user goal: Research more diverse approaches and keep the strategist actively advising."
    );
    expect(prompt).not.toMatch(
      /^Research more diverse approaches and keep the strategist actively advising\./
    );
    expect(prompt).toContain("Pro strategist perspective");
    expect(prompt).toContain("Do not begin by repeating that goal wording verbatim;");
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
