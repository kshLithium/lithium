import { describe, expect, it } from "vitest";
import type { ProjectSnapshot, RunRecord } from "../shared/types";
import {
  canSubmitComposerPrompt,
  describeBusyChatState,
  isPendingChatVisible,
  promptRequestsCodeSurface,
  promptRequestsPaperSurface,
  resolveAutomationObjective,
  resolveLatestTaskPrompt,
  shouldAutoOpenCodeSurface,
  shouldAutoOpenPaperSurface,
  UNASSIGNED_PENDING_THREAD_ID
} from "./chat-surface";

describe("chat surface", () => {
  it("describes busy chat states with user-facing copy", () => {
    expect(describeBusyChatState("Opening ChatGPT sign-in")).toBe("Opening the ChatGPT sign-in flow…");
    expect(describeBusyChatState("Running strategist browser probe")).toBe("Running the strategist browser probe…");
    expect(describeBusyChatState("Importing attachments")).toBe("Adding the attachment…");
    expect(describeBusyChatState("Something else")).toBe("Working…");
  });

  it("prefers the queued strategist task over stale composer text", () => {
    expect(resolveLatestTaskPrompt("  Run the builder task next.  ", "old draft")).toBe(
      "Run the builder task next."
    );
    expect(resolveLatestTaskPrompt("", "  fallback composer text  ")).toBe("fallback composer text");
  });

  it("only allows slash-only composer prompts when they can execute immediately", () => {
    expect(canSubmitComposerPrompt("Explain the current results.", "")).toBe(true);
    expect(canSubmitComposerPrompt("/research", "Inspect logs")).toBe(false);
    expect(canSubmitComposerPrompt("/mixed   ", "Inspect logs")).toBe(false);
    expect(canSubmitComposerPrompt("/plan", "Inspect logs")).toBe(false);
    expect(canSubmitComposerPrompt("/build", "Inspect the failed run logs.")).toBe(true);
    expect(canSubmitComposerPrompt("/build", "")).toBe(false);
  });

  it("prefers explicit research goals for automation but falls back to live thread context over the generic default", () => {
    expect(
      resolveAutomationObjective({
        project: { name: "Probe project" } as ProjectSnapshot["project"],
        memory: { researchGoal: "Ship the ablation report first." } as ProjectSnapshot["memory"],
        activeThread: { summary: "Investigate the preview reuse trade-off." } as ProjectSnapshot["activeThread"],
        latestDecision: { summary: "Summarize the README-driven next step." } as ProjectSnapshot["latestDecision"],
        latestAutomationSession: null
      })
    ).toBe("Ship the ablation report first.");

    expect(
      resolveAutomationObjective({
        project: { name: "Probe project" } as ProjectSnapshot["project"],
        memory: {
          researchGoal: "Define the next research outcome this project should produce."
        } as ProjectSnapshot["memory"],
        activeThread: { summary: "Investigate the preview reuse trade-off." } as ProjectSnapshot["activeThread"],
        latestDecision: { summary: "Summarize the README-driven next step." } as ProjectSnapshot["latestDecision"],
        latestAutomationSession: null
      })
    ).toBe("Investigate the preview reuse trade-off.");
  });

  it("prefers the latest session display objective over the canonical internal objective", () => {
    expect(
      resolveAutomationObjective({
        project: { name: "Probe project" } as ProjectSnapshot["project"],
        memory: null,
        activeThread: null,
        latestDecision: null,
        latestAutomationSession: {
          objective:
            "parameter-golf 프로젝트에서 이 맥북에어 M2 8GB 환경 기준으로 자동 연구를 시작해줘.\n\n목표:\n- baseline 1~2개 실행",
          displayObjective: "연구 자동화 다시 시작 이어서"
        } as ProjectSnapshot["latestAutomationSession"]
      })
    ).toBe("연구 자동화 다시 시작 이어서");
  });

  it("shows pending chat state only on the active thread", () => {
    expect(isPendingChatVisible("TH001", "TH001")).toBe(true);
    expect(isPendingChatVisible("TH001", "TH002")).toBe(false);
    expect(isPendingChatVisible("TH001", null)).toBe(false);
    expect(isPendingChatVisible(null, "TH001")).toBe(false);
    expect(isPendingChatVisible(UNASSIGNED_PENDING_THREAD_ID, null)).toBe(true);
    expect(isPendingChatVisible(UNASSIGNED_PENDING_THREAD_ID, "TH001")).toBe(true);
  });

  it("detects explicit paper and code surface requests", () => {
    expect(promptRequestsPaperSurface("Open the manuscript and update the abstract.")).toBe(true);
    expect(promptRequestsPaperSurface("Inspect src/app.ts")).toBe(false);
    expect(promptRequestsCodeSurface("Open the code editor for this file.")).toBe(true);
    expect(promptRequestsCodeSurface("Compile the bibliography.")).toBe(false);
  });

  it("opens the paper surface for paper-oriented changes", () => {
    expect(shouldAutoOpenPaperSurface({ latestRun: createRun({ changedFiles: ["paper/main.tex"] }) })).toBe(true);
    expect(shouldAutoOpenPaperSurface({ latestRun: createRun({ changedFiles: ["src/app.ts"] }) })).toBe(false);
  });

  it("opens the code surface for code changes but not local paper compiles", () => {
    expect(shouldAutoOpenCodeSurface({ latestRun: createRun({ changedFiles: ["src/app.ts"] }) })).toBe(true);
    expect(
      shouldAutoOpenCodeSurface({
        latestRun: createRun({
          model: "tectonic",
          changedFiles: ["paper/main.pdf"]
        })
      })
    ).toBe(false);
    expect(
      shouldAutoOpenCodeSurface({
        latestRun: createRun({
          changedFiles: ["paper/main.tex", "paper/main.pdf"]
        })
      })
    ).toBe(false);
  });
});

function createRun(overrides: Partial<RunRecord> = {}): ProjectSnapshot["latestRun"] {
  return {
    id: "R001",
    threadId: "TH001",
    taskId: "T001",
    prompt: "Run the task",
    model: "gpt-5.4",
    status: "completed",
    exitCode: 0,
    pid: null,
    command: { command: "codex", args: ["exec"], cwd: "/tmp/workspace" },
    stdoutPath: "/tmp/workspace/.lithium/runs/R001.stdout.log",
    stderrPath: "/tmp/workspace/.lithium/runs/R001.stderr.log",
    finalMessagePath: "/tmp/workspace/.lithium/runs/R001.output.txt",
    finalMessage: "",
    changedFiles: [],
    finalization: "auto",
    createdAt: "2026-03-20T00:00:00.000Z",
    startedAt: "2026-03-20T00:00:00.000Z",
    endedAt: "2026-03-20T00:00:01.000Z",
    ...overrides
  };
}
