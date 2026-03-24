import { describe, expect, it } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../shared/types";
import {
  buildCollapsedCodeFolderState,
  buildChatItems,
  buildOnboardingChecklist,
  expandCollapsedFolderAncestors,
  formatLiveProgressBody,
  formatDecisionBody,
  formatBuilderBody,
  handoffItems,
  mergeTransientChatItems,
  nextUntitledCodePath,
  normalizeNewCodeFilePath,
  resolveThemeMode,
  resolveWorkspaceSurfaceTitle,
  stripStrategistFooterForDisplay,
  suggestNewCodeFilePath,
  summarizeContextPack,
  toThreadMemoryDraft,
  untitledCodeLabel
} from "./app-utils";
import type { DecisionRecord, ProjectSnapshot, RouterTraceRecord, RunRecord } from "../shared/types";

describe("app utils", () => {
  it("maps thread memory into an editable draft", () => {
    expect(
      toThreadMemoryDraft({
        id: "TH001",
        title: "Alpha",
        summary: "Auto summary",
        memory: "Manual thread notes",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      })
    ).toEqual({
      memory: "Manual thread notes"
    });
  });

  it("suppresses stale live progress after a newer persisted reply has landed", () => {
    const items = mergeTransientChatItems(
      [
        {
          id: "assistant:done",
          role: "assistant",
          variant: "neutral",
          title: "Lithium",
          body: "최신 상태를 정리했습니다.",
          timestamp: "2026-03-25T10:00:10.000Z",
          order: 0
        }
      ],
      [],
      {
        chatProgress: {
          active: true,
          lane: "strategist",
          threadId: "TH001",
          progressSummary: "이전 preview",
          progressDetails: [],
          activeCommand: null,
          stdoutTail: "",
          stderrTail: "",
          updatedAt: "2026-03-25T10:00:05.000Z"
        }
      }
    );

    expect(items.map((item) => item.id)).toEqual(["assistant:done"]);
  });

  it("merges fresh live progress into the timeline with a stable id", () => {
    const items = mergeTransientChatItems(
      [
        {
          id: "user:1",
          role: "user",
          variant: "neutral",
          title: "You",
          body: "지금 뭐 하고 있어?",
          timestamp: "2026-03-25T10:00:00.000Z",
          order: 0
        }
      ],
      [],
      {
        workspacePath: "/tmp/workspace",
        activeThreadId: "TH001",
        chatProgress: {
          active: true,
          lane: "orchestrator",
          threadId: "TH001",
          progressSummary: "Thinking…",
          progressDetails: ["README와 notes를 먼저 읽고 핵심 목표를 다시 정리하는 중입니다."],
          activeCommand: "cat README.md",
          stdoutTail: "",
          stderrTail: "",
          updatedAt: "2026-03-25T10:00:03.000Z"
        }
      }
    );

    expect(items.at(-1)?.id).toBe("live-progress:TH001:orchestrator");
    expect(items.at(-1)?.body).toContain("README와 notes를 먼저 읽고 핵심 목표를 다시 정리하는 중입니다.");
    expect(items.at(-1)?.body).toContain("Command: `cat README.md`");
  });

  it("keeps the busy pending card id stable across rerenders", () => {
    const pendingItems = [
      {
        id: "user:pending",
        role: "user" as const,
        variant: "neutral" as const,
        title: "You",
        body: "parameter golf 프로젝트에 대해서 리서치를 진행해줘",
        timestamp: "2026-03-25T11:00:00.000Z",
        order: 0,
        pending: true
      }
    ];
    const progress = {
      active: true,
      lane: "strategist" as const,
      threadId: "TH001",
      progressSummary: "이제 리스크 쪽을 확인하고 있습니다.",
      progressDetails: [],
      activeCommand: null,
      stdoutTail: "",
      stderrTail: "",
      updatedAt: "2026-03-25T11:00:03.000Z"
    };

    const first = mergeTransientChatItems([], pendingItems, {
      busyAction: "Researching",
      busyBody: "이제 리스크 쪽을 확인하고 있습니다.",
      chatProgress: progress,
      activeThreadId: "TH001"
    });
    const second = mergeTransientChatItems([], pendingItems, {
      busyAction: "Researching",
      busyBody: "이제 리스크 쪽을 확인하고 있습니다.",
      chatProgress: {
        ...progress,
        updatedAt: "2026-03-25T11:00:05.000Z"
      },
      activeThreadId: "TH001"
    });

    expect(first.at(-1)?.id).toBe("busy:TH001:Researching");
    expect(second.at(-1)?.id).toBe("busy:TH001:Researching");
  });

  it("formats live progress in chronological order with the latest summary last", () => {
    expect(
      formatLiveProgressBody({
        progressSummary: "마지막으로 공식 저장소 해석을 정리하고 있습니다.",
        progressDetails: [
          "README와 최근 로그를 먼저 대조했습니다.",
          "핵심 리스크와 바로 작업축으로 삼을 부분을 분리했습니다."
        ],
        activeCommand: null
      })
    ).toBe(
      [
        "README와 최근 로그를 먼저 대조했습니다.",
        "핵심 리스크와 바로 작업축으로 삼을 부분을 분리했습니다.",
        "마지막으로 공식 저장소 해석을 정리하고 있습니다."
      ].join("\n\n")
    );
  });

  it("summarizes long context packs without dropping the head", () => {
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");

    expect(summarizeContextPack(content, 4)).toBe([
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "… 26 more lines"
    ].join("\n"));
  });

  it("groups only the populated handoff arrays", () => {
    expect(
      handoffItems({
        schemaVersion: "lithium_handoff_v1",
        role: "builder",
        summary: "Implemented the baseline.",
        result: "success",
        files: ["experiments/run.py"],
        risks: [],
        paperActions: ["Update results section"],
        runActions: [],
        successCriteria: ["Tests pass"],
        openQuestions: []
      })
    ).toEqual([
      { label: "Files", values: ["experiments/run.py"] },
      { label: "Paper", values: ["Update results section"] },
      { label: "Success", values: ["Tests pass"] }
    ]);
  });

  it("allocates untitled editor labels predictably", () => {
    const nextPath = nextUntitledCodePath(["/tmp/workspace/experiments/run.py", "untitled:1", "untitled:2"]);

    expect(nextPath).toBe("untitled:3");
    expect(untitledCodeLabel(nextPath)).toBe("Untitled-3");
  });

  it("normalizes prompted code paths and blocks workspace escapes", () => {
    expect(normalizeNewCodeFilePath(" ./experiments/baseline.py ")).toBe("experiments/baseline.py");
    expect(normalizeNewCodeFilePath("../outside.py")).toBe("");
    expect(normalizeNewCodeFilePath("/tmp/outside.py")).toBe("");
  });

  it("suggests a python file inside the preferred code root", () => {
    expect(
      suggestNewCodeFilePath([
        {
          path: "/tmp/workspace/experiments/run.py",
          relativePath: "experiments/run.py",
          name: "run.py",
          kind: "code"
        },
        {
          path: "/tmp/workspace/src/model.py",
          relativePath: "src/model.py",
          name: "model.py",
          kind: "code"
        }
      ])
    ).toBe("experiments/untitled.py");
  });

  it("prefers persisted conversation entries over reconstructing chat from runs and decisions", () => {
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "Lithium",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/paper/main.tex",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Summary",
          createdAt: "2026-03-24T00:00:00.000Z",
          updatedAt: "2026-03-24T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Summary",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z"
      },
      conversationEntries: [
        {
          id: "M001",
          threadId: "TH001",
          role: "user",
          source: "user",
          body: "이어서 정리해줘",
          createdAt: "2026-03-24T00:00:01.000Z"
        },
        {
          id: "M002",
          threadId: "TH001",
          role: "assistant",
          source: "orchestrator",
          body: "아직 baseline 개선은 확정되지 않았습니다.",
          createdAt: "2026-03-24T00:00:02.000Z"
        }
      ],
      latestConversationEntry: {
        id: "M002",
        threadId: "TH001",
        role: "assistant",
        source: "orchestrator",
        body: "아직 baseline 개선은 확정되지 않았습니다.",
        createdAt: "2026-03-24T00:00:02.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [
        {
          id: "D001",
          threadId: "TH001",
          prompt: "legacy strategist prompt",
          rawOutput: "Legacy strategist output",
          summary: "Legacy strategist summary",
          rationale: "Legacy rationale",
          model: "gpt-5.4",
          engine: "browser",
          status: "completed",
          command: { command: "npx", args: ["oracle"], cwd: "/tmp/workspace" },
          stdoutPath: "",
          stderrPath: "",
          outputPath: "",
          createdAt: "2026-03-24T00:00:03.000Z"
        }
      ],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [],
      automationSteps: [],
      automationCheckpoints: [],
      latestAutomationSession: null,
      latestAutomationCheckpoint: null,
      logs: []
    };

    expect(buildChatItems(snapshot, []).map((item) => item.body)).toEqual([
      "이어서 정리해줘",
      "아직 baseline 개선은 확정되지 않았습니다."
    ]);
  });

  it("suppresses a raw checkpoint card when the same pause was already written as a conversation entry", () => {
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "Lithium",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/paper/main.tex",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Summary",
          createdAt: "2026-03-24T00:00:00.000Z",
          updatedAt: "2026-03-24T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Summary",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z"
      },
      conversationEntries: [
        {
          id: "M100",
          threadId: "TH001",
          role: "system",
          source: "checkpoint",
          body: "한 단계가 끝났고 지금은 여기서 잠시 멈춰 있습니다.",
          createdAt: "2026-03-24T00:00:10.000Z",
          automationSessionId: "AU001",
          automationCheckpointId: "AC001"
        }
      ],
      latestConversationEntry: {
        id: "M100",
        threadId: "TH001",
        role: "system",
        source: "checkpoint",
        body: "한 단계가 끝났고 지금은 여기서 잠시 멈춰 있습니다.",
        createdAt: "2026-03-24T00:00:10.000Z",
        automationSessionId: "AU001",
        automationCheckpointId: "AC001"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [
        {
          id: "AU001",
          threadId: "TH001",
          objective: "자동 연구",
          displayObjective: "자동 연구",
          mode: "continuous",
          status: "idle",
          allowedActions: ["strategize", "experiment-run", "checkpoint"],
          paperWriteEnabled: false,
          evidenceMode: "strict",
          budget: {
            maxSteps: 8,
            maxRuntimeMinutes: 60,
            maxRetries: 2,
            usedSteps: 1,
            usedRetries: 0
          },
          latestCheckpointId: "AC001",
          currentStepSummary: "Waiting for your direction.",
          createdAt: "2026-03-24T00:00:00.000Z",
          updatedAt: "2026-03-24T00:00:10.000Z"
        }
      ],
      automationSteps: [],
      automationCheckpoints: [
        {
          id: "AC001",
          sessionId: "AU001",
          threadId: "TH001",
          status: "pending",
          title: "Checkpoint ready",
          summary: "tiny exact가 조금 앞섰습니다.",
          whatChanged: [],
          evidence: [],
          risks: [],
          nextActions: ["full-prefix stronger proxy로 확인"],
          createdAt: "2026-03-24T00:00:09.000Z",
          updatedAt: "2026-03-24T00:00:10.000Z"
        }
      ],
      latestAutomationSession: {
        id: "AU001",
        threadId: "TH001",
        objective: "자동 연구",
        displayObjective: "자동 연구",
        mode: "continuous",
        status: "idle",
        allowedActions: ["strategize", "experiment-run", "checkpoint"],
        paperWriteEnabled: false,
        evidenceMode: "strict",
        budget: {
          maxSteps: 8,
          maxRuntimeMinutes: 60,
          maxRetries: 2,
          usedSteps: 1,
          usedRetries: 0
        },
        latestCheckpointId: "AC001",
        currentStepSummary: "Waiting for your direction.",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:10.000Z"
      },
      latestAutomationCheckpoint: {
        id: "AC001",
        sessionId: "AU001",
        threadId: "TH001",
        status: "pending",
        title: "Checkpoint ready",
        summary: "tiny exact가 조금 앞섰습니다.",
        whatChanged: [],
        evidence: [],
        risks: [],
        nextActions: ["full-prefix stronger proxy로 확인"],
        createdAt: "2026-03-24T00:00:09.000Z",
        updatedAt: "2026-03-24T00:00:10.000Z"
      },
      logs: []
    };

    const items = buildChatItems(snapshot, []);

    expect(items.map((item) => item.body)).toEqual(["한 단계가 끝났고 지금은 여기서 잠시 멈춰 있습니다."]);
  });

  it("renders unified assistant labels and the running-state copy", () => {
    const decision: DecisionRecord = {
      id: "D001",
      threadId: "TH001",
      prompt: "The user greeted you in Korean. Reply briefly in Korean.",
      displayPrompt: "안녕?",
      rawOutput: "SUMMARY: next step\nNEXT_TASK: Keep moving.",
      summary: "Next step",
      nextTask: "Keep moving.",
      rationale: "A concise decision.",
      model: "gpt-5.4",
      engine: "browser",
      status: "completed",
      command: { command: "npx", args: ["oracle"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/decisions/D001.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/decisions/D001.stderr.log",
      outputPath: "/tmp/workspace/.lithium/decisions/D001.output.txt",
      createdAt: "2026-03-19T00:00:00.000Z"
    };
    const run: RunRecord = {
      id: "R001",
      threadId: "TH001",
      taskId: "T001",
      prompt: "Implement the next step.",
      model: "gpt-5.4",
      status: "running",
      exitCode: null,
      pid: 1234,
      command: { command: "codex", args: ["exec"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/runs/R001.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/runs/R001.stderr.log",
      finalMessagePath: "/tmp/workspace/.lithium/runs/R001.output.txt",
      finalMessage: "",
      changedFiles: [],
      finalization: null,
      createdAt: "2026-03-19T00:01:00.000Z",
      startedAt: "2026-03-19T00:01:00.000Z",
      endedAt: "2026-03-19T00:01:00.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [decision],
      tasks: [],
      runs: [run],
      routerTraces: [],
      latestDecision: decision,
      latestTask: null,
      latestRun: run,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");
    expect(items.map((item) => item.title)).toEqual(["You", "Lithium", "You", "Lithium"]);
    expect(items[0]?.body).toBe("안녕?");
    expect(items[1]?.body).toBe("Next step");
    expect(items[3]?.body).toBe("Lithium is still working on this task.");
    expect(
      formatBuilderBody({
        ...run,
        status: "completed",
        finalMessage: [
          "Applied the manuscript fix.",
          "",
          "LITHIUM_STATUS",
          "SUMMARY: manuscript sync complete",
          "FILES: paper/main.tex",
          "RESULT: success"
        ].join("\n"),
        exitCode: 0,
        pid: null,
        changedFiles: ["paper/main.tex"],
        finalization: "auto"
      })
    ).toBe("Applied the manuscript fix.");
    expect(
      formatBuilderBody({
        ...run,
        status: "cancelled",
        finalMessage: [
          '{"type":"thread.started","thread_id":"abc"}',
          '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Checking the repo layout first."}}',
          '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc \\"pwd\\"","status":"in_progress"}}'
        ].join(" "),
        exitCode: 1,
        pid: null,
        finalization: "terminated"
      })
    ).toBe("Stopped after finishing the current step.");
  });

  it("surfaces live codex progress inside running builder chat messages", () => {
    const run: RunRecord = {
      id: "R002",
      threadId: "TH001",
      taskId: "T002",
      prompt: "Inspect the repository",
      model: "gpt-5.4",
      status: "running",
      exitCode: null,
      pid: 42,
      command: { command: "codex", args: ["exec"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/runs/R002.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/runs/R002.stderr.log",
      finalMessagePath: "/tmp/workspace/.lithium/runs/R002.output.txt",
      finalMessage: "",
      changedFiles: [],
      finalization: null,
      createdAt: "2026-03-19T00:03:00.000Z",
      startedAt: "2026-03-19T00:03:00.000Z",
      endedAt: "2026-03-19T00:03:00.000Z"
    };

    expect(
      formatBuilderBody(run, {
        progressSummary: "I’m checking the repo structure and reading the main docs.",
        progressDetails: ["The routing path is concrete enough that I’m reading the main chat handler."],
        activeCommand: "sed -n '1,260p' README.md"
      })
    ).toBe([
      "The routing path is concrete enough that I’m reading the main chat handler.",
      "",
      "I’m checking the repo structure and reading the main docs."
    ].join("\n"));
  });

  it("keeps internal automation step prompts out of the visible chat timeline", () => {
    const repeatedPrompt =
      "다음 step부터는 github records 상위 접근법들을 3~5개 baseline family로 먼저 묶어라.";
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [
        {
          id: "AU001",
          threadId: "TH001",
          objective: "parameter-golf를 연구해줘",
          mode: "continuous",
          status: "running",
          allowedActions: ["strategize", "code-edit", "checkpoint"],
          paperWriteEnabled: false,
          evidenceMode: "strict",
          budget: {
            maxSteps: 64,
            maxRuntimeMinutes: 1440,
            maxRetries: 8,
            usedSteps: 3,
            usedRetries: 0
          },
          latestCheckpointId: undefined,
          latestStepId: "AS003",
          currentStepSummary: "다음 실험을 고르고 있습니다.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:05:00.000Z"
        }
      ],
      automationSteps: [
        {
          id: "AS001",
          sessionId: "AU001",
          threadId: "TH001",
          kind: "code-edit",
          lane: "builder",
          title: "Let Codex choose and execute the next bounded step",
          prompt: repeatedPrompt,
          status: "completed",
          decisionId: undefined,
          runId: undefined,
          summary: "첫 baseline을 정리했습니다.",
          changedFiles: [],
          evidence: [],
          checkpointRequired: false,
          createdAt: "2026-03-19T00:01:00.000Z",
          updatedAt: "2026-03-19T00:02:00.000Z",
          completedAt: "2026-03-19T00:02:00.000Z"
        },
        {
          id: "AS002",
          sessionId: "AU001",
          threadId: "TH001",
          kind: "code-edit",
          lane: "builder",
          title: "Let Codex choose and execute the next bounded step",
          prompt: repeatedPrompt,
          status: "completed",
          decisionId: undefined,
          runId: undefined,
          summary: "두 번째 baseline을 정리했습니다.",
          changedFiles: [],
          evidence: [],
          checkpointRequired: false,
          createdAt: "2026-03-19T00:03:00.000Z",
          updatedAt: "2026-03-19T00:04:00.000Z",
          completedAt: "2026-03-19T00:04:00.000Z"
        }
      ],
      automationCheckpoints: [],
      latestAutomationSession: null,
      latestAutomationCheckpoint: null,
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");
    expect(items.filter((item) => item.role === "user").map((item) => item.body)).toEqual(["parameter-golf를 연구해줘"]);
    expect(items.filter((item) => item.role === "assistant").map((item) => item.body)).toEqual([
      "첫 baseline을 정리했습니다.",
      "두 번째 baseline을 정리했습니다."
    ]);
  });

  it("hides internal restart notices from autopilot builder summaries", () => {
    const run: RunRecord = {
      id: "R002",
      threadId: "TH001",
      taskId: "T002",
      prompt: "[autopilot] continue",
      displayPrompt: "[autopilot] continue",
      model: "gpt-5.4",
      status: "failed",
      exitCode: 1,
      pid: null,
      command: { command: "codex", args: ["exec"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/runs/R002.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/runs/R002.stderr.log",
      finalMessagePath: "/tmp/workspace/.lithium/runs/R002.output.txt",
      finalMessage: "",
      changedFiles: [],
      handoff: {
        schemaVersion: "lithium_handoff_v1",
        role: "builder",
        summary: "Automation stopped when Lithium restarted during builder step.",
        files: [],
        risks: [],
        paperActions: [],
        runActions: [],
        successCriteria: [],
        openQuestions: []
      },
      finalization: "auto",
      createdAt: "2026-03-19T00:03:00.000Z",
      startedAt: "2026-03-19T00:03:00.000Z",
      endedAt: "2026-03-19T00:05:00.000Z"
    };

    expect(formatBuilderBody(run)).toBe(
      "직전 단계가 깔끔하게 끝나지 않았습니다. 자동으로 다음 복구 경로를 정리하고 있습니다."
    );
  });

  it("prefers the builder's natural reply body over the compact autopilot summary", () => {
    const run: RunRecord = {
      id: "R003",
      threadId: "TH001",
      taskId: "T003",
      prompt: "[autopilot] continue",
      displayPrompt: "[autopilot] continue",
      model: "gpt-5.4",
      status: "completed",
      exitCode: 0,
      pid: null,
      command: { command: "codex", args: ["exec"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/runs/R003.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/runs/R003.stderr.log",
      finalMessagePath: "/tmp/workspace/.lithium/runs/R003.output.txt",
      finalMessage: [
        "지금은 full-prefix 256/256 쪽으로 정상 진행 중입니다. 끝나면 기존 proxy 결과와 바로 수치 비교가 가능합니다.",
        "",
        "LITHIUM_STATUS",
        '{"summary":"Executed a true full MLX eval for the current budget-safe champion.","result":"success"}'
      ].join("\n"),
      changedFiles: [],
      handoff: {
        schemaVersion: "lithium_handoff_v1",
        role: "builder",
        summary: "Executed a true full MLX eval for the current budget-safe champion.",
        result: "success",
        files: [],
        risks: [],
        paperActions: [],
        runActions: [],
        successCriteria: [],
        openQuestions: []
      },
      finalization: "auto",
      createdAt: "2026-03-19T00:03:00.000Z",
      startedAt: "2026-03-19T00:03:00.000Z",
      endedAt: "2026-03-19T00:05:00.000Z"
    };

    expect(formatBuilderBody(run)).toBe(
      "지금은 full-prefix 256/256 쪽으로 정상 진행 중입니다. 끝나면 기존 proxy 결과와 바로 수치 비교가 가능합니다."
    );
  });

  it("prefers the handoff user message over an internal builder summary", () => {
    const run: RunRecord = {
      id: "R003A",
      threadId: "TH001",
      taskId: "T003A",
      prompt: "[autopilot] continue",
      displayPrompt: "[autopilot] continue",
      model: "gpt-5.4",
      status: "completed",
      exitCode: 0,
      pid: null,
      command: { command: "codex", args: ["exec"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/runs/R003A.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/runs/R003A.stderr.log",
      finalMessagePath: "/tmp/workspace/.lithium/runs/R003A.output.txt",
      finalMessage: [
        "LITHIUM_STATUS",
        JSON.stringify({
          user_message: "평가를 다시 걸어서 비교 수치를 확인하겠습니다.",
          machine_summary: "detached builder cleanup summary",
          result: "partial"
        })
      ].join("\n"),
      changedFiles: [],
      handoff: {
        schemaVersion: "lithium_handoff_v1",
        role: "builder",
        summary: "detached builder cleanup summary",
        machineSummary: "detached builder cleanup summary",
        userMessage: "평가를 다시 걸어서 비교 수치를 확인하겠습니다.",
        result: "partial",
        files: [],
        risks: [],
        paperActions: [],
        runActions: [],
        successCriteria: [],
        openQuestions: []
      },
      finalization: "auto",
      createdAt: "2026-03-19T00:03:00.000Z",
      startedAt: "2026-03-19T00:03:00.000Z",
      endedAt: "2026-03-19T00:05:00.000Z"
    };

    expect(formatBuilderBody(run)).toBe("평가를 다시 걸어서 비교 수치를 확인하겠습니다.");
  });

  it("starts code explorer folders collapsed and expands the selected file ancestors", () => {
    const files = [
      {
        path: "/tmp/workspace/src/main/index.ts",
        relativePath: "src/main/index.ts",
        name: "index.ts",
        kind: "code"
      },
      {
        path: "/tmp/workspace/src/renderer/App.tsx",
        relativePath: "src/renderer/App.tsx",
        name: "App.tsx",
        kind: "code"
      },
      {
        path: "/tmp/workspace/README.md",
        relativePath: "README.md",
        name: "README.md",
        kind: "code"
      }
    ] as const;

    expect(buildCollapsedCodeFolderState([...files])).toEqual({
      src: true,
      "src/main": true,
      "src/renderer": true
    });

    expect(
      expandCollapsedFolderAncestors(
        {
          src: true,
          "src/main": true,
          "src/renderer": true
        },
        "src/main/index.ts"
      )
    ).toEqual({
      src: false,
      "src/main": false,
      "src/renderer": true
    });
  });

  it("does not surface local paper compile runs as chat messages", () => {
    const compileRun: RunRecord = {
      id: "R010",
      threadId: "TH001",
      taskId: "T010",
      prompt: "Compile paper/main.tex with tectonic.",
      model: "tectonic",
      status: "completed",
      exitCode: 0,
      pid: null,
      command: { command: "tectonic", args: ["-X", "compile", "--synctex", "paper/main.tex"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/runs/R010.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/runs/R010.stderr.log",
      finalMessagePath: "/tmp/workspace/.lithium/runs/R010.output.txt",
      finalMessage: "Compiled paper/main.tex.",
      changedFiles: ["paper/main.pdf"],
      finalization: "auto",
      createdAt: "2026-03-19T00:02:00.000Z",
      startedAt: "2026-03-19T00:02:00.000Z",
      endedAt: "2026-03-19T00:02:01.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [compileRun],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      logs: []
    };

    expect(buildChatItems(snapshot, [], "/tmp/workspace")).toEqual([]);
  });

  it("keeps router traces out of the visible chat feed", () => {
    const decision: DecisionRecord = {
      id: "D010",
      threadId: "TH001",
      prompt: "Compare two baselines and decide what to try next.",
      displayPrompt: "오버워치 2 캐릭터에 대해서 리서치좀 해줘",
      rawOutput: "SUMMARY: Research summary\nNEXT_TASK: Suggest a concise reply.",
      summary: "Research summary",
      nextTask: "Suggest a concise reply.",
      rationale: "Need strategic analysis first.",
      model: "gpt-5.4-pro",
      engine: "browser",
      status: "completed",
      command: { command: "npx", args: ["oracle"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/decisions/D010.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/decisions/D010.stderr.log",
      outputPath: "/tmp/workspace/.lithium/decisions/D010.output.txt",
      createdAt: "2026-03-19T00:00:00.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [decision],
      tasks: [],
      runs: [],
      routerTraces: [
        {
          id: "Q001",
          threadId: "TH001",
          prompt: "오버워치 2 캐릭터에 대해서 리서치좀 해줘",
          normalizedPrompt: "오버워치 2 캐릭터에 대해서 리서치좀 해줘",
          rewrittenPrompt: "Research Overwatch 2 characters and reply with a concise summary.",
          requestedRoute: null,
          route: "strategist",
          finalRoute: "strategist",
          reasonShort: "The user asked for research, not workspace edits.",
          rawOutput: "",
          command: {
            command: "codex",
            args: ["exec", "-c", 'model_reasoning_effort="xhigh"', "--model", "gpt-5.4"],
            cwd: "/tmp/workspace"
          },
          stdoutPath: "/tmp/workspace/.lithium/routes/Q001.stdout.log",
          stderrPath: "/tmp/workspace/.lithium/routes/Q001.stderr.log",
          outputPath: "/tmp/workspace/.lithium/routes/Q001.output.txt",
          downstreamDecisionId: "D010",
          createdAt: "2026-03-19T00:00:00.000Z",
          decidedAt: "2026-03-19T00:00:01.000Z",
          completedAt: "2026-03-19T00:00:01.000Z"
        }
      ],
      latestDecision: decision,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");

    expect(items.map((item) => item.title)).toEqual(["You", "Lithium"]);
    expect(items[1]?.body).toBe("Research summary");
  });

  it("hides an automation builder prompt when it is marked as an autopilot step", () => {
    const decision: DecisionRecord = {
      id: "D020",
      threadId: "TH001",
      prompt: "새로운 svm 알고리즘을 연구해줘",
      displayPrompt: "새로운 svm 알고리즘을 연구해줘",
      rawOutput: "연구 방향을 먼저 정리하겠습니다.",
      summary: "연구 방향을 먼저 정리하겠습니다.",
      nextTask: "",
      rationale: "Need strategic analysis first.",
      model: "gpt-5.4-pro",
      engine: "browser",
      status: "completed",
      command: { command: "npx", args: ["oracle"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/decisions/D020.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/decisions/D020.stderr.log",
      outputPath: "/tmp/workspace/.lithium/decisions/D020.output.txt",
      createdAt: "2026-03-19T00:00:00.000Z"
    };
    const run: RunRecord = {
      id: "R020",
      threadId: "TH001",
      taskId: "T020",
      prompt: "Codex decides the next step from the strategist context.",
      displayPrompt: "[autopilot] 새로운 svm 알고리즘을 연구해줘",
      model: "gpt-5.4",
      status: "running",
      exitCode: null,
      pid: 99,
      command: { command: "codex", args: ["exec"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/runs/R020.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/runs/R020.stderr.log",
      finalMessagePath: "/tmp/workspace/.lithium/runs/R020.output.txt",
      finalMessage: "",
      changedFiles: [],
      finalization: null,
      createdAt: "2026-03-19T00:00:10.000Z",
      startedAt: "2026-03-19T00:00:10.000Z",
      endedAt: "2026-03-19T00:00:10.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [decision],
      tasks: [],
      runs: [run],
      routerTraces: [],
      latestDecision: decision,
      latestTask: null,
      latestRun: run,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");

    expect(items.map((item) => item.title)).toEqual(["You", "Lithium", "Lithium"]);
    expect(items[0]?.body).toBe("새로운 svm 알고리즘을 연구해줘");
    expect(items[2]?.body).toBe("Lithium is still working on this task.");
  });

  it("falls back to the strategist summary when no natural reply body was captured", () => {
    expect(
      formatDecisionBody(
        "안녕하세요! 무엇을 도와드릴까요?",
        "Planner rationale."
      )
    ).toBe("안녕하세요! 무엇을 도와드릴까요?");
  });

  it("prefers the strategist's natural reply body when raw output includes one", () => {
    expect(
      formatDecisionBody(
        "짧은 요약",
        "Planner rationale.",
        [
          "현재 기준으로는 실험을 바로 늘리기보다, 베이스라인 오차부터 먼저 정리하는 편이 좋습니다.",
          "",
          "그 다음에 변수를 하나씩 늘려야 결과 해석이 덜 흔들립니다.",
          "",
          "LITHIUM_HANDOFF",
          JSON.stringify({
            summary: "베이스라인부터 정리하는 편이 좋다.",
            next_task: "Audit the baseline errors."
          })
        ].join("\n")
      )
    ).toContain("베이스라인 오차부터 먼저 정리");
  });

  it("preserves strategist citations as clickable inline markdown links", () => {
    expect(
      formatDecisionBody(
        "공식 영웅 페이지 기준으로 현재 로스터는 50명이다. ([Overwatch][1])\n\n[1]: https://example.com",
        ""
      )
    ).toBe("공식 영웅 페이지 기준으로 현재 로스터는 50명이다. ([Overwatch](https://example.com))");
  });

  it("surfaces strategist input files in chat and removes dangling standalone closing fragments", () => {
    expect(
      formatDecisionBody(
        "짧은 요약",
        "",
        [
          "지금 기준으로는 아직 baseline 우위가 확정된 상태는 아닙니다.",
          "",
          "입니다.",
          "",
          "LITHIUM_HANDOFF",
          JSON.stringify({
            summary: "baseline 우위는 아직 확정되지 않았다."
          })
        ].join("\n"),
        false,
        undefined,
        [
          "/tmp/workspace/.lithium/context/D016.strategist.runtime.md",
          "/tmp/workspace/official/README.md"
        ],
        "/tmp/workspace"
      )
    ).toBe(
      [
        "참고한 파일: [.lithium/context/D016.strategist.runtime.md](/tmp/workspace/.lithium/context/D016.strategist.runtime.md), [official/README.md](/tmp/workspace/official/README.md)",
        "",
        "지금 기준으로는 아직 baseline 우위가 확정된 상태는 아닙니다."
      ].join("\n")
    );
  });

  it("strips the strategist handoff footer before rendering the chat reply", () => {
    expect(
      stripStrategistFooterForDisplay(
        [
          "Natural reply.",
          "",
          "LITHIUM_HANDOFF",
          '{"summary":"short"}'
        ].join("\n")
      )
    ).toBe("Natural reply.");
  });

  it("hides router traces and mixed internal follow-up prompts from the visible chat", () => {
    const decision: DecisionRecord = {
      id: "D010",
      threadId: "TH001",
      prompt: "Strategist internal prompt",
      displayPrompt: "오버워치 2 캐릭터 조사해줘",
      rawOutput: "LITHIUM_HANDOFF",
      summary: "Hero survey complete.",
      nextTask: "Write the hero summary to notes.md",
      rationale: "Need both research and a saved artifact.",
      model: "gpt-5.4-pro",
      engine: "browser",
      status: "completed",
      command: { command: "npx", args: ["oracle"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/decisions/D010.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/decisions/D010.stderr.log",
      outputPath: "/tmp/workspace/.lithium/decisions/D010.output.txt",
      createdAt: "2026-03-19T00:00:00.000Z"
    };
    const run: RunRecord = {
      id: "R010",
      threadId: "TH001",
      taskId: "T010",
      prompt: "Write the hero summary to notes.md",
      model: "gpt-5.4",
      status: "completed",
      exitCode: 0,
      pid: null,
      command: { command: "codex", args: ["exec"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/runs/R010.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/runs/R010.stderr.log",
      finalMessagePath: "/tmp/workspace/.lithium/runs/R010.output.txt",
      finalMessage: "Saved the hero summary.",
      changedFiles: ["notes.md"],
      finalization: "auto",
      createdAt: "2026-03-19T00:01:00.000Z",
      startedAt: "2026-03-19T00:01:00.000Z",
      endedAt: "2026-03-19T00:01:30.000Z"
    };
    const trace: RouterTraceRecord = {
      id: "Q010",
      threadId: "TH001",
      prompt: "오버워치 2 캐릭터 조사해줘",
      normalizedPrompt: "오버워치 2 캐릭터 조사해줘",
      rewrittenPrompt: "Research the key Overwatch 2 heroes and produce one concrete next task.",
      requestedRoute: null,
      route: "mixed",
      finalRoute: "mixed",
      reasonShort: "The user wants research first and then a concrete workspace artifact.",
      rawOutput: "LITHIUM_ROUTE",
      command: { command: "codex", args: ["exec"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/routes/Q010.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/routes/Q010.stderr.log",
      outputPath: "/tmp/workspace/.lithium/routes/Q010.output.txt",
      downstreamDecisionId: "D010",
      downstreamRunId: "R010",
      downstreamTaskId: "T010",
      createdAt: "2026-03-19T00:00:00.000Z",
      decidedAt: "2026-03-19T00:00:02.000Z",
      completedAt: "2026-03-19T00:01:31.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [decision],
      tasks: [],
      runs: [run],
      routerTraces: [trace],
      latestDecision: decision,
      latestTask: null,
      latestRun: run,
      latestRouterTrace: trace,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");

    expect(items.map((item) => item.role)).toEqual(["user", "assistant", "assistant"]);
    expect(items[0]?.body).toBe("오버워치 2 캐릭터 조사해줘");
    expect(items[1]?.body).toBe("Hero survey complete.");
    expect(items[2]?.body).toBe("Saved the hero summary.");
  });

  it("hides internal autopilot prompts while keeping the visible assistant reply", () => {
    const decision: DecisionRecord = {
      id: "D900",
      threadId: "TH001",
      prompt: "Internal automation strategize prompt",
      displayPrompt: "[Autopilot] Advance the benchmark.",
      rawOutput: "Natural strategist reply.",
      summary: "Natural strategist reply.",
      nextTask: "",
      rationale: "",
      model: "gpt-5.4-pro",
      engine: "browser",
      status: "completed",
      command: { command: "npx", args: ["oracle"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/decisions/D900.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/decisions/D900.stderr.log",
      outputPath: "/tmp/workspace/.lithium/decisions/D900.output.txt",
      createdAt: "2026-03-19T00:00:00.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [decision],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: decision,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");

    expect(items.map((item) => item.role)).toEqual(["assistant"]);
    expect(items[0]?.body).toBe("Natural strategist reply.");
  });

  it("shows the strategist's visible reply for autopilot decisions instead of the truncated internal summary", () => {
    const decision: DecisionRecord = {
      id: "D901",
      threadId: "TH001",
      prompt: "Internal automation strategize prompt",
      displayPrompt: "[Autopilot] Advance the benchmark.",
      rawOutput: [
        "이번 실패는 MLX 학습 자체의 확정적 크래시라기보다, 빌더가 마지막 답변을 못 쓰고 종료된 오케스트레이션 실패로 보는 게 맞습니다.",
        "",
        "LITHIUM_HANDOFF",
        JSON.stringify({
          summary:
            "이번 실패는 MLX 학습 자체의 확정적 크래시라기보다, 빌더가 마지막 답변을 못 쓰고 종료된 오케스트레이션 실패로 보는 게 맞습니다. 업로드된 runtime에는 latest builder summary가 그대로…"
        })
      ].join("\n"),
      summary:
        "이번 실패는 MLX 학습 자체의 확정적 크래시라기보다, 빌더가 마지막 답변을 못 쓰고 종료된 오케스트레이션 실패로 보는 게 맞습니다. 업로드된 runtime에는 latest builder summary가 그대로…",
      nextTask: "",
      rationale: "",
      model: "gpt-5.4",
      engine: "browser",
      status: "completed",
      command: { command: "npx", args: ["oracle"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/decisions/D901.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/decisions/D901.stderr.log",
      outputPath: "/tmp/workspace/.lithium/decisions/D901.output.txt",
      createdAt: "2026-03-19T00:00:00.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [decision],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: decision,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");

    expect(items.map((item) => item.role)).toEqual(["assistant"]);
    expect(items[0]?.body).toBe(
      "이번 실패는 MLX 학습 자체의 확정적 크래시라기보다, 빌더가 마지막 답변을 못 쓰고 종료된 오케스트레이션 실패로 보는 게 맞습니다."
    );
  });

  it("renders automation interruption prompts as visible chat items", () => {
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [
        {
          id: "AU001",
          threadId: "TH001",
          objective: "델타 게이티드 어텐션을 개선해줘",
          mode: "continuous",
          status: "idle",
          allowedActions: ["strategize", "code-edit", "checkpoint"],
          paperWriteEnabled: false,
          evidenceMode: "strict",
          budget: {
            maxSteps: 64,
            maxRuntimeMinutes: 1440,
            maxRetries: 8,
            usedSteps: 4,
            usedRetries: 0
          },
          latestCheckpointId: "AC001",
          currentStepSummary: "Waiting for updated direction.",
          lastUserInstruction: "지금까지 진행사항 보고좀",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:05:00.000Z"
        }
      ],
      automationSteps: [],
      automationCheckpoints: [
        {
          id: "AC001",
          sessionId: "AU001",
          threadId: "TH001",
          status: "pending",
          title: "Automation interrupted",
          summary: "지금까지 진행사항 보고좀",
          whatChanged: [],
          evidence: [],
          risks: [],
          nextActions: ["Incorporate the latest user instruction before continuing."],
          createdAt: "2026-03-19T00:05:00.000Z",
          updatedAt: "2026-03-19T00:05:00.000Z"
        }
      ],
      latestAutomationSession: {
        id: "AU001",
        threadId: "TH001",
        objective: "델타 게이티드 어텐션을 개선해줘",
        mode: "continuous",
        status: "idle",
        allowedActions: ["strategize", "code-edit", "checkpoint"],
        paperWriteEnabled: false,
        evidenceMode: "strict",
        budget: {
          maxSteps: 64,
          maxRuntimeMinutes: 1440,
          maxRetries: 8,
          usedSteps: 4,
          usedRetries: 0
        },
        latestCheckpointId: "AC001",
        currentStepSummary: "Waiting for updated direction.",
        lastUserInstruction: "지금까지 진행사항 보고좀",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:05:00.000Z"
      },
      latestAutomationCheckpoint: {
        id: "AC001",
        sessionId: "AU001",
        threadId: "TH001",
        status: "pending",
        title: "Automation interrupted",
        summary: "지금까지 진행사항 보고좀",
        whatChanged: [],
        evidence: [],
        risks: [],
        nextActions: ["Incorporate the latest user instruction before continuing."],
        createdAt: "2026-03-19T00:05:00.000Z",
        updatedAt: "2026-03-19T00:05:00.000Z"
      },
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");

    expect(items.map((item) => item.role)).toEqual(["user", "user", "system"]);
    expect(items[0]?.body).toBe("델타 게이티드 어텐션을 개선해줘");
    expect(items[1]?.body).toBe("지금까지 진행사항 보고좀");
    expect(items[2]?.body).toBe("잠시 멈춘 상태입니다. 이어서 어떻게 진행할지 알려주세요.");
  });

  it("renders a stopped automation checkpoint as a visible stop message", () => {
    const checkpoint: ProjectSnapshot["latestAutomationCheckpoint"] = {
      id: "AC002",
      sessionId: "AU001",
      threadId: "TH001",
      status: "approved",
      title: "Automation interrupted",
      summary: "연구 중단",
      whatChanged: [],
      evidence: [],
      risks: [],
      nextActions: [],
      userResponse: "연구 중단",
      approvedAt: "2026-03-19T00:06:00.000Z",
      createdAt: "2026-03-19T00:06:00.000Z",
      updatedAt: "2026-03-19T00:06:00.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [
        {
          id: "AU001",
          threadId: "TH001",
          objective: "델타 게이티드 어텐션을 개선해줘",
          mode: "continuous",
          status: "idle",
          allowedActions: ["strategize", "code-edit", "checkpoint"],
          paperWriteEnabled: false,
          evidenceMode: "strict",
          budget: {
            maxSteps: 64,
            maxRuntimeMinutes: 1440,
            maxRetries: 8,
            usedSteps: 4,
            usedRetries: 0
          },
          latestCheckpointId: "AC002",
          currentStepSummary: "Automation stopped by the user.",
          stopReason: "연구 중단",
          lastUserInstruction: "연구 중단",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:06:00.000Z",
          endedAt: "2026-03-19T00:06:00.000Z"
        }
      ],
      automationSteps: [],
      automationCheckpoints: [checkpoint],
      latestAutomationSession: {
        id: "AU001",
        threadId: "TH001",
        objective: "델타 게이티드 어텐션을 개선해줘",
        mode: "continuous",
        status: "idle",
        allowedActions: ["strategize", "code-edit", "checkpoint"],
        paperWriteEnabled: false,
        evidenceMode: "strict",
        budget: {
          maxSteps: 64,
          maxRuntimeMinutes: 1440,
          maxRetries: 8,
          usedSteps: 4,
          usedRetries: 0
        },
        latestCheckpointId: "AC002",
        currentStepSummary: "Automation stopped by the user.",
        stopReason: "연구 중단",
        lastUserInstruction: "연구 중단",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:06:00.000Z",
        endedAt: "2026-03-19T00:06:00.000Z"
      },
      latestAutomationCheckpoint: checkpoint,
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");

    expect(items.some((item) => item.role === "user" && item.body === "연구 중단")).toBe(true);
    expect(
      items.some(
        (item) =>
          item.role === "system" &&
          item.body === "자동 연구를 멈췄습니다. 다시 시작하려면 새 메시지를 보내 주세요."
      )
    ).toBe(true);
  });

  it("hides the original automation objective after a later user steering message exists", () => {
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [
        {
          id: "AU001",
          threadId: "TH001",
          objective: "parameter-golf 프로젝트에서 이 맥북에어 M2 8GB 환경 기준으로 자동 연구를 시작해줘.\n\n목표:\n- baseline 1~2개 실행",
          mode: "continuous",
          status: "running",
          allowedActions: ["strategize", "code-edit", "checkpoint"],
          paperWriteEnabled: false,
          evidenceMode: "strict",
          budget: {
            maxSteps: 64,
            maxRuntimeMinutes: 1440,
            maxRetries: 8,
            usedSteps: 4,
            usedRetries: 1
          },
          currentStepSummary: "Plan the next bounded research step",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:05:00.000Z"
        }
      ],
      automationSteps: [],
      automationCheckpoints: [
        {
          id: "AC010",
          sessionId: "AU001",
          threadId: "TH001",
          status: "approved",
          title: "Automation update",
          summary: "Automation is still running.",
          whatChanged: [],
          evidence: [],
          risks: [],
          nextActions: [],
          userResponse: "연구 자동화 다시 시작 이어서",
          createdAt: "2026-03-19T00:06:00.000Z",
          updatedAt: "2026-03-19T00:06:30.000Z",
          approvedAt: "2026-03-19T00:06:30.000Z"
        }
      ],
      latestAutomationSession: {
        id: "AU001",
        threadId: "TH001",
        objective: "parameter-golf 프로젝트에서 이 맥북에어 M2 8GB 환경 기준으로 자동 연구를 시작해줘.\n\n목표:\n- baseline 1~2개 실행",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "code-edit", "checkpoint"],
        paperWriteEnabled: false,
        evidenceMode: "strict",
        budget: {
          maxSteps: 64,
          maxRuntimeMinutes: 1440,
          maxRetries: 8,
          usedSteps: 4,
          usedRetries: 1
        },
        currentStepSummary: "Plan the next bounded research step",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:05:00.000Z"
      },
      latestAutomationCheckpoint: {
        id: "AC010",
        sessionId: "AU001",
        threadId: "TH001",
        status: "approved",
        title: "Automation update",
        summary: "Automation is still running.",
        whatChanged: [],
        evidence: [],
        risks: [],
        nextActions: [],
        userResponse: "연구 자동화 다시 시작 이어서",
        createdAt: "2026-03-19T00:06:00.000Z",
        updatedAt: "2026-03-19T00:06:30.000Z",
        approvedAt: "2026-03-19T00:06:30.000Z"
      },
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");
    const userBodies = items.filter((item) => item.role === "user").map((item) => item.body);

    expect(userBodies).toEqual(["연구 자동화 다시 시작 이어서"]);
  });

  it("renders non-blocking automation updates as assistant replies", () => {
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [
        {
          id: "AU001",
          threadId: "TH001",
          objective: "델타 게이티드 어텐션을 개선해줘",
          mode: "continuous",
          status: "running",
          allowedActions: ["strategize", "code-edit", "checkpoint"],
          paperWriteEnabled: false,
          evidenceMode: "strict",
          budget: {
            maxSteps: 64,
            maxRuntimeMinutes: 1440,
            maxRetries: 8,
            usedSteps: 4,
            usedRetries: 0
          },
          currentStepSummary: "Let Codex choose and execute the next bounded step",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:05:00.000Z"
        }
      ],
      automationSteps: [],
      automationCheckpoints: [
        {
          id: "AC002",
          sessionId: "AU001",
          threadId: "TH001",
          status: "approved",
          title: "Automation update",
          summary: "Automation is still running. 4 steps completed, 0 retries used.",
          whatChanged: [],
          evidence: [],
          risks: [],
          nextActions: [],
          userResponse: "지금까지 진행사항 보고좀",
          createdAt: "2026-03-19T00:05:00.000Z",
          updatedAt: "2026-03-19T00:05:00.000Z",
          approvedAt: "2026-03-19T00:05:00.000Z"
        }
      ],
      latestAutomationSession: {
        id: "AU001",
        threadId: "TH001",
        objective: "델타 게이티드 어텐션을 개선해줘",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "code-edit", "checkpoint"],
        paperWriteEnabled: false,
        evidenceMode: "strict",
        budget: {
          maxSteps: 64,
          maxRuntimeMinutes: 1440,
          maxRetries: 8,
          usedSteps: 4,
          usedRetries: 0
        },
        currentStepSummary: "Let Codex choose and execute the next bounded step",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:05:00.000Z"
      },
      latestAutomationCheckpoint: {
        id: "AC002",
        sessionId: "AU001",
        threadId: "TH001",
        status: "approved",
        title: "Automation update",
        summary: "Automation is still running. 4 steps completed, 0 retries used.",
        whatChanged: [],
        evidence: [],
        risks: [],
        nextActions: [],
        userResponse: "지금까지 진행사항 보고좀",
        createdAt: "2026-03-19T00:05:00.000Z",
        updatedAt: "2026-03-19T00:05:00.000Z",
        approvedAt: "2026-03-19T00:05:00.000Z"
      },
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");

    expect(items.map((item) => item.role)).toEqual(["user", "user", "system"]);
    expect(items[0]?.body).toBe("델타 게이티드 어텐션을 개선해줘");
    expect(items[1]?.body).toBe("지금까지 진행사항 보고좀");
    expect(items[2]?.body).toBe("다음으로 검증할 실험이나 구현 단계를 고르고 있습니다.");
  });

  it("keeps the original automation objective visible before any step completes", () => {
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [
        {
          id: "AU001",
          threadId: "TH001",
          objective: "parameter-golf 프로젝트를 깊게 검증해줘",
          mode: "continuous",
          status: "running",
          allowedActions: ["strategize", "code-edit", "checkpoint"],
          paperWriteEnabled: false,
          evidenceMode: "strict",
          budget: {
            maxSteps: 64,
            maxRuntimeMinutes: 1440,
            maxRetries: 8,
            usedSteps: 0,
            usedRetries: 0
          },
          currentStepSummary: "Plan the next bounded research step",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:05.000Z"
        }
      ],
      automationSteps: [],
      automationCheckpoints: [],
      latestAutomationSession: {
        id: "AU001",
        threadId: "TH001",
        objective: "parameter-golf 프로젝트를 깊게 검증해줘",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "code-edit", "checkpoint"],
        paperWriteEnabled: false,
        evidenceMode: "strict",
        budget: {
          maxSteps: 64,
          maxRuntimeMinutes: 1440,
          maxRetries: 8,
          usedSteps: 0,
          usedRetries: 0
        },
        currentStepSummary: "Plan the next bounded research step",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:05.000Z"
      },
      latestAutomationCheckpoint: null,
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");

    expect(items).toHaveLength(1);
    expect(items[0]?.role).toBe("user");
    expect(items[0]?.body).toBe("parameter-golf 프로젝트를 깊게 검증해줘");
  });

  it("renders failed automation checkpoints with a review state and normalized paths", () => {
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [
        {
          id: "AU001",
          threadId: "TH001",
          objective: "델타 게이티드 어텐션을 개선해줘",
          mode: "continuous",
          status: "idle",
          allowedActions: ["strategize", "code-edit", "checkpoint"],
          paperWriteEnabled: false,
          evidenceMode: "strict",
          budget: {
            maxSteps: 64,
            maxRuntimeMinutes: 1440,
            maxRetries: 8,
            usedSteps: 5,
            usedRetries: 1
          },
          latestCheckpointId: "AC003",
          currentStepSummary: "Automation stopped with an issue. Waiting for your direction.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:05:00.000Z"
        }
      ],
      automationSteps: [],
      automationCheckpoints: [
        {
          id: "AC003",
          sessionId: "AU001",
          threadId: "TH001",
          status: "pending",
          title: "Automation needs review after a failed run",
          summary: "The latest run failed.",
          whatChanged: ["/tmp/workspace/src/cegda/recurrent.py"],
          evidence: [],
          risks: ["The step failed."],
          nextActions: ["Inspect the failure and resume."],
          createdAt: "2026-03-19T00:05:00.000Z",
          updatedAt: "2026-03-19T00:05:00.000Z"
        }
      ],
      latestAutomationSession: {
        id: "AU001",
        threadId: "TH001",
        objective: "델타 게이티드 어텐션을 개선해줘",
        mode: "continuous",
        status: "idle",
        allowedActions: ["strategize", "code-edit", "checkpoint"],
        paperWriteEnabled: false,
        evidenceMode: "strict",
        budget: {
          maxSteps: 64,
          maxRuntimeMinutes: 1440,
          maxRetries: 8,
          usedSteps: 5,
          usedRetries: 1
        },
        latestCheckpointId: "AC003",
        currentStepSummary: "Automation stopped with an issue. Waiting for your direction.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:05:00.000Z"
      },
      latestAutomationCheckpoint: {
        id: "AC003",
        sessionId: "AU001",
        threadId: "TH001",
        status: "pending",
        title: "Automation needs review after a failed run",
        summary: "The latest run failed.",
        whatChanged: ["/tmp/workspace/src/cegda/recurrent.py"],
        evidence: [],
        risks: ["The step failed."],
        nextActions: ["Inspect the failure and resume."],
        createdAt: "2026-03-19T00:05:00.000Z",
        updatedAt: "2026-03-19T00:05:00.000Z"
      },
      logs: []
    };

    const items = buildChatItems(
      snapshot,
      [
        {
          path: "/tmp/workspace/src/cegda/recurrent.py",
          relativePath: "src/cegda/recurrent.py",
          name: "recurrent.py",
          kind: "code"
        }
      ],
      "/tmp/workspace"
    );

    expect(items).toHaveLength(2);
    expect(items[0]?.role).toBe("user");
    expect(items[0]?.body).toBe("델타 게이티드 어텐션을 개선해줘");
    expect(items[1]?.body).toBe(
      "직전 단계가 깔끔하게 끝나지 않았습니다. 같은 경로를 계속 복구할지, 방향을 바꿀지 알려주세요."
    );
    expect(items[1]?.artifacts).toBeUndefined();
    expect(items[1]?.details).toBeUndefined();
  });

  it("renders strategist-oracle blockers as blocked automation cards", () => {
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [
        {
          id: "AU001",
          threadId: "TH001",
          objective: "parameter-golf를 리서치해줘",
          mode: "continuous",
          status: "idle",
          allowedActions: ["strategize", "code-edit", "checkpoint"],
          paperWriteEnabled: false,
          evidenceMode: "strict",
          budget: {
            maxSteps: 64,
            maxRuntimeMinutes: 1440,
            maxRetries: 8,
            usedSteps: 0,
            usedRetries: 0
          },
          latestCheckpointId: "AC004",
          currentStepSummary: "Blocked on the strategist run. Waiting for your direction.",
          stopReason:
            "Oracle strategist run completed without producing output.\nSet LITHIUM_ORACLE_VISIBLE=1 if you need to watch the browser login or troubleshoot the run.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:05:00.000Z"
        }
      ],
      automationSteps: [],
      automationCheckpoints: [
        {
          id: "AC004",
          sessionId: "AU001",
          threadId: "TH001",
          status: "pending",
          title: "Automation blocked on the strategist run",
          summary:
            "Oracle strategist run completed without producing output.\nSet LITHIUM_ORACLE_VISIBLE=1 if you need to watch the browser login or troubleshoot the run.",
          whatChanged: [],
          evidence: [],
          risks: [
            "Oracle strategist run completed without producing output.\nSet LITHIUM_ORACLE_VISIBLE=1 if you need to watch the browser login or troubleshoot the run."
          ],
          nextActions: [
            "Keep the strategist Chrome window open until completion, then retry.",
            "If needed, set LITHIUM_ORACLE_VISIBLE=1 and retry so you can watch the oracle/browser flow."
          ],
          createdAt: "2026-03-19T00:05:00.000Z",
          updatedAt: "2026-03-19T00:05:00.000Z"
        }
      ],
      latestAutomationSession: {
        id: "AU001",
        threadId: "TH001",
        objective: "parameter-golf를 리서치해줘",
        mode: "continuous",
        status: "idle",
        allowedActions: ["strategize", "code-edit", "checkpoint"],
        paperWriteEnabled: false,
        evidenceMode: "strict",
        budget: {
          maxSteps: 64,
          maxRuntimeMinutes: 1440,
          maxRetries: 8,
          usedSteps: 0,
          usedRetries: 0
        },
        latestCheckpointId: "AC004",
        currentStepSummary: "Blocked on the strategist run. Waiting for your direction.",
        stopReason:
          "Oracle strategist run completed without producing output.\nSet LITHIUM_ORACLE_VISIBLE=1 if you need to watch the browser login or troubleshoot the run.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:05:00.000Z"
      },
      latestAutomationCheckpoint: {
        id: "AC004",
        sessionId: "AU001",
        threadId: "TH001",
        status: "pending",
        title: "Automation blocked on the strategist run",
        summary:
          "Oracle strategist run completed without producing output.\nSet LITHIUM_ORACLE_VISIBLE=1 if you need to watch the browser login or troubleshoot the run.",
        whatChanged: [],
        evidence: [],
        risks: [
          "Oracle strategist run completed without producing output.\nSet LITHIUM_ORACLE_VISIBLE=1 if you need to watch the browser login or troubleshoot the run."
        ],
        nextActions: [
          "Keep the strategist Chrome window open until completion, then retry.",
          "If needed, set LITHIUM_ORACLE_VISIBLE=1 and retry so you can watch the oracle/browser flow."
        ],
        createdAt: "2026-03-19T00:05:00.000Z",
        updatedAt: "2026-03-19T00:05:00.000Z"
      },
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");

    expect(items).toHaveLength(2);
    expect(items[1]?.body).toBe(
      "브라우저가 필요한 strategist 단계에서 막혔습니다. 다시 시도할지, 방향을 바꿀지 알려주세요."
    );
    expect(items[1]?.details).toBeUndefined();
  });

  it("hides resolved operational checkpoint bodies after automation resumes", () => {
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: null,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [
        {
          id: "AU001",
          threadId: "TH001",
          objective: "parameter-golf를 리서치해줘",
          mode: "continuous",
          status: "running",
          allowedActions: ["strategize", "code-edit", "checkpoint"],
          paperWriteEnabled: false,
          evidenceMode: "strict",
          budget: {
            maxSteps: 64,
            maxRuntimeMinutes: 1440,
            maxRetries: 8,
            usedSteps: 4,
            usedRetries: 1
          },
          latestCheckpointId: "AC004",
          currentStepSummary: "Plan the next bounded research step",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:05:00.000Z"
        }
      ],
      automationSteps: [],
      automationCheckpoints: [
        {
          id: "AC003",
          sessionId: "AU001",
          threadId: "TH001",
          status: "approved",
          title: "Automation needs review after a failed run",
          summary: "Builder run ended without writing a final answer.",
          whatChanged: [],
          evidence: [],
          risks: [],
          nextActions: ["Inspect the latest checkpoint and resume."],
          userResponse: "같은 목표로 계속 진행해",
          createdAt: "2026-03-19T00:04:00.000Z",
          updatedAt: "2026-03-19T00:04:30.000Z",
          approvedAt: "2026-03-19T00:04:30.000Z"
        },
        {
          id: "AC004",
          sessionId: "AU001",
          threadId: "TH001",
          status: "approved",
          title: "Automation interrupted after app restart",
          summary: "Automation stopped when Lithium restarted during the builder step.",
          whatChanged: [],
          evidence: [],
          risks: ["Automation stopped when Lithium restarted during the builder step."],
          nextActions: ["Resume automation to continue from the latest saved state."],
          userResponse: "연구 자동화 다시 시작 이어서",
          createdAt: "2026-03-19T00:05:00.000Z",
          updatedAt: "2026-03-19T00:05:30.000Z",
          approvedAt: "2026-03-19T00:05:30.000Z"
        },
        {
          id: "AC005",
          sessionId: "AU001",
          threadId: "TH001",
          status: "approved",
          title: "Automation update",
          summary: "Automation is still running. 4 steps completed, 1 retries used.",
          whatChanged: [],
          evidence: [],
          risks: [],
          nextActions: [],
          userResponse: "지금 상태 보고",
          createdAt: "2026-03-19T00:06:00.000Z",
          updatedAt: "2026-03-19T00:06:30.000Z",
          approvedAt: "2026-03-19T00:06:30.000Z"
        }
      ],
      latestAutomationSession: {
        id: "AU001",
        threadId: "TH001",
        objective: "parameter-golf를 리서치해줘",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "code-edit", "checkpoint"],
        paperWriteEnabled: false,
        evidenceMode: "strict",
        budget: {
          maxSteps: 64,
          maxRuntimeMinutes: 1440,
          maxRetries: 8,
          usedSteps: 4,
          usedRetries: 1
        },
        latestCheckpointId: "AC004",
        currentStepSummary: "Plan the next bounded research step",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:05:00.000Z"
      },
      latestAutomationCheckpoint: {
        id: "AC005",
        sessionId: "AU001",
        threadId: "TH001",
        status: "approved",
        title: "Automation update",
        summary: "Automation is still running. 4 steps completed, 1 retries used.",
        whatChanged: [],
        evidence: [],
        risks: [],
        nextActions: [],
        userResponse: "지금 상태 보고",
        createdAt: "2026-03-19T00:06:00.000Z",
        updatedAt: "2026-03-19T00:06:30.000Z",
        approvedAt: "2026-03-19T00:06:30.000Z"
      },
      logs: []
    };

    const items = buildChatItems(snapshot, [], "/tmp/workspace");
    const bodies = items.map((item) => item.body);

    expect(bodies).toContain("같은 목표로 계속 진행해");
    expect(bodies).toContain("연구 자동화 다시 시작 이어서");
    expect(bodies).toContain("지금 상태 보고");
    expect(bodies).toContain("다음 연구 단계를 작게 쪼개서 정리하고 있습니다.");
    expect(bodies).not.toContain(
      "직전 단계가 깔끔하게 끝나지 않았습니다. 같은 경로를 계속 복구할지, 방향을 바꿀지 알려주세요."
    );
    expect(bodies).not.toContain("Automation stopped when Lithium restarted during the builder step.");
  });

  it("hides superseded operational automation bodies once a newer interruption checkpoint exists", () => {
    const run: RunRecord = {
      id: "R043",
      threadId: "TH001",
      taskId: "T043",
      prompt: "[autopilot] continue",
      displayPrompt: "[autopilot] continue",
      model: "gpt-5.4",
      status: "cancelled",
      exitCode: null,
      pid: null,
      command: { command: "codex", args: ["exec"], cwd: "/tmp/workspace" },
      stdoutPath: "/tmp/workspace/.lithium/runs/R043.stdout.log",
      stderrPath: "/tmp/workspace/.lithium/runs/R043.stderr.log",
      finalMessagePath: "/tmp/workspace/.lithium/runs/R043.output.txt",
      finalMessage: [
        "Lithium terminated a detached builder process after an app restart left it running without an active session.",
        "",
        "LITHIUM_STATUS",
        '{"summary":"Lithium terminated a detached builder process after an app restart left it running without an active session.","result":"partial"}'
      ].join("\n"),
      handoff: {
        schemaVersion: "lithium_handoff_v1",
        role: "builder",
        summary: "Lithium terminated a detached builder process after an app restart left it running without an active session.",
        machineSummary: "Lithium terminated a detached builder process after an app restart left it running without an active session.",
        result: "partial",
        files: [],
        risks: [],
        paperActions: [],
        runActions: [],
        successCriteria: [],
        openQuestions: []
      },
      changedFiles: [],
      finalization: "auto",
      createdAt: "2026-03-19T00:03:00.000Z",
      startedAt: "2026-03-19T00:03:00.000Z",
      endedAt: "2026-03-19T00:05:00.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "project-1",
        name: "workspace",
        workspacePath: "/tmp/workspace",
        lithiumPath: "/tmp/workspace/.lithium",
        manuscriptPath: "/tmp/workspace/.lithium/manuscript/sections/results.md",
        oracleModel: "gpt-5.4",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      memory: null,
      threads: [
        {
          id: "TH001",
          title: "Main thread",
          summary: "Working on the workspace.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ],
      activeThreadId: "TH001",
      activeThread: {
        id: "TH001",
        title: "Main thread",
        summary: "Working on the workspace.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      attachments: [],
      activeThreadAttachments: [],
      decisions: [],
      tasks: [],
      runs: [run],
      routerTraces: [],
      latestDecision: null,
      latestTask: null,
      latestRun: run,
      latestRouterTrace: null,
      terminalSessions: [],
      latestTerminalSession: null,
      manuscript: null,
      automationSessions: [
        {
          id: "AU001",
          threadId: "TH001",
          objective: "parameter-golf를 리서치해줘",
          mode: "continuous",
          status: "idle",
          allowedActions: ["strategize", "code-edit", "checkpoint"],
          paperWriteEnabled: false,
          evidenceMode: "strict",
          budget: {
            maxSteps: 64,
            maxRuntimeMinutes: 1440,
            maxRetries: 8,
            usedSteps: 4,
            usedRetries: 1
          },
          latestCheckpointId: "AC016",
          currentStepSummary: "Automation was interrupted when Lithium restarted. Waiting for your direction.",
          stopReason: "Automation stopped when Lithium restarted during the builder step.",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:06:30.000Z",
          endedAt: "2026-03-19T00:06:30.000Z"
        }
      ],
      automationSteps: [
        {
          id: "AS054",
          sessionId: "AU001",
          threadId: "TH001",
          kind: "experiment-run",
          lane: "builder",
          title: "Let Codex choose and execute the next bounded step",
          prompt: "continue",
          status: "failed",
          summary: "Automation stopped when Lithium restarted during the builder step.",
          changedFiles: [],
          evidence: [],
          checkpointRequired: true,
          createdAt: "2026-03-19T00:05:20.000Z",
          updatedAt: "2026-03-19T00:06:30.000Z",
          completedAt: "2026-03-19T00:06:30.000Z"
        }
      ],
      automationCheckpoints: [
        {
          id: "AC001",
          sessionId: "AU001",
          threadId: "TH001",
          status: "approved",
          title: "Automation blocked on the strategist run",
          summary: "The strategist browser step needs help before automation can continue.",
          whatChanged: [],
          evidence: [],
          risks: [],
          nextActions: ["Keep the strategist Chrome window open until completion, then retry."],
          createdAt: "2026-03-19T00:04:00.000Z",
          updatedAt: "2026-03-19T00:04:30.000Z",
          approvedAt: "2026-03-19T00:04:30.000Z"
        },
        {
          id: "AC016",
          sessionId: "AU001",
          threadId: "TH001",
          status: "pending",
          title: "Automation interrupted after app restart",
          summary: "Automation stopped when Lithium restarted during the builder step.",
          whatChanged: [],
          evidence: ["AS054"],
          risks: ["Automation stopped when Lithium restarted during the builder step."],
          nextActions: ["Resume automation to continue from the latest saved state."],
          createdAt: "2026-03-19T00:06:30.000Z",
          updatedAt: "2026-03-19T00:06:30.000Z"
        }
      ],
      latestAutomationSession: {
        id: "AU001",
        threadId: "TH001",
        objective: "parameter-golf를 리서치해줘",
        mode: "continuous",
        status: "idle",
        allowedActions: ["strategize", "code-edit", "checkpoint"],
        paperWriteEnabled: false,
        evidenceMode: "strict",
        budget: {
          maxSteps: 64,
          maxRuntimeMinutes: 1440,
          maxRetries: 8,
          usedSteps: 4,
          usedRetries: 1
        },
        latestCheckpointId: "AC016",
        currentStepSummary: "Automation was interrupted when Lithium restarted. Waiting for your direction.",
        stopReason: "Automation stopped when Lithium restarted during the builder step.",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:06:30.000Z",
        endedAt: "2026-03-19T00:06:30.000Z"
      },
      latestAutomationCheckpoint: {
        id: "AC016",
        sessionId: "AU001",
        threadId: "TH001",
        status: "pending",
        title: "Automation interrupted after app restart",
        summary: "Automation stopped when Lithium restarted during the builder step.",
        whatChanged: [],
        evidence: ["AS054"],
        risks: ["Automation stopped when Lithium restarted during the builder step."],
        nextActions: ["Resume automation to continue from the latest saved state."],
        createdAt: "2026-03-19T00:06:30.000Z",
        updatedAt: "2026-03-19T00:06:30.000Z"
      },
      logs: []
    };

    const bodies = buildChatItems(snapshot, [], "/tmp/workspace").map((item) => item.body);

    expect(bodies).not.toContain(
      "Lithium terminated a detached builder process after an app restart left it running without an active session."
    );
    expect(bodies).not.toContain("The strategist browser step needs help before automation can continue.");
    expect(bodies).not.toContain("Automation stopped when Lithium restarted during the builder step.");
    expect(bodies).toContain("잠시 멈춘 상태입니다. 다음에 무엇을 할지 알려주세요.");
  });

  it("resolves system theme using the current platform preference", () => {
    expect(resolveThemeMode("system", true)).toBe("dark");
    expect(resolveThemeMode("system", false)).toBe("light");
    expect(resolveThemeMode("dark", false)).toBe("dark");
  });

  it("prefers the initialized project name for the surface title", () => {
    expect(
      resolveWorkspaceSurfaceTitle("Lithium", {
        selectedWorkspaceLabel: "sandbox",
        selectedWorkspacePath: "/tmp/sandbox"
      })
    ).toBe("Lithium");
  });

  it("falls back to the selected workspace label before a project exists", () => {
    expect(
      resolveWorkspaceSurfaceTitle("", {
        selectedWorkspaceLabel: "new-research-folder",
        selectedWorkspacePath: "/tmp/new-research-folder"
      })
    ).toBe("new-research-folder");
  });

  it("derives the surface title from the selected workspace path when no label is present", () => {
    expect(
      resolveWorkspaceSurfaceTitle("", {
        selectedWorkspaceLabel: "",
        selectedWorkspacePath: "/tmp/nested/another-workspace"
      })
    ).toBe("another-workspace");
  });

  it("describes the ChatGPT Pro login flow when the strategist browser is available", () => {
    const checklist = buildOnboardingChecklist(
      {
        platform: "darwin",
        electronVersion: "40.8.2",
        chromeVersion: "144.0.0.0",
        nodeVersion: "24.0.0",
        cwd: "/tmp/lithium",
        selectedWorkspacePath: "",
        selectedWorkspaceLabel: "",
        selectedWorkspaceKind: "local",
        selectedWorkspaceRemoteHost: null,
        selectedWorkspaceRemotePath: null,
        oracleReady: true,
        codexReady: true,
        oracleChromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        discordBotStatus: {
          state: "disabled",
          botTag: "",
          botUserId: "",
          lastError: null,
          workspacePath: ""
        }
        ,
        settings: DEFAULT_APP_SETTINGS
      },
      false
    );

    expect(checklist[0]).toMatchObject({
      id: "strategist",
      status: "action"
    });
    expect(checklist[0]?.detail).toContain("visible browser");
    expect(checklist[0]?.detail).toContain("Pro subscription");
  });

  it("marks the strategist lane ready after the first verified login", () => {
    const checklist = buildOnboardingChecklist(
      {
        platform: "darwin",
        electronVersion: "40.8.2",
        chromeVersion: "144.0.0.0",
        nodeVersion: "24.0.0",
        cwd: "/tmp/lithium",
        selectedWorkspacePath: "",
        selectedWorkspaceLabel: "",
        selectedWorkspaceKind: "local",
        selectedWorkspaceRemoteHost: null,
        selectedWorkspaceRemotePath: null,
        oracleReady: true,
        codexReady: true,
        oracleChromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        discordBotStatus: {
          state: "disabled",
          botTag: "",
          botUserId: "",
          lastError: null,
          workspacePath: ""
        },
        settings: {
          ...DEFAULT_APP_SETTINGS,
          strategistSessionReady: true
        }
      },
      false
    );

    expect(checklist[0]).toMatchObject({
      id: "strategist",
      status: "ready"
    });
    expect(checklist[0]?.detail).toContain("reuse");
  });

  it("asks for a browser install when the strategist browser is unavailable", () => {
    const checklist = buildOnboardingChecklist(
      {
        platform: "darwin",
        electronVersion: "40.8.2",
        chromeVersion: "144.0.0.0",
        nodeVersion: "24.0.0",
        cwd: "/tmp/lithium",
        selectedWorkspacePath: "",
        selectedWorkspaceLabel: "",
        selectedWorkspaceKind: "local",
        selectedWorkspaceRemoteHost: null,
        selectedWorkspaceRemotePath: null,
        oracleReady: true,
        codexReady: false,
        oracleChromePath: null,
        discordBotStatus: {
          state: "disabled",
          botTag: "",
          botUserId: "",
          lastError: null,
          workspacePath: ""
        },
        settings: DEFAULT_APP_SETTINGS
      },
      false
    );

    expect(checklist[0]?.status).toBe("action");
    expect(checklist[0]?.detail).toContain("Install Chrome or Chromium");
    expect(checklist[1]?.status).toBe("action");
    expect(checklist[2]?.detail).toContain("Cmd+O");
  });
});
