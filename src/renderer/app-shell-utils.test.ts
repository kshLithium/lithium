import { describe, expect, it } from "vitest";
import { describeBusyAction, isPendingChatVisible, summarizeWorkspacePath } from "./app-shell-utils";

describe("app-shell-utils", () => {
  it("shows pending chat items for the unassigned placeholder thread", () => {
    expect(isPendingChatVisible("__pending__", null)).toBe(true);
  });

  it("only shows pending chat items for the active thread", () => {
    expect(isPendingChatVisible("TH001", "TH001")).toBe(true);
    expect(isPendingChatVisible("TH001", "TH002")).toBe(false);
  });

  it("describes busy actions with user-facing copy", () => {
    expect(describeBusyAction("Importing attachments")).toBe("Updating thread attachments…");
    expect(describeBusyAction("Running automation")).toBe("Updating the automation loop…");
    expect(describeBusyAction("Something else")).toBe("Working…");
  });

  it("summarizes workspace paths by their final segment", () => {
    expect(summarizeWorkspacePath("/tmp/demo-workspace/")).toBe("demo-workspace");
    expect(summarizeWorkspacePath("")).toBe("");
  });
});
