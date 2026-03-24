import { describe, expect, it } from "vitest";
import type { EditorState } from "@codemirror/state";
import { rememberEditorState } from "./state-cache";

describe("editor state cache", () => {
  it("keeps only the most recent entries within the cache limit", () => {
    const cache = new Map<string, EditorState>();

    rememberEditorState(cache, "alpha.ts", {} as EditorState, 2);
    rememberEditorState(cache, "beta.ts", {} as EditorState, 2);
    rememberEditorState(cache, "gamma.ts", {} as EditorState, 2);

    expect(Array.from(cache.keys())).toEqual(["beta.ts", "gamma.ts"]);
  });

  it("refreshes existing entries so recent tabs stay cached", () => {
    const cache = new Map<string, EditorState>();

    rememberEditorState(cache, "alpha.ts", {} as EditorState, 2);
    rememberEditorState(cache, "beta.ts", {} as EditorState, 2);
    rememberEditorState(cache, "alpha.ts", {} as EditorState, 2);
    rememberEditorState(cache, "gamma.ts", {} as EditorState, 2);

    expect(Array.from(cache.keys())).toEqual(["alpha.ts", "gamma.ts"]);
  });
});
