import { describe, expect, it } from "vitest";
import type { ChatProgressInspection } from "../shared/types";
import type { ChatItem } from "./app-types";
import { formatLiveProgressBody, mergeTransientChatItems } from "./app-utils";
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
