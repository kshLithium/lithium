import { describe, expect, it } from "vitest";
import { normalizeTerminalEvent } from "./terminal-runtime";

describe("terminal runtime", () => {
  it("keeps workspace identity on terminal events", () => {
    expect(
      normalizeTerminalEvent({
        type: "data",
        workspacePath: "/tmp/research-a",
        sessionId: "term001",
        data: "hello"
      })
    ).toEqual({
      type: "data",
      workspacePath: "/tmp/research-a",
      sessionId: "term001",
      data: "hello"
    });
  });

  it("rejects terminal events without workspace identity", () => {
    expect(
      normalizeTerminalEvent({
        type: "exit",
        sessionId: "term001",
        exitCode: 0
      })
    ).toBeNull();
  });
});
