import { describe, expect, it } from "vitest";
import { parseCodexProgressLog } from "./codex-progress";

describe("parseCodexProgressLog", () => {
  it("extracts the latest agent message and active command from codex jsonl output", () => {
    const progress = parseCodexProgressLog(
      [
        '{"type":"thread.started","thread_id":"abc"}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I\\u2019m checking the repo layout first."}}',
        '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc \\"rg --files src docs\\"","status":"in_progress"}}',
        '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"The docs are explicit enough that I\\u2019m now reading the main services."}}'
      ].join("\n")
    );

    expect(progress).toEqual({
      progressSummary: "The docs are explicit enough that I’m now reading the main services.",
      progressDetails: ["I’m checking the repo layout first."],
      activeCommand: "rg --files src docs"
    });
  });

  it("ignores malformed partial lines and clears commands once they complete", () => {
    const progress = parseCodexProgressLog(
      [
        '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc \\"pwd\\"","status":"in_progress"}}',
        '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc \\"pwd\\"","status":"completed"}}',
        '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Ready to answer."}}',
        '{"type":"item.completed","item":{"id":"broken"',
        "not json"
      ].join("\n")
    );

    expect(progress).toEqual({
      progressSummary: "Ready to answer.",
      progressDetails: [],
      activeCommand: null
    });
  });

  it("replaces partial agent_message updates for the same item instead of keeping fragments as history", () => {
    const progress = parseCodexProgressLog(
      [
        '{"type":"item.updated","item":{"id":"item_7","type":"agent_message","text":"이제 리"}}',
        '{"type":"item.updated","item":{"id":"item_7","type":"agent_message","text":"이제 리스크 쪽을 확인하고 있습니다."}}',
        '{"type":"item.completed","item":{"id":"item_8","type":"agent_message","text":"공식 저장소와 최근 로그를 같이 대조하는 중입니다."}}'
      ].join("\n")
    );

    expect(progress).toEqual({
      progressSummary: "공식 저장소와 최근 로그를 같이 대조하는 중입니다.",
      progressDetails: ["이제 리스크 쪽을 확인하고 있습니다."],
      activeCommand: null
    });
  });
});
