import { describe, expect, it } from "vitest";
import {
  getOracleModelDisplayLabel,
  getOraclePerspectiveLabel,
  getOracleThinkingOptions,
  ORACLE_MODEL_OPTIONS
} from "./model-config";

describe("oracle model config", () => {
  it("exposes research-facing oracle labels", () => {
    expect(getOracleModelDisplayLabel("gpt-5.4-pro")).toBe("Pro");
    expect(getOraclePerspectiveLabel("gpt-5.4-pro")).toBe("Pro planner");
    expect(ORACLE_MODEL_OPTIONS).toEqual([{ value: "gpt-5.4-pro", label: "Pro" }]);
  });

  it("keeps extended as the only oracle thinking option", () => {
    expect(getOracleThinkingOptions("gpt-5.4-pro")).toEqual([
      { value: "extended", label: "Extended" }
    ]);
  });
});
