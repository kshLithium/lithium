import { describe, expect, it } from "vitest";
import { parseSyncTeX, parseSyncTeXSourceLocation } from "./synctex";

describe("synctex", () => {
  it("maps a source line to a pdf page and offset ratio", () => {
    const sourcePath = "/tmp/paper/main.tex";
    const content = [
      "SyncTeX Version:1",
      `Input:1:${sourcePath}`,
      "Output:pdf",
      "Content:",
      "{1",
      "h1,10:100,1000:0,0,0",
      "h1,12:100,2000:0,0,0",
      "}",
      "{2",
      "h1,30:100,5000:0,0,0",
      "h1,45:100,9000:0,0,0",
      "}"
    ].join("\n");

    expect(parseSyncTeX(content, sourcePath, 11)).toEqual({
      pageNumber: 1,
      yRatio: 0.5
    });

    expect(parseSyncTeX(content, sourcePath, 44)).toEqual({
      pageNumber: 2,
      yRatio: 1
    });
  });

  it("returns null when no matching source tag exists", () => {
    const content = ["SyncTeX Version:1", "Input:1:/tmp/other.tex", "Content:", "{1", "h1,1:100,1000:0,0,0"].join(
      "\n"
    );

    expect(parseSyncTeX(content, "/tmp/main.tex", 1)).toBeNull();
  });

  it("maps a pdf page offset back to the closest source line", () => {
    const sourcePath = "/tmp/paper/main.tex";
    const content = [
      "SyncTeX Version:1",
      `Input:1:${sourcePath}`,
      "Output:pdf",
      "Content:",
      "{1",
      "h1,10:100,1000:0,0,0",
      "h1,12:100,2000:0,0,0",
      "}",
      "{2",
      "h1,30:100,5000:0,0,0",
      "h1,45:100,9000:0,0,0",
      "}"
    ].join("\n");

    expect(parseSyncTeXSourceLocation(content, 2, 0.98)).toEqual({
      sourcePath,
      lineNumber: 45
    });
  });
});
