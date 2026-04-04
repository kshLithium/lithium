import { describe, expect, it } from "vitest";
import {
  describeIncompletePlannerOutput,
  parseBuilderOutput,
  parseOracleOutput
} from "./protocol";

describe("protocol", () => {
  it("falls back to the visible planner text when no structured handoff is present", () => {
    const result = parseOracleOutput("short summary");

    expect(result).toMatchObject({
      role: "planner",
      summary: "short summary",
      rationale: "Oracle did not return a structured planning rationale."
    });
  });

  it("extracts planner handoff fields from the JSON marker block", () => {
    const result = parseOracleOutput([
      "Operator-facing note.",
      "",
      "LITHIUM_HANDOFF",
      JSON.stringify({
        summary: "tight summary",
        rationale: "it is the highest-value check",
        files: ["notes/plan.md"],
        risks: ["latest run may fail"],
        run_actions: ["execute svm dry run"],
        success_criteria: ["notes stay aligned"],
        open_questions: ["is the margin stable?"],
        proposed_branches: [
          {
            title: "Branch A",
            hypothesis: "The metric shift is real."
          }
        ],
        research_work_items: [
          {
            title: "Read the source",
            prompt: "Extract the core claim.",
            kind: "read_synthesize",
            executor: "reader-synthesizer",
            branch_title: "Branch A"
          },
          {
            title: "Ignore old alias",
            prompt: "Old aliases should be dropped.",
            kind: "deep-research",
            executor: "oracle-research"
          }
        ]
      })
    ].join("\n"));

    expect(result).toEqual({
      schemaVersion: "lithium_handoff_v1",
      role: "planner",
      summary: "tight summary",
      machineSummary: "tight summary",
      rationale: "it is the highest-value check",
      files: ["notes/plan.md"],
      risks: ["latest run may fail"],
      runActions: ["execute svm dry run"],
      successCriteria: ["notes stay aligned"],
      openQuestions: ["is the margin stable?"],
      proposedBranches: [
        {
          title: "Branch A",
          hypothesis: "The metric shift is real."
        }
      ],
      researchWorkItems: [
        {
          title: "Read the source",
          prompt: "Extract the core claim.",
          kind: "read_synthesize",
          executor: "reader-synthesizer",
          branchTitle: "Branch A"
        }
      ]
    });
  });

  it("extracts builder handoff fields from the JSON status block", () => {
    const result = parseBuilderOutput([
      "Implemented the fix and verified the build.",
      "",
      "LITHIUM_STATUS",
      JSON.stringify({
        summary: "research protocol cleanup",
        result: "success",
        files: ["src/main/services/research-service.ts", "src/main/services/protocol.ts"],
        risks: ["needs broader product evals"],
        run_actions: ["rerun compile"],
        success_criteria: ["tests pass"],
        open_questions: ["should compile auto-run?"]
      })
    ].join("\n"));

    expect(result).toEqual({
      schemaVersion: "lithium_handoff_v1",
      role: "builder",
      summary: "research protocol cleanup",
      machineSummary: "research protocol cleanup",
      rationale: "Builder did not return a structured result rationale.",
      result: "success",
      files: ["src/main/services/research-service.ts", "src/main/services/protocol.ts"],
      risks: ["needs broader product evals"],
      runActions: ["rerun compile"],
      successCriteria: ["tests pass"],
      openQuestions: ["should compile auto-run?"]
    });
  });

  it("prefers machine_summary when the builder emits it", () => {
    const result = parseBuilderOutput(
      '사용자에게 보여줄 본문입니다.\n\nLITHIUM_STATUS {"machine_summary":"internal handoff summary","result":"success"}'
    );

    expect(result).toMatchObject({
      summary: "internal handoff summary",
      machineSummary: "internal handoff summary",
      result: "success"
    });
  });

  it("flags obviously truncated planner outputs", () => {
    expect(describeIncompletePlannerOutput("I’m")).toContain("truncated or non-final");
    expect(describeIncompletePlannerOutput("Highest-priority research question:")).toContain(
      "truncated or non-final"
    );
    expect(
      describeIncompletePlannerOutput(
        "Does same-thread reuse preserve latency gains without unacceptable drift?"
      )
    ).toBeNull();
  });
});
