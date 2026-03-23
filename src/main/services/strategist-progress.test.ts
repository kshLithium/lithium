import { describe, expect, it } from "vitest";
import { extractOracleSessionProgress, mergeStrategistLiveProgress } from "./strategist-progress";

describe("strategist-progress", () => {
  it("surfaces assistant preview history from oracle logs and strips markup noise", () => {
    const parsed = extractOracleSessionProgress([
      "Launching browser mode (gpt-5.4) with ~955 tokens.",
      "[assistant-preview] <p data-start=\"0\">기존 맥락을 먼저 붙잡고, 바로 최신 SVM 관련 연구 축을 확인해서 실제로 밀 만한 새 알고리즘 가설까지 이어보겠습니다.</p>",
      "[assistant-preview] <p data-start=\"0\">기존 맥락을 먼저 붙잡고, 바로 최신 SVM 관련 연구 축을 확인해서 실제로 밀 만한 새 알고리즘 가설까지 이어보겠습니다.</p>",
      "[assistant-preview] <p data-start=\"90\">이어서 현재 프로젝트 문맥에 맞는 다음 연구 산출물 형태로 정리할게요.</p>",
      " 12% [1m / ~10m] — 문헌 지형을 빠르게 확인하고 있습니다."
    ].join("\n"));

    expect(parsed.progressSummary).toBe("이어서 현재 프로젝트 문맥에 맞는 다음 연구 산출물 형태로 정리할게요.");
    expect(parsed.progressDetails).toEqual([
      "기존 맥락을 먼저 붙잡고, 바로 최신 SVM 관련 연구 축을 확인해서 실제로 밀 만한 새 알고리즘 가설까지 이어보겠습니다."
    ]);
  });

  it("falls back to thinking updates when assistant preview text is unavailable", () => {
    const parsed = extractOracleSessionProgress([
      " 10% [45s / ~10m] — 기존 맥락을 먼저 붙잡고 있습니다.",
      " 22% [1m / ~10m] — 최신 SVM 연구 축을 확인하고 있습니다.",
      " 35% [2m / ~10m] — 실제로 밀 만한 새 알고리즘 가설까지 이어보겠습니다."
    ].join("\n"));

    expect(parsed.progressSummary).toBe("실제로 밀 만한 새 알고리즘 가설까지 이어보겠습니다.");
    expect(parsed.progressDetails).toEqual([
      "기존 맥락을 먼저 붙잡고 있습니다.",
      "최신 SVM 연구 축을 확인하고 있습니다."
    ]);
  });

  it("prefers richer oracle preview text over generic live thinking statuses", () => {
    const merged = mergeStrategistLiveProgress(
      {
        progressSummary: "Reading documents",
        progressDetails: []
      },
      {
        progressSummary: "README와 examples/train_probe.py가 실제로 어떤 입력·출력을 다루는지 먼저 보고 있습니다.",
        progressDetails: ["README와 examples/train_probe.py를 먼저 대조하고 있습니다."]
      }
    );

    expect(merged.progressSummary).toBe(
      "README와 examples/train_probe.py가 실제로 어떤 입력·출력을 다루는지 먼저 보고 있습니다."
    );
    expect(merged.progressDetails).toEqual(["README와 examples/train_probe.py를 먼저 대조하고 있습니다."]);
  });
});
