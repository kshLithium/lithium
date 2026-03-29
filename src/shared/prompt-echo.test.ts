import { describe, expect, it } from "vitest";
import {
  buildPromptEchoMatcher,
  sanitizePromptEchoProgress,
  stripLeadingPromptEchoParagraph
} from "./prompt-echo";

describe("prompt-echo", () => {
  it("matches exact prompt echoes and stable prompt fragments", () => {
    const matcher = buildPromptEchoMatcher(
      "리서치할 때 브라우저에서 버그걸린 더 이제 내가 고쳤음 자유롭게 strate model call 해도 됨"
    );

    expect(matcher?.isEcho("리서치할 때 브라우저에서 버그걸린 더 이제 내가 고쳤음 자유롭게 strate model call 해도 됨")).toBe(true);
    expect(
      matcher?.isEcho("리서치할 때 브라우저에서 버그걸린 더 이제 내가 고쳤음 자유롭게 strate model...")
    ).toBe(true);
    expect(matcher?.isEcho("좋아요. 그 기준으로 다음 bounded step부터 바로 이어가겠습니다.")).toBe(false);
  });

  it("strips a leading echoed paragraph and keeps the actual assistant content", () => {
    expect(
      stripLeadingPromptEchoParagraph(
        [
          "더 다양한 접근법을 리서치해야할 거 같은데 논문이나 학습사례나 좀 더 다양하게 리서치를 해보셈 최신 기술로다가 현재 너무 strate 모델이 놀고 있음",
          "",
          "이번 턴 요청 파일이 비어 있어서, 바로 다음 실행과 큐 메모를 새로 다시 써두겠습니다."
        ].join("\n\n"),
        "더 다양한 접근법을 리서치해야할 거 같은데 논문이나 학습사례나 좀 더 다양하게 리서치를 해보셈 최신 기술로다가 현재 너무 strate 모델이 놀고 있음"
      )
    ).toBe("이번 턴 요청 파일이 비어 있어서, 바로 다음 실행과 큐 메모를 새로 다시 써두겠습니다.");
  });

  it("promotes the next live progress line when the summary is just a prompt echo", () => {
    expect(
      sanitizePromptEchoProgress(
        {
          progressSummary: "리서치할 때 브라우저에서 버그걸린 더 이제 내가 고쳤음 자유롭게 strate model call 해도 됨",
          progressDetails: ["브라우저 상태와 live strategist preview 추출 경로를 같이 점검하고 있습니다."]
        },
        "리서치할 때 브라우저에서 버그걸린 더 이제 내가 고쳤음 자유롭게 strate model call 해도 됨"
      )
    ).toEqual({
      progressSummary: "브라우저 상태와 live strategist preview 추출 경로를 같이 점검하고 있습니다.",
      progressDetails: []
    });
  });
});
