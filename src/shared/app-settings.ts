import { DEFAULT_APP_SETTINGS } from "./types";

type NumericSettingRange = {
  min: number;
  max: number;
  fallback: number;
};

export const APP_SETTING_WIDTH_RANGES = {
  sidebarWidth: {
    min: 180,
    max: 320,
    fallback: DEFAULT_APP_SETTINGS.sidebarWidth
  },
  codeCanvasWidth: {
    min: 320,
    max: 960,
    fallback: DEFAULT_APP_SETTINGS.codeCanvasWidth
  },
  paperPreviewWidth: {
    min: 420,
    max: 1280,
    fallback: DEFAULT_APP_SETTINGS.paperPreviewWidth
  }
} satisfies Record<"sidebarWidth" | "codeCanvasWidth" | "paperPreviewWidth", NumericSettingRange>;

export function clampSidebarWidth(value: number) {
  return clampNumericSetting(value, APP_SETTING_WIDTH_RANGES.sidebarWidth);
}

export function clampCodeCanvasWidth(value: number) {
  return clampNumericSetting(value, APP_SETTING_WIDTH_RANGES.codeCanvasWidth);
}

export function clampPaperPreviewWidth(value: number) {
  return clampNumericSetting(value, APP_SETTING_WIDTH_RANGES.paperPreviewWidth);
}

export function sanitizeSidebarWidth(value: unknown) {
  return sanitizeNumericSetting(value, APP_SETTING_WIDTH_RANGES.sidebarWidth);
}

export function sanitizeCodeCanvasWidth(value: unknown) {
  return sanitizeNumericSetting(value, APP_SETTING_WIDTH_RANGES.codeCanvasWidth);
}

export function sanitizePaperPreviewWidth(value: unknown) {
  return sanitizeNumericSetting(value, APP_SETTING_WIDTH_RANGES.paperPreviewWidth);
}

function sanitizeNumericSetting(value: unknown, range: NumericSettingRange) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return range.fallback;
  }

  return clampNumericSetting(value, range);
}

function clampNumericSetting(value: number, range: NumericSettingRange) {
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}
