import { describe, expect, it } from "vitest";
import type { CodeTab } from "./app-types";
import { invalidateCodeTabsForWorkspaceRefresh } from "./useCodeWorkbenchState";

describe("invalidateCodeTabsForWorkspaceRefresh", () => {
  it("marks only clean loaded tabs for reload after an external workspace refresh", () => {
    const tabs: CodeTab[] = [
      {
        path: "src/clean.ts",
        label: "clean.ts",
        filePath: "src/clean.ts",
        draft: "const clean = true;\n",
        dirty: false,
        isPreview: false,
        loaded: true,
        isUntitled: false
      },
      {
        path: "src/dirty.ts",
        label: "dirty.ts",
        filePath: "src/dirty.ts",
        draft: "const dirty = true;\n",
        dirty: true,
        isPreview: false,
        loaded: true,
        isUntitled: false
      },
      {
        path: "__untitled__/1",
        label: "Untitled",
        filePath: null,
        draft: "",
        dirty: false,
        isPreview: false,
        loaded: true,
        isUntitled: true
      }
    ];

    expect(invalidateCodeTabsForWorkspaceRefresh(tabs)).toEqual([
      {
        ...tabs[0],
        loaded: false
      },
      tabs[1],
      tabs[2]
    ]);
  });
});
