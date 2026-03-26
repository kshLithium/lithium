import { describe, expect, it } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../../shared/types";
import { sanitizeAppSettings, sanitizeAutomationPromptLanguage } from "./app-settings-store";

describe("AppSettingsStore sanitizers", () => {
  it("defaults autopilot prompt language to auto", () => {
    expect(sanitizeAutomationPromptLanguage(undefined)).toBe("auto");
    expect(sanitizeAppSettings({})).toMatchObject({
      autopilotPromptLanguage: DEFAULT_APP_SETTINGS.autopilotPromptLanguage
    });
  });

  it("preserves valid autopilot prompt language values", () => {
    expect(sanitizeAutomationPromptLanguage("ko")).toBe("ko");
    expect(sanitizeAutomationPromptLanguage("en")).toBe("en");
    expect(sanitizeAutomationPromptLanguage("auto")).toBe("auto");
  });

  it("falls back to auto for invalid autopilot prompt language values", () => {
    expect(sanitizeAutomationPromptLanguage("jp")).toBe("auto");
    expect(
      sanitizeAppSettings({
        autopilotPromptLanguage: "jp"
      }).autopilotPromptLanguage
    ).toBe("auto");
  });

  it("defaults strategist settings to GPT-5.4 Pro extended", () => {
    expect(DEFAULT_APP_SETTINGS.strategistModel).toBe("gpt-5.4-pro");
    expect(DEFAULT_APP_SETTINGS.strategistReasoningIntensity).toBe("extended");
    expect(sanitizeAppSettings({})).toMatchObject({
      strategistModel: "gpt-5.4-pro",
      strategistReasoningIntensity: "extended"
    });
  });

  it("normalizes legacy strategist settings to GPT-5.4 Pro extended", () => {
    expect(
      sanitizeAppSettings({
        strategistModel: "gpt-5.4",
        strategistReasoningIntensity: "heavy"
      })
    ).toMatchObject({
      strategistModel: "gpt-5.4-pro",
      strategistReasoningIntensity: "extended"
    });
  });
});
