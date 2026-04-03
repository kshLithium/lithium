import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APP_SETTINGS,
  PROJECT_SCHEMA_VERSION,
  type ActiveWorkerProgressRecord,
  type AppSettings,
  type ResearchObjectiveRecord,
  type ResearchRunRecord,
  type WorkspaceSnapshot
} from "../shared/types";
import {
  LithiumCliController,
  resolveInitialWorkspacePath
} from "./repl";

function buildObjective(id = "RO001", title = "Main objective"): ResearchObjectiveRecord {
  return {
    id,
    threadId: id,
    title,
    objective: title,
    summary: title,
    status: "active",
    successCriteria: [],
    activeBranchId: "RB001",
    activeRunId: "RR001",
    sourceIds: [],
    branchIds: ["RB001"],
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z"
  };
}

function buildRun(status: ResearchRunRecord["status"] = "active"): ResearchRunRecord {
  return {
    id: "RR001",
    objectiveId: "RO001",
    threadId: "RO001",
    status,
    slotBudget: {
      codexSlots: 1,
      oracleSlots: 2,
      maxTotalWorkItems: 12,
      completedWorkItems: 0
    },
    activeWorkItemIds: [],
    oracleSessionSlugs: [],
    worktreeLeases: [],
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z"
  };
}

function buildSnapshot(input: {
  workspacePath?: string;
  objective?: ResearchObjectiveRecord | null;
  run?: ResearchRunRecord | null;
  activeWorkers?: ActiveWorkerProgressRecord[];
} = {}): WorkspaceSnapshot {
  const objective = input.objective ?? buildObjective();
  const run = input.run ?? buildRun();
  const workspacePath = input.workspacePath ?? "/tmp/demo";

  return {
    project: {
      id: "project-1",
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name: "demo",
      workspacePath,
      oracleModel: "gpt-5.4-pro",
      codexModel: "gpt-5.4",
      activeObjectiveId: objective?.id ?? undefined,
      defaultThreadId: "",
      activeThreadId: "",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:00:00.000Z"
    },
    activeObjectiveId: objective?.id ?? null,
    activeObjective: objective,
    objectives: objective ? [objective] : [],
    activeRun: run,
    runs: run ? [run] : [],
    branches: [],
    queue: [],
    recentFindings: [],
    latestEvaluation: null,
    latestProjection: objective
      ? {
          id: "RP001",
          threadId: objective.id,
          objectiveId: objective.id,
          objectiveTitle: objective.title,
          status: run?.status === "blocked" ? "blocked" : "running",
          summary: `${objective.title}: next bounded step`,
          currentFocus: "next bounded step",
          activeBranchTitle: "Primary branch",
          queueDepth: 0,
          topNextActions: [],
          recentEvidence: [],
          activeRunId: run?.id,
          activeRunStatus: run?.status,
          blockedReason: run?.blockedReason,
          createdAt: "2026-04-03T00:00:00.000Z",
          updatedAt: "2026-04-03T00:00:00.000Z",
          lastUpdatedAt: "2026-04-03T00:00:00.000Z"
        }
      : null,
    latestBuilderRun: null,
    attachments: [],
    activeWorkerProgress: input.activeWorkers ?? [],
    logs: []
  };
}

function createController(options: {
  initSnapshot?: WorkspaceSnapshot;
  getSnapshot?: WorkspaceSnapshot[];
  createObjectiveSnapshot?: WorkspaceSnapshot;
  selectObjectiveSnapshot?: WorkspaceSnapshot;
  runSnapshot?: WorkspaceSnapshot;
  importAttachmentsSnapshot?: WorkspaceSnapshot;
  settings?: AppSettings;
  cwd?: string;
}) {
  const output: string[] = [];
  const initSnapshot = options.initSnapshot ?? buildSnapshot();
  const getSnapshotSequence = [...(options.getSnapshot ?? [])];
  const settings = options.settings ?? DEFAULT_APP_SETTINGS;
  const settingsStore = {
    read: vi.fn().mockResolvedValue(settings),
    update: vi.fn().mockImplementation(async (update: Partial<AppSettings>) => ({
      ...settings,
      ...update
    }))
  };
  const service = {
    setSelectedWorkspacePath: vi.fn(),
    initWorkspace: vi.fn().mockResolvedValue(initSnapshot),
    getWorkspaceSnapshot: vi.fn().mockImplementation(async () => getSnapshotSequence.shift() ?? initSnapshot),
    createObjective: vi.fn().mockResolvedValue(options.createObjectiveSnapshot ?? initSnapshot),
    selectObjective: vi.fn().mockResolvedValue(options.selectObjectiveSnapshot ?? initSnapshot),
    listObjectives: vi.fn().mockResolvedValue(initSnapshot.objectives),
    startRun: vi.fn().mockResolvedValue(options.runSnapshot ?? initSnapshot),
    pauseRun: vi.fn().mockResolvedValue(options.runSnapshot ?? initSnapshot),
    resumeRun: vi.fn().mockResolvedValue(options.runSnapshot ?? initSnapshot),
    stopRun: vi.fn().mockResolvedValue(options.runSnapshot ?? initSnapshot),
    importAttachments: vi.fn().mockResolvedValue(options.importAttachmentsSnapshot ?? initSnapshot),
    prepareOracleSignIn: vi.fn().mockResolvedValue(undefined),
    getQueueView: vi.fn().mockResolvedValue([]),
    getEvidenceView: vi.fn().mockResolvedValue({
      findings: [],
      evaluation: null,
      projection: initSnapshot.latestProjection
    })
  };
  const controller = new LithiumCliController({
    service: service as any,
    settingsStore: settingsStore as any,
    writeLine: (line = "") => {
      output.push(line);
    },
    cwd: () => options.cwd ?? "/Users/test/current"
  });

  return {
    controller,
    output,
    service,
    settingsStore
  };
}

describe("CLI workspace resolution", () => {
  it("prefers an explicit workspace argument over saved workspace and cwd", () => {
    expect(
      resolveInitialWorkspacePath(["./workspace"], "/tmp/saved", "/tmp/current")
    ).toBe("/tmp/current/workspace");
  });

  it("falls back to the saved workspace before cwd", () => {
    expect(resolveInitialWorkspacePath([], "/tmp/saved", "/tmp/current")).toBe("/tmp/saved");
  });

  it("falls back to cwd when no workspace is provided", () => {
    expect(resolveInitialWorkspacePath([], "", "/tmp/current")).toBe("/tmp/current");
  });
});

describe("LithiumCliController", () => {
  it("updates the selected workspace and persisted setting through :workspace", async () => {
    const nextSnapshot = buildSnapshot({
      workspacePath: "/Users/test/next"
    });
    const { controller, service, settingsStore } = createController({
      initSnapshot: buildSnapshot({
        workspacePath: "/Users/test/start"
      })
    });

    await controller.initialize("/Users/test/start");
    service.initWorkspace.mockResolvedValueOnce(nextSnapshot);
    await controller.handleLine(":workspace ../next");

    expect(service.setSelectedWorkspacePath).toHaveBeenLastCalledWith("/Users/test/next");
    expect(settingsStore.update).toHaveBeenCalledWith({
      lastWorkspacePath: "/Users/test/next"
    });
  });

  it("creates and selects objectives via CLI commands", async () => {
    const createdSnapshot = buildSnapshot({
      objective: buildObjective("RO002", "Experiment objective"),
      run: null
    });
    const switchedSnapshot = buildSnapshot({
      objective: buildObjective("RO001", "Main objective"),
      run: null
    });
    const { controller, service } = createController({
      initSnapshot: buildSnapshot({
        objective: buildObjective("RO001", "Main objective"),
        run: null
      }),
      createObjectiveSnapshot: createdSnapshot,
      selectObjectiveSnapshot: switchedSnapshot
    });

    await controller.initialize("/tmp/demo");
    await controller.handleLine(":objective new Explore evaluation gap");
    await controller.handleLine(":objective use RO001");

    expect(service.createObjective).toHaveBeenCalledWith({
      workspacePath: "/tmp/demo",
      objective: "Explore evaluation gap"
    });
    expect(service.selectObjective).toHaveBeenCalledWith({
      workspacePath: "/tmp/demo",
      objectiveId: "RO001"
    });
  });

  it("runs autopilot lifecycle commands", async () => {
    const runSnapshot = buildSnapshot({
      run: buildRun("active")
    });
    const { controller, service } = createController({
      initSnapshot: buildSnapshot({
        run: null
      }),
      runSnapshot
    });

    await controller.initialize("/tmp/demo");
    await controller.handleLine(":run start");
    await controller.handleLine(":run pause");
    await controller.handleLine(":run resume");
    await controller.handleLine(":run stop");

    expect(service.startRun).toHaveBeenCalledWith({ workspacePath: "/tmp/demo" });
    expect(service.pauseRun).toHaveBeenCalledWith({ workspacePath: "/tmp/demo" });
    expect(service.resumeRun).toHaveBeenCalledWith({ workspacePath: "/tmp/demo" });
    expect(service.stopRun).toHaveBeenCalledWith({ workspacePath: "/tmp/demo" });
  });

  it("imports attachments into the active objective", async () => {
    const { controller, service } = createController({
      initSnapshot: buildSnapshot({
        workspacePath: "/tmp/demo"
      }),
      cwd: "/Users/test/current"
    });

    await controller.initialize("/tmp/demo");
    await controller.handleLine(':attach "notes one.md" ./data.csv');

    expect(service.importAttachments).toHaveBeenCalledWith({
      workspacePath: "/tmp/demo",
      objectiveId: "RO001",
      filePaths: ["/Users/test/current/notes one.md", "/Users/test/current/data.csv"]
    });
  });

  it("runs strategist sign-in and persists session readiness", async () => {
    const { controller, service, settingsStore } = createController({
      initSnapshot: buildSnapshot()
    });

    await controller.initialize("/tmp/demo");
    await controller.handleLine(":signin");

    expect(service.prepareOracleSignIn).toHaveBeenCalledTimes(1);
    expect(settingsStore.update).toHaveBeenCalledWith({
      strategistSessionReady: true
    });
  });

  it("rejects free-form chat in autopilot-only mode", async () => {
    const { controller, output } = createController({
      initSnapshot: buildSnapshot()
    });

    await controller.initialize("/tmp/demo");
    await controller.handleLine("hello there");

    expect(output.some((line) => line.includes("Free-form chat is disabled"))).toBe(true);
  });
});
