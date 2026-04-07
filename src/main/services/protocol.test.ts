import { describe, expect, it } from "vitest";
import {
  LITHIUM_EVALUATION_MARKER,
  LITHIUM_PLAN_MARKER,
  LITHIUM_STATUS_MARKER,
  parseBuilderStatus,
  parseEvaluatorDecision,
  parsePlannerOutput
} from "./protocol";

describe("protocol parsing", () => {
  it("fails planner parsing when required structured fields are missing", () => {
    const result = parsePlannerOutput(`${LITHIUM_PLAN_MARKER}\n{"summary":"ok"}`);
    expect(result.ok).toBe(false);
  });

  it("fails builder parsing when result tag is invalid", () => {
    const result = parseBuilderStatus(
      `${LITHIUM_STATUS_MARKER}\n{"machine_summary":"done","result":"unknown"}`
    );
    expect(result.ok).toBe(false);
  });

  it("fails evaluator parsing when verdict is invalid", () => {
    const result = parseEvaluatorDecision(
      `${LITHIUM_EVALUATION_MARKER}\n{"verdict":"ship","gateStatus":"passed","scoreDelta":1,"summary":"ok","rationale":"ok"}`
    );
    expect(result.ok).toBe(false);
  });
});
