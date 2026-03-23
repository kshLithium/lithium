import { describe, expect, it } from "vitest";
import { stripTerminalMarkers } from "./terminal-pty-markers";

describe("terminal PTY markers", () => {
  it("strips cwd OSC markers while keeping visible output", () => {
    const parsed = stripTerminalMarkers(
      "first line\r\n\u001b]633;cwd=/tmp/lithium/src\u0007prompt % "
    );

    expect(parsed.cwd).toBe("/tmp/lithium/src");
    expect(parsed.output).toBe("first line\r\nprompt % ");
    expect(parsed.pending).toBe("");
  });

  it("preserves partial markers until the next chunk", () => {
    const first = stripTerminalMarkers("before\u001b]633;c");
    const second = stripTerminalMarkers("wd=/tmp/work\u0007after", first.pending);

    expect(first.output).toBe("before");
    expect(first.pending).toBe("\u001b]633;c");
    expect(second.cwd).toBe("/tmp/work");
    expect(second.output).toBe("after");
    expect(second.pending).toBe("");
  });
});
