import { describe, expect, it } from "vitest";
import { joinTerminalOutput, parseTerminalCapture, wrapTerminalCommand } from "./terminal-session";

describe("terminal-session helpers", () => {
  it("wraps terminal commands with a cwd marker", () => {
    expect(wrapTerminalCommand("pwd")).toContain("__LITHIUM_CWD__:");
  });

  it("extracts the updated cwd while keeping visible output clean", () => {
    const parsed = parseTerminalCapture(
      "line one\nline two\n__LITHIUM_CWD__:/tmp/workspace/src\n",
      "warning line\n",
      "/tmp/workspace"
    );

    expect(parsed.cwd).toBe("/tmp/workspace/src");
    expect(parsed.stdout).toBe("line one\nline two");
    expect(parsed.stderr).toBe("warning line");
    expect(parsed.output).toBe("line one\nline two\nwarning line");
  });

  it("joins stdout and stderr without empty separators", () => {
    expect(joinTerminalOutput("stdout line", "")).toBe("stdout line");
    expect(joinTerminalOutput("", "stderr line")).toBe("stderr line");
    expect(joinTerminalOutput("stdout line", "stderr line")).toBe("stdout line\nstderr line");
  });
});
