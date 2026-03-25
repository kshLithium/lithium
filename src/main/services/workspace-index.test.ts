import { describe, expect, it } from "vitest";
import { classifyWorkspaceFile } from "./workspace-index";

describe("classifyWorkspaceFile", () => {
  it("treats plain text and logs as lightweight artifacts", () => {
    expect(classifyWorkspaceFile("/tmp/notes.md")).toEqual({
      kind: "artifact",
      artifactKind: "text"
    });
    expect(classifyWorkspaceFile("/tmp/run.log")).toEqual({
      kind: "artifact",
      artifactKind: "log"
    });
  });

  it("groups document files into one generic document artifact kind", () => {
    expect(classifyWorkspaceFile("/tmp/report.pdf")).toEqual({
      kind: "artifact",
      artifactKind: "document"
    });
    expect(classifyWorkspaceFile("/tmp/slides.pptx")).toEqual({
      kind: "artifact",
      artifactKind: "document"
    });
    expect(classifyWorkspaceFile("/tmp/table.xlsx")).toEqual({
      kind: "artifact",
      artifactKind: "document"
    });
  });
});
