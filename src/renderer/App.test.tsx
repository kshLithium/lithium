import { describe, expect, it } from "vitest";
import type { ChatProgressInspection } from "../shared/types";
import { stabilizeChatProgress } from "./chat-progress";

function buildProgress(
  input: Partial<ChatProgressInspection> = {}
): ChatProgressInspection {
  return {
    active: true,
    lane: "orchestrator",
    threadId: "TH001",
    progressSummary: "Thinking…",
    progressDetails: ["Reviewing the latest thread state and choosing the next move."],
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
});
