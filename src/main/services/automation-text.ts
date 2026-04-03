import type {
  AppSettings,
  AutomationCheckpointRecord,
  AutomationMode,
  AutomationSessionRecord,
  AutomationStepKind,
  BuilderRunInspection,
  ChatProgressInspection,
  ProjectSnapshot,
  RunRecord,
  RecordStatus,
  AutomationStepRecord
} from "../../shared/types";
import {
  handoffMachineSummary,
  isOperationalAutomationMessage
} from "../../shared/handoff-utils";
import {
  containsUserVisibleSystemNoise,
  parseBuilderOutput,
  stripUserVisibleSystemNoise
} from "./protocol";

export function sanitizeAutomationConversationSummary(summary: string) {
  const trimmed = stripUserVisibleSystemNoise(summary).trim();

  if (!trimmed) {
    return "";
  }

  if (
    isOperationalAutomationMessage(trimmed) ||
    /builder run (?:stalled without producing|ended without writing) a final answer|automation is still running|waiting for your direction|latest strategist result:|latest builder result:/i.test(
      trimmed
    )
  ) {
    return "";
  }

  if (/^oracle did not return a structured rationale\.?$/i.test(trimmed)) {
    return "";
  }

  return trimmed.replace(/\s+/g, " ").trim();
}

export function humanizeAutomationUiIssue(summary: string, language: "ko" | "en") {
  const sanitized = sanitizeAutomationConversationSummary(summary);

  if (sanitized) {
    return sanitized;
  }

  const trimmed = summary.trim();

  if (!trimmed) {
    return "";
  }

  if (isStrategistLoginRequiredFailure(trimmed) || isStrategistSessionExpiredFailure(trimmed)) {
    return language === "ko"
      ? "strategist 브라우저 단계가 ChatGPT 로그인 또는 세션 준비 문제로 막혔습니다."
      : "The strategist browser step is blocked on ChatGPT login or session readiness.";
  }

  if (isStrategistBrowserClosedFailure(trimmed)) {
    return language === "ko"
      ? "strategist 브라우저 단계가 창 종료 또는 브라우저 연결 문제로 끝까지 이어지지 못했습니다."
      : "The strategist browser step did not stay attached through completion.";
  }

  if (containsUserVisibleSystemNoise(trimmed)) {
    return language === "ko"
      ? "strategist/browser 전달 단계에서 일시적인 로컬 연결 문제가 있었습니다."
      : "The strategist/browser handoff hit a temporary local connection issue.";
  }

  if (isStrategistBlockedFailure(trimmed)) {
    return language === "ko"
      ? "strategist 브라우저 단계에 보조 조치가 필요합니다."
      : "The strategist browser step needs attention before automation can continue.";
  }

  return "";
}

export function summarizeAutomationNextAction(nextActions: string[]) {
  return nextActions
    .map((action) => action.trim())
    .find(Boolean) ?? "";
}

export function buildAutomationCheckpointConversationMessage(input: {
  session: AutomationSessionRecord;
  checkpoint: AutomationCheckpointRecord;
}) {
  const { session, checkpoint } = input;
  const language = resolveAutomationUiLanguage([
    session.displayObjective ?? "",
    session.objective,
    checkpoint.summary,
    checkpoint.title
  ]);
  const summary = sanitizeAutomationConversationSummary(checkpoint.summary);
  const nextAction = summarizeAutomationNextAction(checkpoint.nextActions);
  const blockedStrategistMessage = [
    checkpoint.title,
    checkpoint.summary,
    ...checkpoint.risks,
    ...checkpoint.nextActions
  ]
    .join("\n")
    .trim();

  if (/^automation blocked on the strategist run$/i.test(checkpoint.title)) {
    if (language === "ko") {
      return [
        isStrategistLoginRequiredFailure(blockedStrategistMessage) || isStrategistSessionExpiredFailure(blockedStrategistMessage)
          ? "strategist 브라우저 단계가 ChatGPT 로그인 또는 세션 준비 단계에서 막혀 자동 연구를 잠깐 멈췄습니다."
          : isRetryableStrategistControllerFailure(blockedStrategistMessage)
          ? "strategist 브라우저 단계가 비어 있는 응답으로 끝나서 자동 연구를 잠깐 멈췄습니다."
          : "strategist 브라우저 단계에서 응답을 끝까지 받지 못해 자동 연구를 잠깐 멈췄습니다.",
        isStrategistLoginRequiredFailure(blockedStrategistMessage) || isStrategistSessionExpiredFailure(blockedStrategistMessage)
          ? "Chrome에서 ChatGPT 로그인 상태와 사용 가능한 모델 목록을 먼저 확인해 주세요."
          : "",
        isStrategistBrowserClosedFailure(blockedStrategistMessage)
          ? "strategist Chrome 창은 답변이 끝날 때까지 닫지 말고 그대로 두면 됩니다."
          : "",
        !isStrategistLoginRequiredFailure(blockedStrategistMessage) &&
        !isStrategistSessionExpiredFailure(blockedStrategistMessage) &&
        !isStrategistBrowserClosedFailure(blockedStrategistMessage) &&
        nextAction
          ? `다음으로는 ${nextAction}`
          : "",
        "원하면 같은 지점부터 다시 이어서 시도할 수 있습니다."
      ]
        .filter(Boolean)
        .join(" ");
    }

    return [
      isStrategistLoginRequiredFailure(blockedStrategistMessage) || isStrategistSessionExpiredFailure(blockedStrategistMessage)
        ? "Automation paused because the strategist browser needs a fresh ChatGPT login/session."
        : isRetryableStrategistControllerFailure(blockedStrategistMessage)
        ? "The strategist browser step finished with an empty reply, so automation paused here."
        : "Automation paused because the strategist browser step did not finish cleanly.",
      isStrategistLoginRequiredFailure(blockedStrategistMessage) || isStrategistSessionExpiredFailure(blockedStrategistMessage)
        ? "Please confirm that Chrome is logged into ChatGPT and that the required model is available."
        : "",
      isStrategistBrowserClosedFailure(blockedStrategistMessage)
        ? "Keep the strategist Chrome window open until the answer fully finishes."
        : "",
      !isStrategistLoginRequiredFailure(blockedStrategistMessage) &&
      !isStrategistSessionExpiredFailure(blockedStrategistMessage) &&
      !isStrategistBrowserClosedFailure(blockedStrategistMessage) &&
      nextAction
        ? `Likely next action: ${nextAction}`
        : "",
      "If you want, Lithium can retry from the same point."
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (language === "ko") {
    if (/^automation paused after the latest step$/i.test(checkpoint.title)) {
      return [
        "요청대로 현재 단계까지만 마치고 여기서 멈췄습니다.",
        summary ? `마지막 결과는 ${summary}` : "",
        nextAction ? `다음으로는 ${nextAction}` : ""
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (/^checkpoint ready$/i.test(checkpoint.title)) {
      return [
        "한 단계가 끝났고 지금은 여기서 잠시 멈춰 있습니다.",
        summary ? `마지막 결과는 ${summary}` : "",
        nextAction ? `다음으로는 ${nextAction}` : "",
        "이 지점은 사용자 판단이 필요한 분기라고 감지돼 자동으로 멈췄습니다."
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (/needs review after a failed run|automation failed/i.test(checkpoint.title)) {
      return [
        "직전 단계가 실패해서 여기서 멈췄습니다.",
        summary ? `현재까지 정리된 요약은 ${summary}` : "",
        nextAction ? `복구 후보는 ${nextAction}` : "",
        "방향을 정하면 그 기준으로 바로 이어서 진행하겠습니다."
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (/time budget reached/i.test(checkpoint.title)) {
      return [
        "설정된 실행 시간 한도에 닿아서 여기서 잠시 멈췄습니다.",
        summary ? `현재까지 요약은 ${summary}` : "",
        nextAction ? `다음 후보는 ${nextAction}` : ""
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (/step budget reached/i.test(checkpoint.title)) {
      return [
        "설정된 단계 수 한도에 닿아서 여기서 잠시 멈췄습니다.",
        summary ? `현재까지 요약은 ${summary}` : "",
        nextAction ? `다음 후보는 ${nextAction}` : ""
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (/interrupted after app restart/i.test(checkpoint.title)) {
      return [
        "앱 재시작 때문에 자동 연구가 잠깐 끊겨 여기서 멈췄습니다.",
        summary ? `보존된 마지막 상태는 ${summary}` : "",
        nextAction ? `다음으로는 ${nextAction}` : ""
      ]
        .filter(Boolean)
        .join(" ");
    }

    return [
      "자동 연구가 여기서 잠시 멈춰 있습니다.",
      summary ? `현재까지 요약은 ${summary}` : "",
      nextAction ? `다음 후보는 ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/^automation paused after the latest step$/i.test(checkpoint.title)) {
    return [
      "Paused here after finishing the current step, as requested.",
      summary ? `Latest result: ${summary}` : "",
      nextAction ? `Likely next action: ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/^checkpoint ready$/i.test(checkpoint.title)) {
    return [
      "Finished one bounded step and paused here.",
      summary ? `Latest result: ${summary}` : "",
      nextAction ? `Likely next action: ${nextAction}` : "",
      "Lithium stopped because this point looked like a real decision branch."
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/needs review after a failed run|automation failed/i.test(checkpoint.title)) {
    return [
      "Paused here because the latest step failed.",
      summary ? `Current summary: ${summary}` : "",
      nextAction ? `Recovery candidate: ${nextAction}` : "",
      "Once you steer the direction, Lithium can continue from there."
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/time budget reached/i.test(checkpoint.title)) {
    return [
      "Paused here because the configured runtime budget was exhausted.",
      summary ? `Current summary: ${summary}` : "",
      nextAction ? `Likely next action: ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/step budget reached/i.test(checkpoint.title)) {
    return [
      "Paused here because the configured step budget was exhausted.",
      summary ? `Current summary: ${summary}` : "",
      nextAction ? `Likely next action: ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/interrupted after app restart/i.test(checkpoint.title)) {
    return [
      "Paused here because the app restarted mid-run.",
      summary ? `Latest saved state: ${summary}` : "",
      nextAction ? `Likely next action: ${nextAction}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    "Automation is paused here.",
    summary ? `Current summary: ${summary}` : "",
    nextAction ? `Likely next action: ${nextAction}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildAutomationResumeConversationMessage(input: {
  session: AutomationSessionRecord;
  checkpoint: AutomationCheckpointRecord;
  response?: string;
  mode: AutomationMode;
}) {
  const language = resolveAutomationUiLanguage([
    input.response ?? "",
    input.session.displayObjective ?? "",
    input.session.objective,
    input.checkpoint.summary
  ]);

  if (language === "ko") {
    return input.mode === "continuous"
      ? "방금 방향을 반영했고 자동 연구를 다시 이어갑니다. 이제 routine step에서는 멈추지 않고, 정말 판단이 필요한 분기에서만 다시 물어보겠습니다."
      : "방금 방향을 반영했고 자동 연구를 다시 이어갑니다. 다음 체크포인트가 오면 다시 이 채팅에서 바로 알려드리겠습니다.";
  }

  return input.mode === "continuous"
    ? "Applied your latest direction and resumed automation. Routine steps will keep going automatically, and Lithium will only stop again at a real decision branch."
    : "Applied your latest direction and resumed automation. Lithium will report back here again at the next checkpoint.";
}

export function extractRunSummary(finalMessage: string) {
  const handoff = parseBuilderOutput(finalMessage);
  const machineSummary = handoffMachineSummary(handoff);
  if (machineSummary) {
    return machineSummary;
  }

  const stripped = stripUserVisibleSystemNoise(stripConversationControlFooters(finalMessage))
    .replace(/\s+/g, " ")
    .trim();

  if (stripped) {
    return stripped.slice(0, 180);
  }

  return humanizeAutomationUiIssue(finalMessage, containsHangul(finalMessage) ? "ko" : "en")
    .slice(0, 180);
}

export function buildAutomationChatFollowupPrompt(
  session: AutomationSessionRecord,
  question: string,
  checkpoint: AutomationCheckpointRecord
) {
  const language = resolveAutomationUiLanguage([
    question,
    session.displayObjective ?? "",
    session.objective,
    checkpoint.summary
  ]);

  if (language === "ko") {
    return [
      `사용자 질문: ${question.trim()}`,
      `자동 연구 목표: ${(session.displayObjective ?? session.objective).trim()}`,
      `현재 자동 연구 상태: 일시 정지. 최신 체크포인트는 "${checkpoint.title}"이며 요약은 "${checkpoint.summary.trim()}" 입니다.`,
      "이 질문은 새 strategist 재계획으로 보내지 말고, 현재 workspace의 최신 실험 산출물, 로그, 메모, runtime context를 바탕으로 바로 답하세요.",
      "이미 확인된 수치와 파일이 있으면 그 근거를 우선해서 설명하고, 아직 확정되지 않은 내용은 무엇이 비어 있는지만 짧게 밝히세요.",
      "답변 끝에 별도의 시스템 문구나 '잠시 멈춘 상태입니다' 같은 운영 문장을 덧붙이지 마세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    `User question: ${question.trim()}`,
    `Automation objective: ${(session.displayObjective ?? session.objective).trim()}`,
    `Automation state: paused. Latest checkpoint: "${checkpoint.title}" — ${checkpoint.summary.trim()}.`,
    "Answer directly from the current workspace artifacts, logs, notes, and runtime context instead of starting a new strategist replanning step.",
    "Prefer concrete measured results and file-backed evidence. If something is still unverified, say exactly what is missing.",
    "Do not append a separate operational status footer after the answer."
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildRunningAutomationChatFollowupPrompt(input: {
  session: AutomationSessionRecord;
  question: string;
  snapshot: ProjectSnapshot;
  builderInspection: BuilderRunInspection | null;
  chatProgress: ChatProgressInspection | null;
}) {
  const latestDecisionSummary = input.snapshot.latestDecision?.summary?.trim() || "";
  const latestRunSummary =
    handoffMachineSummary(input.snapshot.latestRun?.handoff) ||
    extractRunSummary(input.snapshot.latestRun?.finalMessage ?? "");
  const latestResult = latestRunSummary || latestDecisionSummary;
  const language = resolveAutomationUiLanguage([
    input.question,
    input.session.displayObjective ?? "",
    input.session.objective,
    latestRunSummary,
    latestDecisionSummary
  ]);
  const liveStepSummary =
    input.builderInspection?.progressSummary?.trim() ||
    input.chatProgress?.progressSummary?.trim() ||
    input.session.currentStepSummary.trim();
  const liveFocus = humanizeAutomationUiStepSummary(liveStepSummary, language);

  if (language === "ko") {
    return [
      `사용자 질문: ${input.question.trim()}`,
      `자동 연구 목표: ${(input.session.displayObjective ?? input.session.objective).trim()}`,
      "현재 자동 연구 상태: 진행 중.",
      liveFocus ? `현재 포커스: ${liveFocus}` : "",
      latestResult ? `최근 확정 결과: ${latestResult}` : "",
      "이 질문은 진행 중인 자동 연구를 끊거나 새 실험을 시작하지 말고, 현재 workspace의 최신 실험 산출물, 로그, 메모, runtime context를 바탕으로 바로 답하세요.",
      "새 명령 실행, 파일 수정, 코드 변경, 추가 실험은 하지 말고 이미 기록된 근거만 사용하세요.",
      "답변은 질문에 직접 답하고, 사용자가 빠르게 이해할 수 있게 쉬운 말로 설명하세요.",
      "아직 확정되지 않은 내용은 무엇이 비어 있는지만 짧게 밝히세요.",
      "답변 끝에 별도의 운영 상태 문장이나 자동화 제어 문장을 덧붙이지 마세요."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    `User question: ${input.question.trim()}`,
    `Automation objective: ${(input.session.displayObjective ?? input.session.objective).trim()}`,
    "Automation state: still running.",
    liveFocus ? `Current focus: ${liveFocus}` : "",
    latestResult ? `Latest confirmed result: ${latestResult}` : "",
    "Answer this question directly from the current workspace artifacts, logs, notes, and runtime context without interrupting the in-flight automation or starting a new experiment.",
    "Do not run new commands, modify files, change code, or launch another worker. Use only evidence that is already recorded.",
    "Answer the user directly in clear, simple language.",
    "If something is still unverified, say exactly what is missing.",
    "Do not append a separate operational status footer after the answer."
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function resolveAutomationUiLanguage(samples: string[]) {
  return samples.some(containsHangul) ? "ko" : "en";
}

export function humanizeAutomationUiStepSummary(value: string, _language: "ko" | "en") {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  return trimmed;
}

export function isStrategistBlockedFailure(message: string) {
  return /oracle strategist run completed without producing output|chrome window closed before oracle finished|lithium_oracle_visible=1|saved chatgpt session expired|chatgpt session expired|no (?:chatgpt )?cookies were applied|log in to chatgpt in chrome|provide inline cookies|unable to find model option matching/i.test(
    message
  );
}

export function isRetryableStrategistControllerFailure(message: string) {
  return /oracle strategist run completed without producing output|oracle strategist output looked truncated or non-final/i.test(
    message
  );
}

export function isStrategistBrowserClosedFailure(message: string) {
  return /chrome window closed before oracle finished/i.test(message);
}

export function isStrategistSessionExpiredFailure(message: string) {
  return /saved chatgpt session expired|chatgpt session expired/i.test(message);
}

export function isStrategistLoginRequiredFailure(message: string) {
  return /no (?:chatgpt )?cookies were applied|log in to chatgpt in chrome|provide inline cookies|unable to find model option matching/i.test(
    message
  );
}

export function isStrategistBrowserBlockedFailure(message: string) {
  return /chrome window closed before oracle finished|lithium_oracle_visible=1|saved chatgpt session expired|chatgpt session expired|no (?:chatgpt )?cookies were applied|log in to chatgpt in chrome|provide inline cookies|unable to find model option matching/i.test(
    message
  );
}

export function localizeAutomationStartReply(prompt: string) {
  if (containsHangul(prompt)) {
    return "이 목표로 자동 연구를 시작하겠습니다. 진행하면서 필요한 상태와 결과를 채팅으로 이어서 보고하겠습니다.";
  }

  return "I’ll start the automation from this goal and continue the status updates here in chat.";
}

export function resolveAutomationPromptLanguage(
  preference: AppSettings["autopilotPromptLanguage"],
  samples: string[]
): "ko" | "en" {
  if (preference === "ko" || preference === "en") {
    return preference;
  }

  return samples.some(containsHangul) ? "ko" : "en";
}

export function containsHangul(value: string) {
  return /[\u3131-\u318E\uAC00-\uD7A3]/.test(value);
}

export function inferAutomationBuilderStepKind(builderPrompt: string): AutomationStepKind {
  const normalized = builderPrompt.toLowerCase();

  if (/\b(run|train|evaluate|benchmark|ablation|experiment|sweep)\b/.test(normalized)) {
    return "experiment-run";
  }

  if (/\b(analy[sz]e|inspect|summari[sz]e|plot|csv|metric|result|figure|table)\b/.test(normalized)) {
    return "result-analysis";
  }

  if (/\b(literature|literature search|related work|citation|survey|search)\b/.test(normalized)) {
    return "literature-search";
  }

  return "code-edit";
}

export function buildAutomationEvidence(run?: RunRecord | null) {
  if (!run) {
    return [];
  }

  return Array.from(
    new Set(
      [
        run.id,
        `status:${run.status}`,
        handoffMachineSummary(run.handoff),
        ...run.changedFiles.slice(0, 8)
      ].filter(Boolean)
    )
  );
}

export function summarizeInterruptedAutomationSession(
  step: AutomationStepRecord | null,
  run: RunRecord | null
) {
  if (run?.status === "completed") {
    return "The latest builder run finished, but automation stopped when the app restarted before it could continue.";
  }

  if (step?.lane === "strategist") {
    return "Automation stopped when the app restarted during the strategist step.";
  }

  if (step?.lane === "builder") {
    return "Automation stopped when the app restarted during the builder step.";
  }

  return "Automation stopped when the app restarted before the latest step finished.";
}

export function stripConversationControlFooters(value: string) {
  return value
    .replace(/\n*LITHIUM_STATUS(?:\s*\n|\s+)?[\s\S]*$/i, "")
    .replace(/\n*LITHIUM_HANDOFF(?:\s*\n|\s+)?[\s\S]*$/i, "")
    .trim();
}
