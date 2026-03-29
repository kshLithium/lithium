import { describe, expect, it } from "vitest";
import type {
  AutomationSessionRecord,
  AutomationStepRecord,
  ChatProgressInspection,
  DecisionRecord,
  ProjectSnapshot,
  RunRecord,
  ThreadRecord
} from "../shared/types";
import type { ChatItem } from "./app-types";
import { buildChatItems, formatLiveProgressBody, mergeTransientChatItems } from "./app-utils";
import { stabilizeChatProgress } from "./chat-progress";

function buildProgress(
  input: Partial<ChatProgressInspection> = {}
): ChatProgressInspection {
  return {
    active: true,
    lane: "orchestrator",
    threadId: "TH001",
    progressSummary: "",
    progressDetails: [],
    activeCommand: null,
    stdoutTail: "",
    stderrTail: "",
    updatedAt: "2026-03-25T12:00:00.000Z",
    ...input
  };
}

describe("stabilizeChatProgress", () => {
  it("keeps the current richer narration when the next poll regresses to the generic placeholder", () => {
    const current = buildProgress({
      progressSummary: "README와 recent logs를 같이 좁혀 보고 있습니다.",
      progressDetails: ["baseline과 novelty 후보를 가르는 중입니다."],
      updatedAt: "2026-03-25T12:00:03.000Z"
    });
    const next = buildProgress({
      updatedAt: "2026-03-25T12:00:05.000Z"
    });

    expect(stabilizeChatProgress(current, next)).toBe(current);
  });

  it("still accepts a newer richer narration for the same live turn", () => {
    const current = buildProgress({
      progressSummary: "README를 읽고 있습니다.",
      progressDetails: []
    });
    const next = buildProgress({
      progressSummary: "README와 recent logs를 같이 좁혀 보고 있습니다.",
      progressDetails: ["baseline과 novelty 후보를 가르는 중입니다."],
      updatedAt: "2026-03-25T12:00:05.000Z"
    });

    expect(stabilizeChatProgress(current, next)).toBe(next);
  });

  it("clears stale progress when the backend reports no active progress entry", () => {
    const current = buildProgress({
      progressSummary: "README와 recent logs를 같이 좁혀 보고 있습니다.",
      progressDetails: ["baseline과 novelty 후보를 가르는 중입니다."]
    });

    expect(stabilizeChatProgress(current, null)).toBeNull();
  });
});

describe("mergeTransientChatItems", () => {
  it("hides an optimistic first user message after the persisted chat entry appears", () => {
    const persistedItems: ChatItem[] = [
      {
        id: "conversation:M001",
        role: "user",
        body: "parameter-golf 프로젝트에서 자동 연구를 시작해줘.",
        timestamp: "2026-03-26T02:00:01.000Z",
        order: 0
      }
    ];
    const pendingItems: ChatItem[] = [
      {
        id: "pending:1",
        role: "user",
        body: "parameter-golf 프로젝트에서 자동 연구를 시작해줘.",
        timestamp: "2026-03-26T02:00:00.000Z",
        order: 0
      }
    ];

    const merged = mergeTransientChatItems(persistedItems, pendingItems, {
      busyAction: "Running chat",
      busyBody: "Reviewing the latest thread state and choosing the next move.",
      activeThreadId: "TH001"
    });

    expect(merged.filter((item) => item.role === "user")).toHaveLength(1);
    expect(merged[0]?.id).toBe("conversation:M001");
    expect(merged[1]?.id).toBe("busy:TH001:Running chat");
    expect(merged[1]?.pending).toBe(true);
  });

  it("keeps a genuinely new repeated prompt visible until its own persisted entry arrives", () => {
    const persistedItems: ChatItem[] = [
      {
        id: "conversation:M001",
        role: "user",
        body: "Same prompt",
        timestamp: "2026-03-26T02:00:00.000Z",
        order: 0
      }
    ];
    const pendingItems: ChatItem[] = [
      {
        id: "pending:2",
        role: "user",
        body: "Same prompt",
        timestamp: "2026-03-26T02:03:30.000Z",
        order: 1
      }
    ];

    const merged = mergeTransientChatItems(persistedItems, pendingItems, {
      busyAction: "Running chat",
      activeThreadId: "TH001"
    });

    expect(merged.filter((item) => item.role === "user")).toHaveLength(2);
    expect(merged.some((item) => item.id === "pending:2")).toBe(true);
    expect(merged.some((item) => item.id.startsWith("busy:"))).toBe(false);
  });

  it("suppresses live progress that only echoes the latest user prompt", () => {
    const persistedItems: ChatItem[] = [
      {
        id: "conversation:M001",
        role: "user",
        body: "리서치할 때 브라우저에서 버그걸린 더 이제 내가 고쳤음 자유롭게 strate model call 해도 됨",
        timestamp: "2026-03-26T02:00:01.000Z",
        order: 0
      }
    ];

    const merged = mergeTransientChatItems(persistedItems, [], {
      busyAction: "Running chat",
      busyBody: "리서치할 때 브라우저에서 버그걸린 더 이제 내가 고쳤음 자유롭게 strate model call 해도 됨",
      chatProgress: buildProgress({
        progressSummary: "리서치할 때 브라우저에서 버그걸린 더 이제 내가 고쳤음 자유롭게 strate model call 해도 됨",
        progressDetails: []
      }),
      activeThreadId: "TH001"
    });

    expect(merged).toEqual(persistedItems);
  });
});

describe("formatLiveProgressBody", () => {
  it("strips raw control footers from live progress text", () => {
    expect(
      formatLiveProgressBody(
        buildProgress({
          progressSummary: '정리해 두었습니다.\n\nLITHIUM_STATUS {"machine_summary":"internal"}',
          progressDetails: []
        })
      )
    ).toBe("정리해 두었습니다.");
  });
});

describe("buildChatItems", () => {
  it("suppresses raw worker artifacts when an automation timeline exists", () => {
    const thread: ThreadRecord = {
      id: "TH001",
      title: "Main thread",
      summary: "",
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z"
    };
    const decision: DecisionRecord = {
      id: "D001",
      threadId: "TH001",
      prompt: "Review the latest local result.",
      rawOutput: "원문 strategist 답변",
      summary: "새 기준선을 유지하고 다음 분기를 검토합니다.",
      rationale: "",
      model: "gpt-5.4-pro",
      engine: "browser",
      status: "completed",
      command: {
        command: "oracle",
        args: ["exec"],
        cwd: "/tmp"
      },
      stdoutPath: "/tmp/D001.stdout.log",
      stderrPath: "/tmp/D001.stderr.log",
      outputPath: "/tmp/D001.output.txt",
      createdAt: "2026-03-26T00:01:00.000Z"
    };
    const run: RunRecord = {
      id: "R001",
      threadId: "TH001",
      taskId: "T001",
      prompt: "Run the next bounded experiment.",
      model: "gpt-5.4",
      status: "completed",
      exitCode: 0,
      pid: null,
      command: {
        command: "codex",
        args: ["exec"],
        cwd: "/tmp"
      },
      stdoutPath: "/tmp/R001.stdout.log",
      stderrPath: "/tmp/R001.stderr.log",
      finalMessagePath: "/tmp/R001.output.txt",
      finalMessage: "원문 builder 답변",
      changedFiles: [],
      finalization: "auto",
      createdAt: "2026-03-26T00:02:00.000Z",
      startedAt: "2026-03-26T00:02:00.000Z",
      endedAt: "2026-03-26T00:03:00.000Z"
    };
    const session: AutomationSessionRecord = {
      id: "AU001",
      threadId: "TH001",
      objective: "Keep the automation running.",
      displayObjective: "Keep the automation running.",
      mode: "continuous",
      status: "running",
      allowedActions: ["strategize", "experiment-run"],
      evidenceMode: "strict",
      budget: {
        maxSteps: 10,
        maxRuntimeMinutes: 60,
        maxRetries: 3,
        usedSteps: 1,
        usedRetries: 0
      },
      currentStepSummary: "Running the next bounded step.",
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:04:00.000Z"
    };
    const step: AutomationStepRecord = {
      id: "AS001",
      sessionId: "AU001",
      threadId: "TH001",
      kind: "experiment-run",
      lane: "builder",
      workerMode: "live",
      title: "Run the next bounded step",
      prompt: "Run the next bounded step.",
      status: "completed",
      summary: "실험 한 건을 마쳤고 결과를 정리 중입니다.",
      startedSideEffects: [],
      completedSideEffects: [],
      changedFiles: [],
      evidence: [],
      checkpointRequired: false,
      createdAt: "2026-03-26T00:02:00.000Z",
      updatedAt: "2026-03-26T00:03:00.000Z",
      completedAt: "2026-03-26T00:03:00.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "P001",
        name: "real",
        workspacePath: "/tmp",
        oracleModel: "gpt-5.4-pro",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-26T00:00:00.000Z",
        updatedAt: "2026-03-26T00:00:00.000Z"
      },
      memory: null,
      threads: [thread],
      activeThreadId: "TH001",
      activeThread: thread,
      conversationEntries: [],
      latestConversationEntry: null,
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
      automationSessions: [session],
      automationCycles: [],
      automationSteps: [step],
      automationCheckpoints: [],
      latestAutomationSession: session,
      latestAutomationCycle: null,
      latestAutomationCheckpoint: null,
      logs: []
    };

    const items = buildChatItems(snapshot, "/tmp");

    expect(items.some((item) => item.id === "decision-result:D001")).toBe(false);
    expect(items.some((item) => item.id === "run:R001")).toBe(false);
    expect(items.some((item) => item.id === "automation-session:AU001")).toBe(true);
  });

  it("shows raw automation lane step summaries instead of synthesized renderer copy", () => {
    const thread: ThreadRecord = {
      id: "TH001",
      title: "Main thread",
      summary: "",
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z"
    };
    const session: AutomationSessionRecord = {
      id: "AU001",
      threadId: "TH001",
      objective: "Keep the automation running.",
      displayObjective: "Keep the automation running.",
      mode: "continuous",
      status: "running",
      allowedActions: ["strategize", "experiment-run"],
      evidenceMode: "strict",
      budget: {
        maxSteps: 10,
        maxRuntimeMinutes: 60,
        maxRetries: 3,
        usedSteps: 2,
        usedRetries: 0
      },
      currentStepSummary: "Run the next builder execution branch",
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:04:00.000Z"
    };
    const step: AutomationStepRecord = {
      id: "AS001",
      sessionId: "AU001",
      threadId: "TH001",
      kind: "experiment-run",
      lane: "builder",
      workerMode: "live",
      title: "Run the next builder execution branch",
      prompt: "Run the next builder execution branch.",
      status: "completed",
      summary: "Run the next builder execution branch",
      startedSideEffects: [],
      completedSideEffects: [],
      changedFiles: [],
      evidence: [],
      checkpointRequired: false,
      createdAt: "2026-03-26T00:02:00.000Z",
      updatedAt: "2026-03-26T00:03:00.000Z",
      completedAt: "2026-03-26T00:03:00.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "P001",
        name: "real",
        workspacePath: "/tmp",
        oracleModel: "gpt-5.4-pro",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-26T00:00:00.000Z",
        updatedAt: "2026-03-26T00:00:00.000Z"
      },
      memory: null,
      threads: [thread],
      activeThreadId: "TH001",
      activeThread: thread,
      conversationEntries: [],
      latestConversationEntry: null,
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
      automationSessions: [session],
      automationCycles: [],
      automationSteps: [step],
      automationCheckpoints: [],
      latestAutomationSession: session,
      latestAutomationCycle: null,
      latestAutomationCheckpoint: null,
      logs: []
    };

    const items = buildChatItems(snapshot, "/tmp");
    const summaryItem = items.find((item) => item.id === "automation-step-summary:AS001");

    expect(summaryItem?.body).toBe("Run the next builder execution branch");
  });

  it("hides internal background strategist failure summaries from the chat timeline", () => {
    const thread: ThreadRecord = {
      id: "TH001",
      title: "Main thread",
      summary: "",
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z"
    };
    const session: AutomationSessionRecord = {
      id: "AU001",
      threadId: "TH001",
      objective: "자동 연구를 계속 이어가세요.",
      displayObjective: "자동 연구를 계속 이어가세요.",
      mode: "continuous",
      status: "running",
      allowedActions: ["strategize", "experiment-run"],
      evidenceMode: "strict",
      budget: {
        maxSteps: 10,
        maxRuntimeMinutes: 60,
        maxRetries: 3,
        usedSteps: 2,
        usedRetries: 1
      },
      currentStepSummary: "백그라운드 strategist 브랜치가 끝나서 최신 저장 상태로 계속 진행합니다.",
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:04:00.000Z"
    };
    const step: AutomationStepRecord = {
      id: "AS001",
      sessionId: "AU001",
      threadId: "TH001",
      kind: "literature-search",
      lane: "strategist",
      workerMode: "async",
      title: "Run the next strategist research branch",
      prompt: "Review the latest local results.",
      status: "failed",
      summary: "Background strategist research ended without producing a usable answer.",
      startedSideEffects: [],
      completedSideEffects: [],
      changedFiles: [],
      evidence: [
        "Oracle strategist run completed without producing output."
      ],
      checkpointRequired: true,
      createdAt: "2026-03-26T00:02:00.000Z",
      updatedAt: "2026-03-26T00:03:00.000Z",
      completedAt: "2026-03-26T00:03:00.000Z"
    };
    const snapshot: ProjectSnapshot = {
      project: {
        id: "P001",
        name: "real",
        workspacePath: "/tmp",
        oracleModel: "gpt-5.4-pro",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-26T00:00:00.000Z",
        updatedAt: "2026-03-26T00:00:00.000Z"
      },
      memory: null,
      threads: [thread],
      activeThreadId: "TH001",
      activeThread: thread,
      conversationEntries: [],
      latestConversationEntry: null,
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
      automationSessions: [session],
      automationCycles: [],
      automationSteps: [step],
      automationCheckpoints: [],
      latestAutomationSession: session,
      latestAutomationCycle: null,
      latestAutomationCheckpoint: null,
      logs: []
    };

    const items = buildChatItems(snapshot, "/tmp");

    expect(items.some((item) => item.id === "automation-step-summary:AS001")).toBe(false);
  });

  it("collapses identical non-user automation messages that arrive back-to-back", () => {
    const thread: ThreadRecord = {
      id: "TH001",
      title: "Main thread",
      summary: "",
      createdAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z"
    };
    const duplicatedBody =
      "연구는 여기서 잠시 멈춰 두었습니다. 현재 확정 최고 기준선은 n7이고, 최근 n8 추적은 실패해서 기준선 변화는 없습니다.";
    const snapshot: ProjectSnapshot = {
      project: {
        id: "P001",
        name: "real",
        workspacePath: "/tmp",
        oracleModel: "gpt-5.4-pro",
        codexModel: "gpt-5.4",
        defaultThreadId: "TH001",
        activeThreadId: "TH001",
        createdAt: "2026-03-26T00:00:00.000Z",
        updatedAt: "2026-03-26T00:00:00.000Z"
      },
      memory: null,
      threads: [thread],
      activeThreadId: "TH001",
      activeThread: thread,
      conversationEntries: [
        {
          id: "C001",
          threadId: "TH001",
          role: "assistant",
          source: "automation",
          body: duplicatedBody,
          createdAt: "2026-03-26T00:01:00.000Z"
        },
        {
          id: "C002",
          threadId: "TH001",
          role: "assistant",
          source: "automation",
          body: duplicatedBody,
          createdAt: "2026-03-26T00:01:30.000Z"
        }
      ],
      latestConversationEntry: null,
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
      automationSessions: [],
      automationCycles: [],
      automationSteps: [],
      automationCheckpoints: [],
      latestAutomationSession: null,
      latestAutomationCycle: null,
      latestAutomationCheckpoint: null,
      logs: []
    };

    const items = buildChatItems(snapshot, "/tmp");
    const matchingItems = items.filter((item) => item.body === duplicatedBody);

    expect(matchingItems).toHaveLength(1);
  });
});
