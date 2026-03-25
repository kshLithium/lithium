import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS, type AutomationCycleRecord, type AutomationSessionRecord, type AutomationStepRecord } from "../../shared/types";
import { AppService } from "./app-service";

describe("AppService automation loop", () => {
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
});
