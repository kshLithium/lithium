import { describe, expect, it } from "vitest";
import {
  describeIncompleteStrategistOutput,
  parseBuilderOutput,
  parseOracleOutput,
  parseRouterOutput
} from "./protocol";

describe("protocol", () => {
  it("extracts strategist handoff fields from the legacy tagged format", () => {
    const result = parseOracleOutput([
      "SUMMARY: short summary",
      "NEXT_TASK: do the next thing",
      "RATIONALE: because it matters"
    ].join("\n"));

    expect(result).toMatchObject({
      role: "strategist",
      summary: "short summary",
      rationale: "because it matters"
    });
  });

  it("extracts strategist handoff fields from the JSON marker block", () => {
    const result = parseOracleOutput([
      "Operator-facing note.",
      "",
      "LITHIUM_HANDOFF",
      JSON.stringify({
        summary: "tight summary",
        next_task: "run the next experiment",
        rationale: "it is the highest-value check",
        files: ["paper/main.tex"],
        risks: ["compile may fail"],
        paper_actions: ["update methods"],
        run_actions: ["execute svm dry run"],
        success_criteria: ["paper compiles"],
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
      files: ["paper/main.tex"],
      risks: ["compile may fail"],
      paperActions: ["update methods"],
      runActions: ["execute svm dry run"],
      successCriteria: ["paper compiles"],
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
        next_task: "필요하면 초보자용 치트시트로 압축한다.",
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
        summary: "terminal and protocol cleanup",
        result: "success",
        files: ["src/main/services/app-service.ts", "src/main/services/protocol.ts"],
        risks: ["needs broader product evals"],
        paper_actions: ["sync results section"],
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
      summary: "terminal and protocol cleanup",
      machineSummary: "terminal and protocol cleanup",
      userMessage: "Implemented the fix and verified the build.",
      result: "success",
      files: ["src/main/services/app-service.ts", "src/main/services/protocol.ts"],
      risks: ["needs broader product evals"],
      paperActions: ["sync results section"],
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
        next_task: "Update the local notes.",
        files: "paper/main.tex, notes/plan.md",
        risks: "- compile may fail\n- results may drift",
        paper_actions: "update methods | update results",
        run_actions: "rerun baseline",
        success_criteria: "paper compiles; notes stay in sync",
        open_questions: "is the baseline stable?"
      })
    ].join("\n"));

    expect(result).toMatchObject({
      files: ["paper/main.tex", "notes/plan.md"],
      risks: ["compile may fail", "results may drift"],
      paperActions: ["update methods", "update results"],
      runActions: ["rerun baseline"],
      successCriteria: ["paper compiles", "notes stay in sync"],
      openQuestions: ["is the baseline stable?"]
    });
  });

  it("accepts loose string lists inside builder JSON handoffs", () => {
    const result = parseBuilderOutput([
      "LITHIUM_STATUS",
      JSON.stringify({
        summary: "Adjusted the draft and reran the baseline.",
        result: "partial",
        files: "paper/main.tex\nresults/latest.json",
        risks: "compile warnings",
        paper_actions: "revise abstract",
        run_actions: "rerun compile",
        success_criteria: "paper compiles",
        open_questions: "should we keep the old chart?"
      })
    ].join("\n"));

    expect(result).toMatchObject({
      result: "partial",
      files: ["paper/main.tex", "results/latest.json"],
      risks: ["compile warnings"],
      paperActions: ["revise abstract"],
      runActions: ["rerun compile"],
      successCriteria: ["paper compiles"],
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
      "실험 산출물과 notes/paper 문장을 다시 맞췄고, 지금 남은 질문은 threshold가 합성 케이스에만 맞춰진 것인지 확인하는 것이다."
    ].join("\n"));

    expect(result.summary).toBe(
      "실험 산출물과 notes/paper 문장을 다시 맞췄고, 지금 남은 질문은 threshold가 합성 케이스에만 맞춰진 것인지 확인하는 것이다."
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
          summary: "Use the same-thread comparison first.",
          next_task: "Update notes/experiment-plan.md with the bounded benchmark."
        })
      ].join("\n"))
    ).toBeNull();
  });

  it("extracts router decisions from the JSON marker block", () => {
    const result = parseRouterOutput([
      "LITHIUM_ROUTE",
      JSON.stringify({
        route: "builder",
        rewritten_prompt: "Update paper/main.tex with the requested abstract revision.",
        reason_short: "The user asked for a concrete manuscript edit."
      })
    ].join("\n"));

    expect(result).toEqual({
      route: "builder",
      rewrittenPrompt: "Update paper/main.tex with the requested abstract revision.",
      reasonShort: "The user asked for a concrete manuscript edit."
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

  it("ignores legacy next_task fields while keeping the rest of the strategist handoff", () => {
    const result = parseOracleOutput([
      "LITHIUM_HANDOFF",
      JSON.stringify({
        summary: "Use the same-thread comparison first.",
        next_task: "Update notes/experiment-plan.md with the bounded benchmark.",
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
      paperActions: [],
      runActions: [],
      successCriteria: [],
      openQuestions: []
    });
  });
});
