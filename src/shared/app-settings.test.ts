import { describe, expect, it } from "vitest";
import {
  clampCodeCanvasWidth,
  clampPaperPreviewWidth,
  clampSidebarWidth,
  sanitizeCodeCanvasWidth,
  sanitizePaperPreviewWidth,
  sanitizeSidebarWidth
} from "./app-settings";
import { DEFAULT_APP_SETTINGS } from "./types";

describe("shared app setting width helpers", () => {
  it("clamps widths to their supported ranges", () => {
    expect(clampSidebarWidth(10)).toBe(180);
    expect(clampSidebarWidth(999)).toBe(320);
    expect(clampCodeCanvasWidth(10)).toBe(320);
    expect(clampCodeCanvasWidth(2000)).toBe(960);
    expect(clampPaperPreviewWidth(10)).toBe(420);
    expect(clampPaperPreviewWidth(2000)).toBe(1280);
  });

  it("falls back to defaults for invalid persisted values", () => {
    expect(sanitizeSidebarWidth(undefined)).toBe(DEFAULT_APP_SETTINGS.sidebarWidth);
    expect(sanitizeCodeCanvasWidth(NaN)).toBe(DEFAULT_APP_SETTINGS.codeCanvasWidth);
    expect(sanitizePaperPreviewWidth("wide")).toBe(DEFAULT_APP_SETTINGS.paperPreviewWidth);
  });
});
