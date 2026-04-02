import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AttachmentRecord,
  type ChatProgressInspection,
  type ConversationEntryRecord,
  type DecisionRecord,
  type ProjectSnapshot,
  type ProjectRecord,
  type ThreadRecord
} from "../shared/types";
import {
  LithiumCliController,
  resolveInitialWorkspacePath
} from "./repl";

function buildThread(id: string, title: string): ThreadRecord {
  return {
    id,
    title,
    summary: "",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z"
  };
}

function buildProject(workspacePath: string, activeThreadId: string): ProjectRecord {
  return {
    id: "project-1",
    name: "demo",
    workspacePath,
    oracleModel: "gpt-5.4-pro",
    codexModel: "gpt-5.4",
    defaultThreadId: activeThreadId,
    activeThreadId,
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z"
  };
}

function buildConversationEntry(
  id: string,
  threadId: string,
  role: ConversationEntryRecord["role"],
  body: string
): ConversationEntryRecord {
  return {
    id,
    threadId,
    role,
    source: role === "assistant" ? "orchestrator" : "user",
    body,
    createdAt: "2026-04-03T00:00:00.000Z"
  };
}

function buildSnapshot(input: {
  workspacePath?: string;
  threads?: ThreadRecord[];
  activeThreadId?: string | null;
  conversationEntries?: ConversationEntryRecord[];
  attachments?: AttachmentRecord[];
  latestDecision?: DecisionRecord | null;
} = {}): ProjectSnapshot {
  const threads = input.threads ?? [buildThread("TH001", "Main thread")];
  const activeThreadId = input.activeThreadId ?? threads[0]?.id ?? null;
  const workspacePath = input.workspacePath ?? "/tmp/demo";

  return {
    project: buildProject(workspacePath, activeThreadId ?? ""),
    memory: null,
    threads,
    activeThreadId,
    activeThread: threads.find((thread) => thread.id === activeThreadId) ?? null,
    conversationEntries: input.conversationEntries ?? [],
    latestConversationEntry: (input.conversationEntries ?? []).at(-1) ?? null,
    attachments: input.attachments ?? [],
    activeThreadAttachments: (input.attachments ?? []).filter((attachment) => attachment.threadId === activeThreadId),
    decisions: input.latestDecision ? [input.latestDecision] : [],
    tasks: [],
    runs: [],
    routerTraces: [],
    latestDecision: input.latestDecision ?? null,
    latestTask: null,
    latestRun: null,
    latestRouterTrace: null,
    automationSessions: [],
    automationCycles: [],
    automationSteps: [],
    automationCheckpoints: [],
    latestAutomationSession: null,
    latestAutomationCycle: null,
    latestAutomationCheckpoint: null,
    logs: []
  };
}

function createController(options: {
  initSnapshot?: ProjectSnapshot;
  getSnapshot?: ProjectSnapshot[];
  createThreadSnapshot?: ProjectSnapshot;
  selectThreadSnapshot?: ProjectSnapshot;
  importAttachmentsSnapshot?: ProjectSnapshot;
  sendChatSnapshot?: ProjectSnapshot;
  progress?: ChatProgressInspection | null;
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
    initProject: vi.fn().mockResolvedValue(initSnapshot),
    getSnapshot: vi.fn().mockImplementation(async () => getSnapshotSequence.shift() ?? initSnapshot),
    createThread: vi.fn().mockResolvedValue(options.createThreadSnapshot ?? initSnapshot),
    selectThread: vi.fn().mockResolvedValue(options.selectThreadSnapshot ?? initSnapshot),
    sendChatMessage: vi.fn().mockResolvedValue(options.sendChatSnapshot ?? initSnapshot),
    inspectChatProgress: vi.fn().mockResolvedValue(options.progress ?? null),
    importAttachments: vi.fn().mockResolvedValue(options.importAttachmentsSnapshot ?? initSnapshot),
    beginStrategistSignIn: vi.fn().mockResolvedValue(undefined)
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
    service.initProject.mockResolvedValueOnce(nextSnapshot);

    await controller.initialize("/Users/test/start");
    await controller.handleLine(":workspace ../next");

    expect(service.setSelectedWorkspacePath).toHaveBeenLastCalledWith("/Users/test/next");
    expect(settingsStore.update).toHaveBeenCalledWith({
      lastWorkspacePath: "/Users/test/next"
    });
  });

  it("creates and switches threads via CLI commands", async () => {
    const firstThread = buildThread("TH001", "Main thread");
    const secondThread = buildThread("TH002", "Experiment");
    const createdSnapshot = buildSnapshot({
      threads: [secondThread, firstThread],
      activeThreadId: secondThread.id
    });
    const switchedSnapshot = buildSnapshot({
      threads: [secondThread, firstThread],
      activeThreadId: firstThread.id
    });
    const { controller, service } = createController({
      initSnapshot: buildSnapshot({
        threads: [firstThread],
        activeThreadId: firstThread.id
      }),
      createThreadSnapshot: createdSnapshot,
      selectThreadSnapshot: switchedSnapshot
    });

    await controller.initialize("/tmp/demo");
    await controller.handleLine(":thread new Experiment");
    await controller.handleLine(":thread use 2");

    expect(service.createThread).toHaveBeenCalledWith({
      workspacePath: "/tmp/demo",
      title: "Experiment"
    });
    expect(service.selectThread).toHaveBeenCalledWith({
      workspacePath: "/tmp/demo",
      threadId: "TH001"
    });
  });

  it("imports attachments into the active thread", async () => {
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
      threadId: "TH001",
      filePaths: ["/Users/test/current/notes one.md", "/Users/test/current/data.csv"]
    });
  });

  it("runs strategist sign-in and persists session readiness", async () => {
    const { controller, service, settingsStore } = createController({
      initSnapshot: buildSnapshot()
    });

    await controller.initialize("/tmp/demo");
    await controller.handleLine(":signin");

    expect(service.beginStrategistSignIn).toHaveBeenCalledTimes(1);
    expect(settingsStore.update).toHaveBeenCalledWith({
      strategistSessionReady: true
    });
  });

  it("passes route override prompts through chat and marks strategist session ready after a decision", async () => {
    const sendChatSnapshot = buildSnapshot({
      latestDecision: {
        id: "D001",
        threadId: "TH001",
        prompt: "/research check this",
        rawOutput: "Research note",
        summary: "Research note",
        rationale: "Because",
        model: "gpt-5.4-pro",
        engine: "browser",
        status: "completed",
        command: {
          command: "oracle",
          args: [],
          cwd: "/tmp/demo"
        },
        stdoutPath: "/tmp/demo/stdout.log",
        stderrPath: "/tmp/demo/stderr.log",
        outputPath: "/tmp/demo/output.log",
        createdAt: "2026-04-03T00:00:00.000Z"
      }
    });
    const { controller, service, settingsStore } = createController({
      initSnapshot: buildSnapshot({
        workspacePath: "/tmp/demo"
      }),
      sendChatSnapshot,
      settings: {
        ...DEFAULT_APP_SETTINGS,
        strategistSessionReady: false
      }
    });

    await controller.initialize("/tmp/demo");
    await controller.handleLine("/research check this");
    await controller.handleLine("/build fix this");

    expect(service.sendChatMessage).toHaveBeenNthCalledWith(
      1,
      {
        workspacePath: "/tmp/demo",
        threadId: "TH001",
        prompt: "/research check this"
      },
      {
        strategistSessionReady: false
      }
    );
    expect(service.sendChatMessage).toHaveBeenNthCalledWith(
      2,
      {
        workspacePath: "/tmp/demo",
        threadId: "TH001",
        prompt: "/build fix this"
      },
      {
        strategistSessionReady: false
      }
    );
    expect(settingsStore.update).toHaveBeenCalledWith({
      strategistSessionReady: true
    });
  });

  it("prints live progress and new assistant entries without duplicating identical polls", async () => {
    const progress: ChatProgressInspection = {
      active: true,
      lane: "builder",
      threadId: "TH001",
      progressSummary: "Running builder",
      progressDetails: ["Inspecting workspace"],
      activeCommand: "codex exec",
      stdoutTail: "",
      stderrTail: "",
      updatedAt: "2026-04-03T00:00:00.000Z"
    };
    const snapshotWithReply = buildSnapshot({
      conversationEntries: [buildConversationEntry("C001", "TH001", "assistant", "Finished the task.")]
    });
    const { controller, output } = createController({
      initSnapshot: buildSnapshot({
        conversationEntries: []
      }),
      getSnapshot: [snapshotWithReply, snapshotWithReply],
      progress
    });

    await controller.initialize("/tmp/demo");
    await controller.pollOnce();
    await controller.pollOnce();

    expect(output.filter((line) => line.includes("[progress:builder] Running builder"))).toHaveLength(1);
    expect(output.filter((line) => line === "Assistant: Finished the task.")).toHaveLength(1);
  });
});
