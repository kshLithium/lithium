import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexRunner } from "./codex-runner";

describe("CodexRunner", () => {
  it("frames builder prompts as natural chat replies instead of terse operator logs", () => {
    const runner = new CodexRunner();
    const prompt = (runner as any).normalizePrompt(
      "Update the experiment summary in the notes.",
      "# Runtime Context\nLatest task: update the notes",
      "## Latest run\nThe validation passed."
    );

    expect(prompt).toContain("Reply to the user naturally in markdown");
    expect(prompt).toContain("Use the runtime context below as the current project state");
    expect(prompt).toContain("include explicit markdown links or a short Sources section");
    expect(prompt).toContain("LITHIUM_STATUS");
    expect(prompt).toContain("FULL_ARTIFACT_CONTEXT:");
  });

  it("runs codex in unsandboxed json mode so live progress events and local tooling can work", () => {
    const runner = new CodexRunner();
    const command = runner.buildTaskCommand(
      "/tmp/workspace",
      "Inspect the repository.",
      "/tmp/out.txt",
      "# Runtime Context",
      undefined,
      "gpt-5.4",
      "xhigh"
    );

    expect(command.args).toContain("--json");
    expect(command.args).toContain("--output-last-message");
    expect(command.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command.args).not.toContain("--full-auto");
    expect(command.args).toContain("--add-dir");
    expect(command.args[command.args.indexOf("--add-dir") + 1]).toBe(
      path.join(os.homedir(), ".oracle")
    );
  });

  it("uses Korean builder scaffolding when the prompt language is Korean", () => {
    const runner = new CodexRunner();
    const prompt = (runner as any).normalizePrompt(
      "새로운 svm 알고리즘 후보를 정리해줘",
      "# Runtime Context\nLatest task: svm novelty memo",
      undefined,
      "ko"
    );

    expect(prompt).toContain("당신은 현재 저장소 안에서 작업하는 연구 실행 에이전트입니다.");
    expect(prompt).toContain("JSON 앞뒤에 마크다운 코드 펜스를 쓰지 마세요.");
    expect(prompt).not.toContain("You are the research execution agent working inside the active repository.");
  });
});
