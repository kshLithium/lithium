import { describe, expect, it } from "vitest";
import { stripShellOutputMarkers } from "./shell-output-markers";

describe("shell output markers", () => {
  it("strips cwd OSC markers while keeping visible output", () => {
    const parsed = stripShellOutputMarkers(
      "first line\r\n\u001b]633;cwd=/tmp/lithium/src\u0007prompt % "
    );

    expect(parsed.cwd).toBe("/tmp/lithium/src");
    expect(parsed.output).toBe("first line\r\nprompt % ");
    expect(parsed.pending).toBe("");
  });

  it("preserves partial markers until the next chunk", () => {
    const first = stripShellOutputMarkers("before\u001b]633;c");
    const second = stripShellOutputMarkers("wd=/tmp/work\u0007after", first.pending);

    expect(first.output).toBe("before");
    expect(first.pending).toBe("\u001b]633;c");
    expect(second.cwd).toBe("/tmp/work");
    expect(second.output).toBe("after");
    expect(second.pending).toBe("");
  });
});
