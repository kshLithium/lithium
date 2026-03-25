import { describe, expect, it } from "vitest";
import {
  describeIncompleteStrategistOutput,
  parseBuilderOutput,
  parseOracleOutput,
  parseRouterOutput
} from "./protocol";

describe("protocol", () => {
  it("falls back to the visible strategist text when no structured handoff is present", () => {
    const result = parseOracleOutput("short summary");

    expect(result).toMatchObject({
      role: "strategist",
      summary: "short summary",
      rationale: "Oracle did not return a structured rationale."
    });
  });

  it("extracts strategist handoff fields from the JSON marker block", () => {
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
        open_questions: ["is the margin stable?"]
      })
    ].join("\n"));

    expect(result).toEqual({
      schemaVersion: "lithium_handoff_v1",
      role: "strategist",
      summary: "tight summary",
      machineSummary: "tight summary",
      userMessage: "Operator-facing note.",
      rationale: "it is the highest-value check",
      files: ["notes/plan.md"],
      risks: ["latest run may fail"],
      runActions: ["execute svm dry run"],
      successCriteria: ["notes stay aligned"],
      openQuestions: ["is the margin stable?"]
    });
  });

  it("extracts the strategist JSON block even when oracle appends trailing reference lines", () => {
    const result = parseOracleOutput([
      "운영 메모: local context is thin, so official sources were used.",
      "",
      "LITHIUM_HANDOFF",
      JSON.stringify({
        summary: "자연스럽게 정리된 최종 답변.",
        rationale: "The workspace had no local Overwatch notes."
      }),
      "",
      '[1]: https://example.com "Example source"'
    ].join("\n"));

    expect(result).toMatchObject({
      role: "strategist",
      summary: "자연스럽게 정리된 최종 답변.",
      machineSummary: "자연스럽게 정리된 최종 답변.",
      userMessage: "운영 메모: local context is thin, so official sources were used.",
      rationale: "The workspace had no local Overwatch notes."
    });
  });

  it("extracts builder handoff fields from the JSON status block", () => {
    const result = parseBuilderOutput([
      "Implemented the fix and verified the build.",
      "",
      "LITHIUM_STATUS",
      JSON.stringify({
        summary: "automation and protocol cleanup",
        result: "success",
        files: ["src/main/services/app-service.ts", "src/main/services/protocol.ts"],
        risks: ["needs broader product evals"],
        run_actions: ["rerun compile"],
        success_criteria: ["tests pass"],
        open_questions: ["should compile auto-run?"],
        automation_mode: "continue",
        needs_user_checkpoint: false
      })
    ].join("\n"));

    expect(result).toEqual({
      schemaVersion: "lithium_handoff_v1",
      role: "builder",
      summary: "automation and protocol cleanup",
      machineSummary: "automation and protocol cleanup",
      userMessage: "Implemented the fix and verified the build.",
      result: "success",
      files: ["src/main/services/app-service.ts", "src/main/services/protocol.ts"],
      risks: ["needs broader product evals"],
      runActions: ["rerun compile"],
      successCriteria: ["tests pass"],
      openQuestions: ["should compile auto-run?"],
      automationMode: "continue",
      needsUserCheckpoint: false
    });
  });

  it("keeps user_message and machine_summary separate when both are provided", () => {
    const result = parseBuilderOutput([
      "긴 자연어 본문입니다.",
      "",
      "LITHIUM_STATUS",
      JSON.stringify({
        user_message: "짧은 사용자 보고",
        machine_summary: "internal handoff summary",
        result: "partial"
      })
    ].join("\n"));

    expect(result).toMatchObject({
      summary: "internal handoff summary",
      machineSummary: "internal handoff summary",
      userMessage: "짧은 사용자 보고",
      result: "partial"
    });
  });

  it("accepts loose string lists inside strategist JSON handoffs", () => {
    const result = parseOracleOutput([
      "LITHIUM_HANDOFF",
      JSON.stringify({
        summary: "Use the local evidence first.",
        files: "notes/plan.md, results/latest.json",
        risks: "- latest run may fail\n- results may drift",
        run_actions: "rerun baseline",
        success_criteria: "notes stay in sync; summary stays grounded",
        open_questions: "is the baseline stable?"
      })
    ].join("\n"));

    expect(result).toMatchObject({
      files: ["notes/plan.md", "results/latest.json"],
      risks: ["latest run may fail", "results may drift"],
      runActions: ["rerun baseline"],
      successCriteria: ["notes stay in sync", "summary stays grounded"],
      openQuestions: ["is the baseline stable?"]
    });
  });

  it("accepts loose string lists inside builder JSON handoffs", () => {
    const result = parseBuilderOutput([
      "LITHIUM_STATUS",
      JSON.stringify({
        summary: "Adjusted the notes and reran the baseline.",
        result: "partial",
        files: "notes/summary.md\nresults/latest.json",
        risks: "validation warnings",
        run_actions: "rerun compile",
        success_criteria: "validation passes",
        open_questions: "should we keep the old chart?"
      })
    ].join("\n"));

    expect(result).toMatchObject({
      result: "partial",
      files: ["notes/summary.md", "results/latest.json"],
      risks: ["validation warnings"],
      runActions: ["rerun compile"],
      successCriteria: ["validation passes"],
      openQuestions: ["should we keep the old chart?"]
    });
  });

  it("falls back gracefully when strategist output is malformed", () => {
    const result = parseOracleOutput("Just one line without tags");

    expect(result.summary).toBe("Just one line without tags");
    expect(result.rationale).toContain("did not return");
  });

  it("uses the first meaningful paragraph instead of a markdown heading for strategist summaries", () => {
    const result = parseOracleOutput([
      "현재 가장 중요한 연구 질문은 이것입니다:",
      "",
      "## 핵심 가설",
      "",
      "**`reuse_policy`는 task shift와 evidence delta를 함께 보는 단일 휴리스틱으로 닫아야 한다.**",
      "no-shift는 reuse로 두고, evidence 변화가 큰 shift는 recompute로 보낸다."
    ].join("\n"));

    expect(result.summary).toBe(
      "**`reuse_policy`는 task shift와 evidence delta를 함께 보는 단일 휴리스틱으로 닫아야 한다.** no-shift는 reuse로 두고, evidence 변화가 큰 shift는 recompute로 보낸다."
    );
  });

  it("skips boilerplate completion-only paragraphs when extracting strategist summaries", () => {
    const result = parseOracleOutput([
      "완료했습니다.",
      "",
      "실험 산출물과 notes/results 문장을 다시 맞췄고, 지금 남은 질문은 threshold가 합성 케이스에만 맞춰진 것인지 확인하는 것이다."
    ].join("\n"));

    expect(result.summary).toBe(
      "실험 산출물과 notes/results 문장을 다시 맞췄고, 지금 남은 질문은 threshold가 합성 케이스에만 맞춰진 것인지 확인하는 것이다."
    );
  });

  it("flags obviously truncated strategist outputs before they poison project memory", () => {
    expect(describeIncompleteStrategistOutput("I’m")).toContain("truncated or non-final");
    expect(describeIncompleteStrategistOutput("Highest-priority research question:")).toContain(
      "truncated or non-final"
    );
    expect(
      describeIncompleteStrategistOutput("Does same-thread reuse preserve latency gains without unacceptable drift?")
    ).toBeNull();
    expect(
      describeIncompleteStrategistOutput([
        "LITHIUM_HANDOFF",
        JSON.stringify({
          summary: "Use the same-thread comparison first."
        })
      ].join("\n"))
    ).toBeNull();
  });

  it("extracts router decisions from the JSON marker block", () => {
    const result = parseRouterOutput([
      "LITHIUM_ROUTE",
      JSON.stringify({
        route: "builder",
        rewritten_prompt: "Update notes/summary.md with the requested revision.",
        reason_short: "The user asked for a concrete workspace edit."
      })
    ].join("\n"));

    expect(result).toEqual({
      route: "builder",
      rewrittenPrompt: "Update notes/summary.md with the requested revision.",
      reasonShort: "The user asked for a concrete workspace edit."
    });
  });

  it("extracts router decisions from a bare JSON block", () => {
    const result = parseRouterOutput(
      JSON.stringify({
        route: "strategist",
        rewritten_prompt: "Compare the literature and decide the next experiment.",
        reason_short: "This is a research judgment call."
      })
    );

    expect(result).toEqual({
      route: "strategist",
      rewrittenPrompt: "Compare the literature and decide the next experiment.",
      reasonShort: "This is a research judgment call."
    });
  });

  it("extracts mixed router decisions when the router returns a mixed route", () => {
    const result = parseRouterOutput(
      JSON.stringify({
        route: "mixed",
        rewritten_prompt: "Research first, then code.",
        reason_short: "This should be treated as a mixed planning signal."
      })
    );

    expect(result).toEqual({
      route: "mixed",
      rewrittenPrompt: "Research first, then code.",
      reasonShort: "This should be treated as a mixed planning signal."
    });
  });

  it("ignores unrelated strategist JSON fields while keeping the main handoff data", () => {
    const result = parseOracleOutput([
      "LITHIUM_HANDOFF",
      JSON.stringify({
        summary: "Use the same-thread comparison first.",
        debug_note: "temporary extra field",
        rationale: "The summary and rationale should still survive."
      })
    ].join("\n"));

    expect(result).toEqual({
      schemaVersion: "lithium_handoff_v1",
      role: "strategist",
      summary: "Use the same-thread comparison first.",
      machineSummary: "Use the same-thread comparison first.",
      rationale: "The summary and rationale should still survive.",
      files: [],
      risks: [],
      runActions: [],
      successCriteria: [],
      openQuestions: []
    });
  });
});
