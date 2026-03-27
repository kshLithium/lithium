import { describe, expect, it } from "vitest";
import {
  getStrategistModelDisplayLabel,
  getStrategistPerspectiveLabel,
  getStrategistThinkingOptions,
  STRATEGIST_MODEL_OPTIONS
} from "./model-config";

describe("strategist model config", () => {
  it("exposes ChatGPT-web-facing strategist labels", () => {
    expect(getStrategistModelDisplayLabel("gpt-5.4-pro")).toBe("Pro");
    expect(getStrategistPerspectiveLabel("gpt-5.4-pro")).toBe("Pro strategist");
    expect(STRATEGIST_MODEL_OPTIONS).toEqual([{ value: "gpt-5.4-pro", label: "Pro" }]);
  });

  it("keeps extended as the only strategist thinking option", () => {
    expect(getStrategistThinkingOptions("gpt-5.4-pro")).toEqual([
      { value: "extended", label: "Extended" }
    ]);
  });
});
