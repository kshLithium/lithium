import { describe, expect, it } from "vitest";
import {
  extractOracleSessionProgress,
  hasMeaningfulStrategistProgress,
  mergeStrategistLiveProgress
} from "./strategist-progress";

describe("strategist-progress", () => {
  it("surfaces assistant preview history from oracle logs and strips markup noise", () => {
    const parsed = extractOracleSessionProgress([
      "Launching browser mode (gpt-5.4-pro) with ~955 tokens.",
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

  it("drops truncated preview fragments when a fuller version arrives later", () => {
    const parsed = extractOracleSessionProgress([
      "[assistant-preview] 작은 이상 징후 하나가 바로 보였습",
      "[assistant-preview] 작은 이상 징후 하나가 바로 보였습니다. 먼저 README와 최신 로그를 대조하겠습니다."
    ].join("\n"));

    expect(parsed.progressSummary).toBe(
      "작은 이상 징후 하나가 바로 보였습니다. 먼저 README와 최신 로그를 대조하겠습니다."
    );
    expect(parsed.progressDetails).toEqual([]);
  });

  it("splits cumulative assistant previews into stable paragraph history and drops a trailing fragment", () => {
    const parsed = extractOracleSessionProgress([
      "[assistant-preview] 이제 리스크 쪽을 확인하고 있습니다. 겉으로는 단순한 공개 챌린지인데, 실제로는 평가 공정성 쟁점을 먼저 분리해 봐야 합니다.",
      "[assistant-preview] 이제 리스크 쪽을 확인하고 있습니다. 겉으로는 단순한 공개 챌린지인데, 실제로는 평가 공정성 쟁점을 먼저 분리해 봐야 합니다.<br><br>공식 챌린지/저장소는 확인됐고, 지금은 이 해석이 맞는지 근거를 더 다지고 있습니다.<br><br>이제 리"
    ].join("\n"));

    expect(parsed.progressSummary).toBe(
      "공식 챌린지/저장소는 확인됐고, 지금은 이 해석이 맞는지 근거를 더 다지고 있습니다."
    );
    expect(parsed.progressDetails).toEqual([
      "이제 리스크 쪽을 확인하고 있습니다. 겉으로는 단순한 공개 챌린지인데, 실제로는 평가 공정성 쟁점을 먼저 분리해 봐야 합니다."
    ]);
  });

  it("prefers fuller logged strategist progress over a shorter live fragment", () => {
    const merged = mergeStrategistLiveProgress(
      {
        progressSummary: "이제 리",
        progressDetails: []
      },
      {
        progressSummary: "공식 챌린지/저장소는 확인됐고, 지금은 이 해석이 맞는지 근거를 더 다지고 있습니다.",
        progressDetails: [
          "이제 리스크 쪽을 확인하고 있습니다. 겉으로는 단순한 공개 챌린지인데, 실제로는 평가 공정성 쟁점을 먼저 분리해 봐야 합니다."
        ]
      }
    );

    expect(merged.progressSummary).toBe(
      "공식 챌린지/저장소는 확인됐고, 지금은 이 해석이 맞는지 근거를 더 다지고 있습니다."
    );
    expect(merged.progressDetails).toEqual([
      "이제 리스크 쪽을 확인하고 있습니다. 겉으로는 단순한 공개 챌린지인데, 실제로는 평가 공정성 쟁점을 먼저 분리해 봐야 합니다."
    ]);
  });

  it("drops a short fragment detail when a later fuller sentence starts with the same text", () => {
    const parsed = extractOracleSessionProgress([
      "[assistant-preview] 먼저 공개",
      "[assistant-preview] 먼저 공개 기록과 로컬 official 상태를 아주 얇게 다시 확인한 뒤, 바로 가장 싼 MLX bounded step 하나를 실제로 돌리겠습니다."
    ].join("\n"));

    expect(parsed.progressSummary).toBe(
      "먼저 공개 기록과 로컬 official 상태를 아주 얇게 다시 확인한 뒤, 바로 가장 싼 MLX bounded step 하나를 실제로 돌리겠습니다."
    );
    expect(parsed.progressDetails).toEqual([]);
  });

  it("treats logged strategist previews as meaningful progress", () => {
    expect(
      hasMeaningfulStrategistProgress({
        progressSummary: "지금 컨텍스트만 기준으로 핵심만 추려볼게요.",
        progressDetails: []
      })
    ).toBe(true);
    expect(
      hasMeaningfulStrategistProgress({
        progressSummary: "",
        progressDetails: ["최근 실행 상태를 먼저 확인하고 있습니다."]
      })
    ).toBe(true);
    expect(
      hasMeaningfulStrategistProgress({
        progressSummary: "   ",
        progressDetails: ["   "]
      })
    ).toBe(false);
    expect(hasMeaningfulStrategistProgress(null)).toBe(false);
  });
});
