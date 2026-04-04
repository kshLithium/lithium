import { describe, expect, it } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../../shared/types";
import { sanitizeAppSettings, sanitizePromptLanguage } from "./app-settings-store";

describe("AppSettingsStore sanitizers", () => {
  it("defaults autopilot prompt language to auto", () => {
    expect(sanitizePromptLanguage(undefined)).toBe("auto");
    expect(sanitizeAppSettings({})).toMatchObject({
      promptLanguage: DEFAULT_APP_SETTINGS.promptLanguage
    });
  });

  it("preserves valid autopilot prompt language values", () => {
    expect(sanitizePromptLanguage("ko")).toBe("ko");
    expect(sanitizePromptLanguage("en")).toBe("en");
    expect(sanitizePromptLanguage("auto")).toBe("auto");
  });

  it("falls back to auto for invalid autopilot prompt language values", () => {
    expect(sanitizePromptLanguage("jp")).toBe("auto");
    expect(
      sanitizeAppSettings({
        promptLanguage: "jp"
      }).promptLanguage
    ).toBe("auto");
  });

  it("defaults strategist settings to Pro extended", () => {
    expect(DEFAULT_APP_SETTINGS.oracleModel).toBe("gpt-5.4-pro");
    expect(DEFAULT_APP_SETTINGS.oracleThinkingTime).toBe("extended");
    expect(sanitizeAppSettings({})).toMatchObject({
      oracleModel: "gpt-5.4-pro",
      oracleThinkingTime: "extended"
    });
  });

  it("normalizes legacy strategist settings to Pro extended", () => {
    expect(
      sanitizeAppSettings({
        oracleModel: "legacy-model",
        oracleThinkingTime: "legacy-intensity"
      })
    ).toMatchObject({
      oracleModel: "gpt-5.4-pro",
      oracleThinkingTime: "extended"
    });
  });
});
