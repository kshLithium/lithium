import { describe, expect, it } from "vitest";
import type { ThreadRecord } from "../shared/types";
import {
  buildThreadSeenStorageKey,
  isThreadUnread,
  mergeThreadSeenState,
  readThreadSeenState,
  seedThreadSeenState
} from "./useThreadSeenState";

function buildThread(id: string, updatedAt: string): ThreadRecord {
  return {
    id,
    title: `Thread ${id}`,
    summary: "",
    createdAt: updatedAt,
    updatedAt
  };
}

describe("useThreadSeenState helpers", () => {
  it("builds a stable localStorage key per workspace", () => {
    expect(buildThreadSeenStorageKey("/tmp/workspace")).toBe("lithium:thread-seen:%2Ftmp%2Fworkspace");
  });

  it("seeds and merges thread timestamps without overwriting existing seen markers", () => {
    const threads = [
      buildThread("alpha", "2026-03-25T01:00:00.000Z"),
      buildThread("beta", "2026-03-25T02:00:00.000Z")
    ];

    expect(seedThreadSeenState(threads)).toEqual({
      alpha: "2026-03-25T01:00:00.000Z",
      beta: "2026-03-25T02:00:00.000Z"
    });
    expect(
      mergeThreadSeenState(
        {
          alpha: "2026-03-26T01:00:00.000Z"
        },
        threads
      )
    ).toEqual({
      alpha: "2026-03-26T01:00:00.000Z",
      beta: "2026-03-25T02:00:00.000Z"
    });
  });

  it("falls back cleanly when stored thread-seen state is missing or invalid", () => {
    const threads = [buildThread("alpha", "2026-03-25T01:00:00.000Z")];

    expect(readThreadSeenState(null, threads)).toEqual({
      alpha: "2026-03-25T01:00:00.000Z"
    });
    expect(readThreadSeenState("{not-json", threads)).toEqual({
      alpha: "2026-03-25T01:00:00.000Z"
    });
  });

  it("detects unread threads from updated timestamps", () => {
    expect(isThreadUnread(undefined, "2026-03-25T01:00:00.000Z")).toBe(false);
    expect(isThreadUnread("2026-03-25T01:00:00.000Z", "2026-03-25T02:00:00.000Z")).toBe(true);
    expect(isThreadUnread("2026-03-25T02:00:00.000Z", "2026-03-25T01:00:00.000Z")).toBe(false);
  });
});
