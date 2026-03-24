import type {
  AttachmentRecord,
  AutomationCheckpointRecord,
  AutomationSessionRecord,
  AutomationStepRecord,
  ArtifactKind,
  BuilderRunInspection,
  ChatProgressInspection,
  ConversationEntryRecord,
  ResolvedTheme,
  LithiumHandoff,
  ThemePreference,
  ProjectMemoryRecord,
  ProjectSnapshot,
  RuntimeAppState,
  ThreadRecord,
  WorkspaceFileRecord
} from "../shared/types";
import {
  handoffMachineSummary,
  handoffUserMessage,
  isOperationalAutomationMessage
} from "../shared/handoff-utils";
import { WORKBENCH_SURFACES_ENABLED } from "../shared/feature-flags";
import type { ChatItem, ExplorerRow, MemoryDraft, PaperOutlineRow, ThreadMemoryDraft } from "./app-types";

export const UNTITLED_CODE_PREFIX = "untitled:";

export type OnboardingChecklistItem = {
  id: "strategist" | "builder" | "workspace";
  title: string;
  status: "ready" | "action";
  detail: string;
  hint?: string;
};

export function buildChatItems(
  snapshot: ProjectSnapshot,
  workspaceFiles: WorkspaceFileRecord[],
  workspacePath = "",
  builderInspection: BuilderRunInspection | null = null
): ChatItem[] {
  if (!snapshot.project) {
    return [];
  }

  const items: ChatItem[] = [];
  const activeThreadId = snapshot.activeThreadId ?? snapshot.threads[0]?.id ?? null;
  const attachmentsByConversationEntryId = groupAttachmentsBy(snapshot.attachments, "conversationEntryId");
  const attachmentsByDecisionId = groupAttachmentsBy(snapshot.attachments, "decisionId");
  const attachmentsByRunId = groupAttachmentsBy(snapshot.attachments, "runId");
  const conversationEntries = [...(snapshot.conversationEntries ?? [])]
    .filter((entry) => !activeThreadId || entry.threadId === activeThreadId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const decisions = [...snapshot.decisions]
    .filter((decision) => !activeThreadId || decision.threadId === activeThreadId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const runs = [...snapshot.runs]
    .filter((run) => run.model !== "tectonic")
    .filter((run) => !activeThreadId || run.threadId === activeThreadId)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const automationSessions = [...(snapshot.automationSessions ?? [])]
    .filter((session) => !activeThreadId || session.threadId === activeThreadId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const automationCheckpoints = [...(snapshot.automationCheckpoints ?? [])]
    .filter((checkpoint) => !activeThreadId || checkpoint.threadId === activeThreadId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const automationSteps = [...(snapshot.automationSteps ?? [])]
    .filter((step) => !activeThreadId || step.threadId === activeThreadId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const routerTraces = [...(snapshot.routerTraces ?? [])]
    .filter((trace) => !activeThreadId || trace.threadId === activeThreadId)
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt));
  const automationSessionById = new Map(automationSessions.map((session) => [session.id, session] as const));
  const conversationCheckpointIds = new Set(
    conversationEntries
      .map((entry) => entry.automationCheckpointId)
      .filter((value): value is string => Boolean(value))
  );
  const latestAutomationTimelineTimestamp = resolveLatestAutomationTimelineTimestamp(
    automationSessions,
    automationSteps,
    automationCheckpoints
  );
  const mixedFollowupRunIds = new Set(
    routerTraces
      .filter((trace) => trace.finalRoute === "mixed" && trace.downstreamRunId)
      .map((trace) => trace.downstreamRunId as string)
  );
  const hasConversationEntries = conversationEntries.length > 0;

  if (hasConversationEntries) {
    for (const entry of conversationEntries) {
      items.push(
        formatConversationEntry(
          entry,
          items.length,
          toOptionalArtifacts(
            buildAttachmentArtifactRefs(
              attachmentsByConversationEntryId.get(entry.id) ?? [],
              workspaceFiles,
              workspacePath
            )
          )
        )
      );
    }
  }

  for (const decision of hasConversationEntries ? [] : decisions) {
    const visiblePrompt = resolveVisibleDecisionPrompt(decision);

    if (visiblePrompt) {
      items.push({
        id: `decision:${decision.id}`,
        role: "user",
        variant: "research",
        title: "You",
        body: visiblePrompt,
        timestamp: decision.createdAt,
        order: items.length,
        artifacts: toOptionalArtifacts(
          buildAttachmentArtifactRefs(attachmentsByDecisionId.get(decision.id) ?? [], workspaceFiles, workspacePath)
        )
      });
    }

    items.push({
      id: `decision-result:${decision.id}`,
      role: "assistant",
      variant: "research",
      title: "Lithium",
      body: formatDecisionBody(
        decision.summary,
        decision.rationale,
        decision.rawOutput,
        false,
        decision.handoff,
        decision.inputFiles,
        workspacePath
      ),
      timestamp: decision.createdAt,
      order: items.length
    });
  }

  for (const run of hasConversationEntries ? [] : runs) {
    if (shouldSuppressAutomationRun(run, latestAutomationTimelineTimestamp)) {
      continue;
    }

    const visibleRunPrompt = resolveVisibleRunPrompt(run);

    if (!mixedFollowupRunIds.has(run.id) && visibleRunPrompt) {
      items.push({
        id: `task:${run.taskId}`,
        role: "user",
        variant: "build",
        title: "You",
        body: visibleRunPrompt,
        timestamp: run.startedAt,
        order: items.length,
        artifacts: toOptionalArtifacts(
          buildAttachmentArtifactRefs(attachmentsByRunId.get(run.id) ?? [], workspaceFiles, workspacePath)
        )
      });
    }

    items.push({
      id: `run:${run.id}`,
      role: "assistant",
      variant: "build",
      title: "Lithium",
      body: formatBuilderBody(
        run,
        builderInspection?.run?.id === run.id ? builderInspection : null
      ),
      timestamp: run.endedAt || run.startedAt,
      order: items.length
    });
  }

  for (const session of hasConversationEntries ? [] : automationSessions) {
    const visiblePrompt = shouldSuppressAutomationSessionPrompt(session, automationCheckpoints)
      ? ""
      : resolveVisibleAutomationSessionPrompt(session);

    if (!visiblePrompt) {
      continue;
    }

    items.push({
      id: `automation-session:${session.id}`,
      role: "user",
      variant: "neutral",
      title: "You",
      body: visiblePrompt,
      timestamp: session.createdAt,
      order: items.length
    });
  }

  for (const step of automationSteps) {
    if (!shouldRenderAutomationStepSummary(step, automationSessionById.get(step.sessionId), automationSteps, automationCheckpoints)) {
      continue;
    }

    items.push({
      id: `automation-step-summary:${step.id}`,
      role: "assistant",
      variant: "neutral",
      title: "Lithium",
      body: humanizeAutomationStepSummary(step.summary.trim()),
      timestamp: step.completedAt || step.updatedAt,
      order: items.length
    });
  }

  for (const checkpoint of automationCheckpoints) {
    if (conversationCheckpointIds.has(checkpoint.id)) {
      continue;
    }

    const visiblePrompt = resolveVisibleAutomationCheckpointPrompt(checkpoint);
    const session = automationSessionById.get(checkpoint.sessionId);
    const tone = resolveAutomationCheckpointTone(checkpoint, session);
    const checkpointBody = describeAutomationCheckpoint(checkpoint, session);
    const suppressBody = shouldSuppressResolvedAutomationCheckpointBody(
      checkpoint,
      session,
      automationCheckpoints,
      automationSteps,
      decisions,
      runs
    );

    if (tone === "recorded") {
      continue;
    }

    if (visiblePrompt) {
      items.push({
        id: `automation-checkpoint-prompt:${checkpoint.id}`,
        role: "user",
        variant: "neutral",
        title: "You",
        body: visiblePrompt,
        timestamp: checkpoint.createdAt,
        order: items.length
      });
    }

    if (!checkpointBody || suppressBody) {
      continue;
    }

    items.push({
      id: `automation-checkpoint:${checkpoint.id}`,
      role: "system",
      variant: "neutral",
      title: "Automation",
      body: checkpointBody,
      timestamp: checkpoint.updatedAt || checkpoint.createdAt,
      order: items.length
    });
  }

  return collapseDuplicateUserTaskItems(sortChatItems(items));
}

export function mergeTransientChatItems(
  chatItems: ChatItem[],
  pendingChatItems: ChatItem[],
  input: {
    busyAction?: string | null;
    busyBody?: string | null;
    chatProgress?: ChatProgressInspection | null;
    workspacePath?: string;
    activeThreadId?: string | null;
  }
) {
  const items = [...chatItems, ...pendingChatItems];
  const liveProgressBody = formatLiveProgressBody(input.chatProgress ?? null);
  const order = items.length;
  const transientThreadKey =
    input.chatProgress?.threadId || input.activeThreadId || input.workspacePath || pendingChatItems[0]?.id || "chat";

  if (input.busyAction && pendingChatItems.length) {
    items.push({
      id: `busy:${transientThreadKey}:${input.busyAction}`,
      role: "assistant",
      variant: "neutral",
      title: "Lithium",
      body: input.busyBody?.trim() || liveProgressBody || "Working…",
      timestamp:
        input.chatProgress?.updatedAt || pendingChatItems[pendingChatItems.length - 1]?.timestamp || new Date().toISOString(),
      order,
      pending: true
    });
    return sortChatItems(items);
  }

  if (
    input.chatProgress?.active &&
    liveProgressBody &&
    shouldRenderLiveProgress(chatItems, input.chatProgress, liveProgressBody)
  ) {
    items.push({
      id: `live-progress:${transientThreadKey}:${input.chatProgress.lane}`,
      role: "assistant",
      variant: "neutral",
      title: "Lithium",
      body: liveProgressBody,
      timestamp: input.chatProgress.updatedAt,
      order,
      pending: true
    });
  }

  return sortChatItems(items);
}

function resolveVisibleDecisionPrompt(decision: ProjectSnapshot["decisions"][number]) {
  const prompt = (decision.displayPrompt?.trim() || decision.prompt || "").trim();

  if (!prompt || isAutopilotPrompt(prompt)) {
    return "";
  }

  return prompt;
}

function sortChatItems(items: ChatItem[]) {
  return [...items].sort((left, right) => {
    const timeDifference = left.timestamp.localeCompare(right.timestamp);

    if (timeDifference !== 0) {
      return timeDifference;
    }

    return left.order - right.order;
  });
}

function shouldRenderLiveProgress(
  chatItems: ChatItem[],
  progress: ChatProgressInspection,
  body: string
) {
  const latestPersistedTimestamp = [...chatItems]
    .reverse()
    .find((item) => !item.pending)?.timestamp;

  if (latestPersistedTimestamp && latestPersistedTimestamp.localeCompare(progress.updatedAt) > 0) {
    return false;
  }

  const latestAssistantOrSystemBody = [...chatItems]
    .reverse()
    .find((item) => item.role !== "user" && !item.pending)?.body
    ?.trim();

  return latestAssistantOrSystemBody !== body.trim();
}

function resolveVisibleRunPrompt(run: ProjectSnapshot["runs"][number]) {
  const prompt = (run.displayPrompt?.trim() || run.prompt || "").trim();

  if (!prompt || isAutopilotPrompt(prompt)) {
    return "";
  }

  return prompt;
}

function shouldRenderAutomationStepSummary(
  step: AutomationStepRecord,
  _session: AutomationSessionRecord | undefined,
  steps: AutomationStepRecord[],
  checkpoints: AutomationCheckpointRecord[]
) {
  if (step.status === "running" || step.decisionId || step.runId) {
    return false;
  }

  const summary = step.summary.trim();
  if (!summary || summary === "Step started.") {
    return false;
  }

  if (!isOperationalAutomationMessage(summary)) {
    return true;
  }

  const timestamp = step.completedAt || step.updatedAt;

  if (
    checkpoints.some(
      (checkpoint) =>
        checkpoint.sessionId === step.sessionId &&
        isOperationalAutomationCheckpoint(checkpoint) &&
        (checkpoint.updatedAt || checkpoint.createdAt) >= timestamp
    )
  ) {
    return false;
  }

  return !hasNewerOperationalAutomationEvent(step.sessionId, timestamp, checkpoints, steps, step.id);
}

function resolveVisibleAutomationSessionPrompt(session: AutomationSessionRecord) {
  return session.displayObjective?.trim() || session.objective.trim();
}

function shouldSuppressAutomationSessionPrompt(
  session: AutomationSessionRecord,
  checkpoints: AutomationCheckpointRecord[]
) {
  const hasSupersedingUserInstruction = checkpoints.some(
    (checkpoint) => checkpoint.sessionId === session.id && Boolean(checkpoint.userResponse?.trim())
  );

  if (!hasSupersedingUserInstruction) {
    return false;
  }

  const prompt = resolveVisibleAutomationSessionPrompt(session);
  return looksLikeCanonicalAutomationObjective(prompt);
}

function looksLikeCanonicalAutomationObjective(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return false;
  }

  return /(?:^|\n)(?:목표|제약)\s*:/m.test(trimmed) || trimmed.length > 260;
}

function resolveVisibleAutomationCheckpointPrompt(checkpoint: AutomationCheckpointRecord) {
  const approvedResponse = checkpoint.userResponse?.trim() || "";

  if (approvedResponse) {
    return approvedResponse;
  }

  if (/^automation interrupted$/i.test(checkpoint.title)) {
    return checkpoint.summary.trim();
  }

  return "";
}

function describeAutomationCheckpoint(
  checkpoint: AutomationCheckpointRecord,
  session?: AutomationSessionRecord
) {
  if (
    /^automation interrupted$/i.test(checkpoint.title) &&
    checkpoint.status === "approved" &&
    session?.status === "idle"
  ) {
    return "자동 연구를 멈췄습니다. 다시 시작하려면 새 메시지를 보내 주세요.";
  }

  if (/^automation stopped$/i.test(checkpoint.title)) {
    return "자동 연구를 멈췄습니다. 다시 시작하려면 새 메시지를 보내 주세요.";
  }

  const tone = resolveAutomationCheckpointTone(checkpoint, session);
  const summary = simplifyAutomationCheckpointSummary(checkpoint.summary, session);

  if (tone === "running") {
    return summary || "현재 단계 작업을 계속 진행하고 있습니다.";
  }

  if (tone === "recorded") {
    return "";
  }

  if (tone === "approved") {
    return summary || "방금 보낸 지시를 기록했고, 현재 단계를 마치면 이어서 반영합니다.";
  }

  if (tone === "blocked") {
    return isStrategistBrowserBlockedCheckpoint(checkpoint, session)
      ? "브라우저가 필요한 strategist 단계에서 막혔습니다. 다시 시도할지, 방향을 바꿀지 알려주세요."
      : "현재 단계가 막혔습니다. 같은 경로를 다시 시도할지, 방향을 바꿀지 알려주세요.";
  }

  if (tone === "failed") {
    return "직전 단계가 깔끔하게 끝나지 않았습니다. 같은 경로를 계속 복구할지, 방향을 바꿀지 알려주세요.";
  }

  if (/^checkpoint ready$/i.test(checkpoint.title)) {
    return summary
      ? `한 단계가 끝났고 지금은 여기서 잠시 멈춰 있습니다. 마지막 결과는 ${summary}`
      : "한 단계가 끝났고 지금은 여기서 잠시 멈춰 있습니다. 다음 방향을 정하면 바로 이어서 진행할 수 있습니다.";
  }

  if (
    /^automation interrupted$/i.test(checkpoint.title) &&
    (!summary || summary === checkpoint.userResponse?.trim() || summary === checkpoint.summary.trim())
  ) {
    return "잠시 멈춘 상태입니다. 이어서 어떻게 진행할지 알려주세요.";
  }

  return summary || "잠시 멈춘 상태입니다. 다음에 무엇을 할지 알려주세요.";
}

function simplifyAutomationCheckpointSummary(
  summary: string,
  session?: AutomationSessionRecord
) {
  const trimmed = summary.trim();

  if (!trimmed) {
    return "";
  }

  if (/^Automation is still running\./i.test(trimmed)) {
    return humanizeAutomationStepSummary(session?.currentStepSummary?.trim() ?? "");
  }

  if (looksLikeInternalAutomationSummary(trimmed)) {
    return "";
  }

  return trimmed;
}

function looksLikeInternalAutomationSummary(value: string) {
  return /builder run (?:stalled without producing|ended without writing) a final answer|latest strategist result:|latest builder result:|retry \d+\/\d+|module not founderror|shell_snapshot|automation is still running\.|automation stopped when lithium restarted during (?:the )?builder step/i.test(
    value
  );
}

function isGenericAutomationStepTitle(value: string) {
  return /let codex choose and execute the next bounded step|plan the next bounded research step|execute the next bounded step|choose and execute the next bounded step/i.test(
    value
  );
}

function humanizeAutomationStepSummary(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (/let codex choose and execute the next bounded step/i.test(trimmed)) {
    return "다음으로 검증할 실험이나 구현 단계를 고르고 있습니다.";
  }

  if (/plan the next bounded research step/i.test(trimmed)) {
    return "다음 연구 단계를 작게 쪼개서 정리하고 있습니다.";
  }

  if (/automation is ready to begin/i.test(trimmed)) {
    return "자동 연구를 시작할 준비를 마쳤습니다.";
  }

  if (/automation started\. planning the next bounded step/i.test(trimmed)) {
    return "자동 연구를 시작했고, 바로 다음 단계를 정리하고 있습니다.";
  }

  if (/pause requested\. finishing the current bounded step before stopping/i.test(trimmed)) {
    return "지금 단계까지만 마무리한 뒤 멈출 예정입니다.";
  }

  if (/automation resumed/i.test(trimmed)) {
    return "이전 상태에서 자동 연구를 다시 이어가고 있습니다.";
  }

  if (/checkpoint approved\. continuing automation/i.test(trimmed)) {
    return "방금 방향을 반영했고 자동 연구를 이어가고 있습니다.";
  }

  if (/continuing the current step\. the latest instruction will be applied next/i.test(trimmed)) {
    return "현재 단계는 마저 끝내고, 방금 보낸 지시는 다음 단계부터 반영합니다.";
  }

  if (/automation was interrupted when lithium restarted/i.test(trimmed)) {
    return "앱이 다시 켜지면서 자동 연구가 잠시 멈췄습니다. 이어서 어떻게 할지 알려주세요.";
  }

  if (/runtime budget reached/i.test(trimmed)) {
    return "실행 시간 한도에 도달해서 잠시 멈췄습니다. 이어갈지 결정해 주세요.";
  }

  if (/step budget reached/i.test(trimmed)) {
    return "단계 수 한도에 도달해서 잠시 멈췄습니다. 이어갈지 결정해 주세요.";
  }

  if (/blocked on the strategist run/i.test(trimmed)) {
    return "strategist 단계에서 막혀 있습니다. 같은 경로로 다시 시도할지 알려주세요.";
  }

  if (/automation stopped with an issue/i.test(trimmed)) {
    return "문제가 생겨 잠시 멈췄습니다. 복구를 이어갈지 알려주세요.";
  }

  if (/paper phase activated after the latest strategist decision/i.test(trimmed)) {
    return "최신 판단을 바탕으로 paper 동기화 단계까지 포함해 진행하고 있습니다.";
  }

  if (/^recovering after\b/i.test(trimmed)) {
    return "직전 단계 이후 복구 경로를 진행하고 있습니다.";
  }

  if (/^continuing after\b/i.test(trimmed)) {
    return "방금 끝난 단계에 이어 다음 작업을 진행하고 있습니다.";
  }

  return trimmed;
}

function isAutopilotPrompt(value: string | null | undefined) {
  return /^\[autopilot\]/i.test(value?.trim() ?? "");
}

function isActivePendingAutomationCheckpoint(
  checkpoint: AutomationCheckpointRecord,
  session?: AutomationSessionRecord
) {
  return Boolean(
    checkpoint.status === "pending" &&
      session &&
      session.status === "idle" &&
      session.latestCheckpointId === checkpoint.id
  );
}

export function resolveAutomationCheckpointTone(
  checkpoint: AutomationCheckpointRecord,
  session?: AutomationSessionRecord
): NonNullable<ChatItem["statusTone"]> {
  if (
    /^automation interrupted$/i.test(checkpoint.title) &&
    checkpoint.status === "approved" &&
    session?.status === "idle"
  ) {
    return "paused";
  }

  if (/^automation stopped$/i.test(checkpoint.title)) {
    return "paused";
  }

  if (/^automation update$/i.test(checkpoint.title)) {
    return "running";
  }

  if (checkpoint.status === "pending" && !isActivePendingAutomationCheckpoint(checkpoint, session)) {
    return "recorded";
  }

  if (checkpoint.status === "approved") {
    return "approved";
  }

  if (isActivePendingAutomationCheckpoint(checkpoint, session) && isBlockedAutomationCheckpoint(checkpoint, session)) {
    return "blocked";
  }

  if (/failed|needs review|stopped with an issue/i.test(checkpoint.title)) {
    return "failed";
  }

  return "paused";
}

function isBlockedAutomationCheckpoint(
  checkpoint: AutomationCheckpointRecord,
  session?: AutomationSessionRecord
) {
  const haystack = [
    checkpoint.title,
    checkpoint.summary,
    ...checkpoint.risks,
    ...checkpoint.nextActions,
    session?.stopReason ?? ""
  ]
    .join("\n")
    .toLowerCase();

  return /automation blocked|oracle strategist run completed without producing output|chrome window closed before oracle finished|lithium_oracle_visible=1|saved chatgpt session expired|chatgpt session expired/.test(
    haystack
  );
}

function isStrategistBrowserBlockedCheckpoint(
  checkpoint: AutomationCheckpointRecord,
  session?: AutomationSessionRecord
) {
  const haystack = [
    checkpoint.title,
    checkpoint.summary,
    ...checkpoint.risks,
    ...checkpoint.nextActions,
    session?.stopReason ?? ""
  ]
    .join("\n")
    .toLowerCase();

  return /chrome window closed before oracle finished|lithium_oracle_visible=1|saved chatgpt session expired|chatgpt session expired/.test(
    haystack
  );
}

function shouldSuppressResolvedAutomationCheckpointBody(
  checkpoint: AutomationCheckpointRecord,
  session?: AutomationSessionRecord,
  checkpoints: AutomationCheckpointRecord[] = [],
  steps: AutomationStepRecord[] = [],
  decisions: ProjectSnapshot["decisions"] = [],
  runs: ProjectSnapshot["runs"] = []
) {
  if (!isOperationalAutomationCheckpoint(checkpoint)) {
    return false;
  }

  const timestamp = checkpoint.updatedAt || checkpoint.createdAt;

  if (hasNewerOperationalAutomationEvent(checkpoint.sessionId, timestamp, checkpoints, steps, checkpoint.id)) {
    return true;
  }

  if (
    decisions.some((decision) => decision.createdAt > timestamp) ||
    runs.some((run) => {
      const runTimestamp = run.endedAt || run.startedAt || run.createdAt;
      const runSummary =
        handoffMachineSummary(run.handoff) ||
        extractCompactBuilderSummary(run.finalMessage || "");

      return runTimestamp > timestamp && !isOperationalAutomationMessage(runSummary);
    })
  ) {
    return true;
  }

  return Boolean(session?.status === "running" && checkpoint.status === "approved");
}

function isOperationalAutomationCheckpoint(checkpoint: AutomationCheckpointRecord) {
  return /automation interrupted after app restart|automation blocked on the strategist run|automation paused after the latest step|automation needs review after a failed run|automation failed|checkpoint ready|automation time budget reached|automation step budget reached/i.test(
    checkpoint.title
  );
}

function shouldSuppressAutomationRun(run: ProjectSnapshot["runs"][number], latestAutomationTimelineTimestamp: string) {
  if (!latestAutomationTimelineTimestamp || run.status === "running" || !isAutopilotPrompt(run.displayPrompt || run.prompt)) {
    return false;
  }

  if (handoffUserMessage(run.handoff)) {
    return false;
  }

  const runSummary =
    handoffMachineSummary(run.handoff) ||
    extractCompactBuilderSummary(stripBuilderFooterForDisplay(run.finalMessage).trim());

  if (!isOperationalAutomationMessage(runSummary)) {
    return false;
  }

  return latestAutomationTimelineTimestamp > (run.endedAt || run.startedAt);
}

function hasNewerOperationalAutomationEvent(
  sessionId: string,
  timestamp: string,
  checkpoints: AutomationCheckpointRecord[],
  steps: AutomationStepRecord[],
  currentId?: string
) {
  return (
    checkpoints.some(
      (checkpoint) =>
        checkpoint.sessionId === sessionId &&
        checkpoint.id !== currentId &&
        isOperationalAutomationCheckpoint(checkpoint) &&
        (checkpoint.updatedAt || checkpoint.createdAt) > timestamp
    ) ||
    steps.some(
      (step) =>
        step.sessionId === sessionId &&
        step.id !== currentId &&
        isOperationalAutomationMessage(step.summary.trim()) &&
        (step.completedAt || step.updatedAt) > timestamp
    )
  );
}

function resolveLatestAutomationTimelineTimestamp(
  sessions: AutomationSessionRecord[],
  steps: AutomationStepRecord[],
  checkpoints: AutomationCheckpointRecord[]
) {
  return [
    ...sessions.map((session) => session.updatedAt),
    ...steps.map((step) => step.completedAt || step.updatedAt),
    ...checkpoints.map((checkpoint) => checkpoint.updatedAt || checkpoint.createdAt)
  ]
    .filter(Boolean)
    .sort()
    .at(-1) || "";
}

function collapseDuplicateUserTaskItems(items: ChatItem[]) {
  const filtered: ChatItem[] = [];
  let lastVisibleUserPrompt = "";
  let lastVisibleUserTimestamp = "";

  for (const item of items) {
    if (item.role !== "user") {
      filtered.push(item);
      continue;
    }

    const normalizedBody = normalizePromptForComparison(item.body);
    const isTaskPrompt = item.id.startsWith("task:");
    const isSyntheticAutomationPrompt =
      item.id.startsWith("automation-session:") ||
      item.id.startsWith("automation-step-prompt:") ||
      item.id.startsWith("automation-checkpoint-prompt:");
    const isDuplicateTaskPrompt =
      isTaskPrompt &&
      normalizedBody &&
      normalizedBody === lastVisibleUserPrompt &&
      isNearDuplicateTimestamp(item.timestamp, lastVisibleUserTimestamp);
    const isDuplicateSyntheticAutomationPrompt =
      isSyntheticAutomationPrompt && normalizedBody && normalizedBody === lastVisibleUserPrompt;

    if (isDuplicateTaskPrompt || isDuplicateSyntheticAutomationPrompt) {
      continue;
    }

    filtered.push(item);

    if (normalizedBody) {
      lastVisibleUserPrompt = normalizedBody;
      lastVisibleUserTimestamp = item.timestamp;
    }
  }

  return filtered;
}

function normalizePromptForComparison(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function isNearDuplicateTimestamp(nextTimestamp: string, previousTimestamp: string) {
  if (!nextTimestamp || !previousTimestamp) {
    return false;
  }

  const nextTime = Date.parse(nextTimestamp);
  const previousTime = Date.parse(previousTimestamp);

  if (!Number.isFinite(nextTime) || !Number.isFinite(previousTime)) {
    return false;
  }

  return Math.abs(nextTime - previousTime) <= 5 * 60 * 1000;
}

function buildChatArtifactRefs(paths: string[], workspaceFiles: WorkspaceFileRecord[]) {
  if (!paths.length || !workspaceFiles.length) {
    return [];
  }

  const seen = new Set<string>();
  const refs = [];

  for (const rawPath of paths) {
    const normalized = normalizePath(rawPath);
    const file =
      workspaceFiles.find((candidate) => normalizePath(candidate.relativePath) === normalized) ??
      workspaceFiles.find((candidate) => normalizePath(candidate.path) === normalized) ??
      workspaceFiles.find((candidate) => normalized.endsWith(`/${normalizePath(candidate.relativePath)}`));

    if (!file || seen.has(file.path)) {
      continue;
    }

    seen.add(file.path);
    refs.push({
      id: file.path,
      path: file.path,
      relativePath: file.relativePath,
      label: formatChatArtifactLabel(file.relativePath),
      kind: file.kind,
      artifactKind: file.artifactKind
    });
  }

  return refs.slice(0, 8);
}

export function buildAttachmentArtifactRefs(
  attachments: AttachmentRecord[],
  workspaceFiles: WorkspaceFileRecord[],
  workspacePath: string
) {
  if (!attachments.length) {
    return [];
  }

  const seen = new Set<string>();
  const refs = [];

  for (const attachment of attachments) {
    const absolutePath = joinWorkspacePath(workspacePath, attachment.relativePath);
    const file =
      workspaceFiles.find((candidate) => normalizePath(candidate.path) === absolutePath) ??
      workspaceFiles.find(
        (candidate) => normalizePath(candidate.relativePath) === normalizePath(attachment.relativePath)
      );
    const resolvedPath = file?.path ?? absolutePath;

    if (seen.has(resolvedPath)) {
      continue;
    }

    seen.add(resolvedPath);
    refs.push({
      id: attachment.id,
      path: resolvedPath,
      relativePath: attachment.relativePath,
      label: attachment.name,
      kind: file?.kind ?? "artifact",
      artifactKind: file?.artifactKind ?? attachmentKindToArtifactKind(attachment.kind)
    });
  }

  return refs.slice(0, 8);
}

function formatChatArtifactLabel(relativePath: string) {
  const normalized = normalizePath(relativePath);
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length <= 2) {
    return normalized;
  }

  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function resolveThreadTitle(snapshot: ProjectSnapshot) {
  return (
    snapshot.activeThread?.title ||
    snapshot.latestConversationEntry?.body ||
    snapshot.latestDecision?.summary ||
    snapshot.project?.name ||
    "Lithium"
  );
}

function formatConversationEntry(
  entry: ConversationEntryRecord,
  order: number,
  artifacts?: ChatItem["artifacts"]
): ChatItem {
  const variant =
    entry.source === "automation" || entry.source === "checkpoint"
      ? "neutral"
      : entry.role === "assistant"
      ? "research"
      : "neutral";

  return {
    id: `conversation:${entry.id}`,
    role: entry.role,
    variant,
    title:
      entry.role === "user"
        ? "You"
        : entry.role === "system"
        ? "Automation"
        : "Lithium",
    body: entry.body.trim(),
    timestamp: entry.createdAt,
    order,
    artifacts
  };
}

function attachmentKindToArtifactKind(kind: AttachmentRecord["kind"]): ArtifactKind {
  switch (kind) {
    case "text":
    case "json":
    case "csv":
    case "pdf":
    case "image":
      return kind;
    default:
      return "other";
  }
}

function groupAttachmentsBy<K extends "conversationEntryId" | "decisionId" | "runId">(
  attachments: AttachmentRecord[],
  key: K
) {
  const groups = new Map<string, AttachmentRecord[]>();

  for (const attachment of attachments) {
    const id = attachment[key];

    if (!id) {
      continue;
    }

    const current = groups.get(id) ?? [];
    current.push(attachment);
    groups.set(id, current);
  }

  return groups;
}

function joinWorkspacePath(workspacePath: string, relativePath: string) {
  const normalizedWorkspace = normalizePath(workspacePath).replace(/\/+$/, "");
  const normalizedRelative = normalizePath(relativePath).replace(/^\/+/, "");

  if (!normalizedWorkspace) {
    return normalizedRelative ? `/${normalizedRelative}` : "";
  }

  return normalizedRelative ? `${normalizedWorkspace}/${normalizedRelative}` : normalizedWorkspace;
}

function toOptionalArtifacts(artifacts: ChatItem["artifacts"] | []) {
  return artifacts && artifacts.length ? artifacts : undefined;
}

export function resolveWorkspaceSurfaceTitle(
  projectName: string | null | undefined,
  appState?: Pick<RuntimeAppState, "selectedWorkspaceLabel" | "selectedWorkspacePath"> | null
) {
  const normalizedProjectName = projectName?.trim() || "";

  if (normalizedProjectName) {
    return normalizedProjectName;
  }

  const normalizedWorkspaceLabel = appState?.selectedWorkspaceLabel?.trim() || "";

  if (normalizedWorkspaceLabel) {
    return normalizedWorkspaceLabel;
  }

  const normalizedWorkspacePath = normalizePath(appState?.selectedWorkspacePath || "");
  const fallbackLabel = normalizedWorkspacePath.split("/").filter(Boolean).pop() || "";

  return fallbackLabel || "Lithium";
}

export function formatThreadLabel(thread: ThreadRecord, index: number, fallback?: string) {
  const raw = fallback || thread.title || `Chat ${index + 1}`;

  return raw
    .replace(/^New thread\b/i, "New chat")
    .replace(/^Thread\b/i, "Chat");
}

export function formatTerminalDirectory(cwd: string, workspacePath: string) {
  if (!workspacePath) {
    return cwd;
  }

  const normalizedWorkspace = normalizePath(workspacePath);
  const normalizedCwd = normalizePath(cwd);

  if (!normalizedCwd.startsWith(normalizedWorkspace)) {
    return normalizedCwd;
  }

  const relative = normalizedCwd.slice(normalizedWorkspace.length).replace(/^\/+/, "");
  return relative ? `./${relative}` : ".";
}

export function formatTerminalPrompt(cwd: string, workspacePath: string) {
  return `${formatTerminalDirectory(cwd, workspacePath)} $`;
}

export function formatTerminalStatus(status: string) {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "running":
      return "Running…";
    default:
      return "Idle";
  }
}

export function buildOnboardingChecklist(
  appState: RuntimeAppState | null,
  _projectReady: boolean
): OnboardingChecklistItem[] {
  if (!appState) {
    return [];
  }

  const strategist = appState.oracleChromePath
    ? appState.settings.strategistSessionReady
      ? {
          id: "strategist" as const,
          title: "Strategist lane",
          status: "ready" as const,
          detail:
            "The ChatGPT Pro browser session has already been verified. Future strategist runs should stay invisible and reuse it quietly in the background.",
          hint:
            "If that session expires, reset strategist sign-in from Settings and let the next strategist run open the browser once."
        }
      : {
          id: "strategist" as const,
          title: "Strategist lane",
          status: "action" as const,
          detail:
            "On your first strategist run, Lithium will open a visible browser so you can sign in with the ChatGPT account that has the Pro subscription.",
          hint:
            "After the first successful run, later strategist calls should reuse that browser session in the background without opening a visible window."
        }
    : {
        id: "strategist" as const,
        title: "Strategist lane",
        status: "action" as const,
        detail:
          "Install Chrome or Chromium first. The strategist lane signs in through a real ChatGPT Pro browser session on first use.",
        hint: "Restart the app after installing the browser so Lithium can detect it."
      };

  const builder = appState.codexReady
    ? {
        id: "builder" as const,
        title: "Builder lane",
        status: "ready" as const,
        detail: "Codex CLI is available in PATH.",
        hint: "Builder tasks can edit files and run commands inside the selected workspace."
      }
    : {
        id: "builder" as const,
        title: "Builder lane",
        status: "action" as const,
        detail: "Install Codex CLI and make sure the `codex` command is available in PATH.",
        hint: "Without Codex, the app can plan work but cannot run the builder lane."
      };

  const workspace = appState.selectedWorkspacePath
    ? {
        id: "workspace" as const,
        title: "Workspace",
        status: "ready" as const,
        detail:
          appState.selectedWorkspaceKind === "local"
            ? `Workspace selected: ${appState.selectedWorkspaceLabel || appState.selectedWorkspacePath}`
            : `Remote workspace selected: ${appState.selectedWorkspaceLabel || appState.selectedWorkspacePath}`,
        hint:
          appState.selectedWorkspaceKind === "local"
            ? "Code, paper, results, and attachments will all stay in this folder."
            : "Lithium edits the local mirror, syncs saves over SSH, and opens the terminal on the remote target."
      }
    : {
        id: "workspace" as const,
        title: "Workspace",
        status: "action" as const,
        detail: "Open a local folder with Cmd+O, or just start chatting and let Lithium create an untitled workspace on first use.",
        hint: "Lithium only creates .lithium after the first research action."
      };

  return [strategist, builder, workspace];
}

export function resolveInitialSurface() {
  if (typeof window === "undefined") {
    return "chat";
  }

  const value = new URLSearchParams(window.location.search).get("surface");

  if (value === "memory") {
    return value;
  }

  if (value === "paper" && WORKBENCH_SURFACES_ENABLED) {
    return value;
  }

  return "chat";
}

export function toMemoryDraft(memory: ProjectMemoryRecord | null): MemoryDraft {
  if (!memory) {
    return {
      projectBrief: "",
      researchGoal: "",
      openQuestions: "",
      activeHypotheses: ""
    };
  }

  return {
    projectBrief: memory.projectBrief,
    researchGoal: memory.researchGoal,
    openQuestions: memory.openQuestions.join("\n"),
    activeHypotheses: memory.activeHypotheses.join("\n")
  };
}

export function toThreadMemoryDraft(thread: ThreadRecord | null | undefined): ThreadMemoryDraft {
  return {
    memory: thread?.memory ?? ""
  };
}

export function fullDecisionBody(summary: string, rationale: string) {
  return [`Summary`, summary, rationale ? "" : null, rationale ? `Rationale` : null, rationale || null]
    .filter(Boolean)
    .join("\n");
}

export function formatDecisionBody(
  summary: string,
  rationale: string,
  rawOutput = "",
  preferSummary = false,
  handoff?: LithiumHandoff | null,
  inputFiles: string[] = [],
  workspacePath = ""
) {
  const attachmentPrelude = formatStrategistInputFiles(
    inputFiles,
    workspacePath,
    containsHangul([summary, rawOutput, handoffUserMessage(handoff)].join("\n"))
  );

  if (preferSummary) {
    const normalizedSummary = simplifyStrategistDisplayText(summary);

    if (normalizedSummary) {
      return combineStrategistPrelude(attachmentPrelude, normalizedSummary);
    }
  }

  const handoffMessage = simplifyStrategistDisplayText(handoffUserMessage(handoff));

  if (handoffMessage) {
    return combineStrategistPrelude(attachmentPrelude, handoffMessage);
  }

  const displayReply = extractVisibleStrategistReply(rawOutput);

  if (displayReply) {
    return combineStrategistPrelude(attachmentPrelude, displayReply);
  }

  const normalizedSummary = simplifyStrategistDisplayText(summary);

  if (normalizedSummary) {
    return combineStrategistPrelude(attachmentPrelude, normalizedSummary);
  }

  const normalizedRationale = simplifyStrategistDisplayText(rationale);

  if (normalizedRationale) {
    return combineStrategistPrelude(attachmentPrelude, normalizedRationale);
  }

  return combineStrategistPrelude(attachmentPrelude, "Lithium returned a strategist note.");
}

function extractVisibleStrategistReply(rawOutput: string) {
  const stripped = stripStrategistFooterForDisplay(rawOutput).trim();

  if (!stripped || looksLikeStructuredStrategistOnly(stripped)) {
    return "";
  }

  return simplifyStrategistDisplayText(stripped);
}

function simplifyStrategistDisplayText(value: string) {
  return inlineReferenceLinks(value)
    .replace(/\n\s*[*_`>~-]*입니다\.?[*_`>~-]*\s*(?=\n|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function combineStrategistPrelude(prelude: string, body: string) {
  return [prelude, body].filter(Boolean).join("\n\n");
}

function formatStrategistInputFiles(inputFiles: string[], workspacePath: string, preferKorean = false) {
  const uniqueFiles = Array.from(new Set(inputFiles.map((value) => value.trim()).filter(Boolean))).slice(0, 4);

  if (!uniqueFiles.length) {
    return "";
  }

  const labels = uniqueFiles.map((filePath) => {
    const label = formatStrategistInputFileLabel(filePath, workspacePath);
    return `[${label}](${filePath})`;
  });
  const suffix = inputFiles.length > uniqueFiles.length ? ` 외 ${inputFiles.length - uniqueFiles.length}개` : "";
  return preferKorean
    ? `참고한 파일: ${labels.join(", ")}${suffix}`
    : `Referenced files: ${labels.join(", ")}${suffix}`;
}

function formatStrategistInputFileLabel(filePath: string, workspacePath: string) {
  const trimmedPath = filePath.trim();
  const trimmedWorkspace = workspacePath.trim();

  if (trimmedWorkspace && trimmedPath.startsWith(`${trimmedWorkspace}/`)) {
    return trimmedPath.slice(trimmedWorkspace.length + 1);
  }

  return trimmedPath.split("/").filter(Boolean).slice(-2).join("/");
}

function containsHangul(value: string) {
  return /[\u3131-\u318E\uAC00-\uD7A3]/.test(value);
}

function looksLikeStructuredStrategistOnly(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return true;
  }

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || trimmed === "LITHIUM_HANDOFF") {
    return true;
  }

  const meaningfulLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!meaningfulLines.length) {
    return true;
  }

  return meaningfulLines.every((line) =>
    /^(summary|machine_summary|user_message|next[_ ]task|rationale|files|risks|paper_actions|run_actions|success_criteria|open_questions)\s*:/i.test(
      line
    )
  );
}

function inlineReferenceLinks(value: string) {
  const definitions = new Map<string, string>();
  const bodyLines: string[] = [];

  for (const line of value.split("\n")) {
    const definitionMatch = line.match(/^\s*\[([^\]]+)\]:\s+(\S+)(?:\s+.+)?$/);

    if (definitionMatch) {
      definitions.set(definitionMatch[1].trim().toLowerCase(), definitionMatch[2].trim());
      continue;
    }

    bodyLines.push(line);
  }

  if (!definitions.size) {
    return value;
  }

  return bodyLines
    .join("\n")
    .replace(/\[([^\]]+)\]\[([^\]]+)\]/g, (match, label: string, referenceId: string) => {
      const target = definitions.get(referenceId.trim().toLowerCase());
      return target ? `[${label}](${target})` : match;
    });
}

function buildProcessChatItem(
  trace: NonNullable<ProjectSnapshot["routerTraces"]>[number],
  order: number,
  input: {
    decision?: ProjectSnapshot["decisions"][number] | null;
    run?: ProjectSnapshot["runs"][number] | null;
  }
): ChatItem {
  return {
    id: `route:${trace.id}`,
    role: "system",
    variant: "trace",
    title: "Process",
    body: formatProcessSummary(trace.finalRoute, input.run?.status === "running"),
    timestamp: trace.createdAt || trace.decidedAt || trace.completedAt,
    order,
    badges: buildProcessBadges(trace, input),
    details: buildProcessDetails(trace, input)
  };
}

function formatProcessSummary(route: NonNullable<ProjectSnapshot["routerTraces"]>[number]["finalRoute"], running = false) {
  if (route === "mixed") {
    return running ? "Strategist -> Builder" : "Strategist -> Builder";
  }

  if (route === "builder") {
    return running ? "Builder running" : "Builder route";
  }

  return "Strategist route";
}

function buildProcessBadges(
  trace: NonNullable<ProjectSnapshot["routerTraces"]>[number],
  input: {
    decision?: ProjectSnapshot["decisions"][number] | null;
    run?: ProjectSnapshot["runs"][number] | null;
  }
) {
  const badges = [describeRouterBadge(trace)];

  if (input.decision) {
    badges.push(
      `Strategist · ${humanizeModelName(input.decision.model)}${
        input.decision.engine === "browser" ? " via ChatGPT" : ""
      }`
    );
  }

  if (input.run) {
    badges.push(`Builder · ${humanizeModelName(input.run.model)}`);
  }

  return badges;
}

function buildProcessDetails(
  trace: NonNullable<ProjectSnapshot["routerTraces"]>[number],
  input: {
    decision?: ProjectSnapshot["decisions"][number] | null;
    run?: ProjectSnapshot["runs"][number] | null;
  }
) {
  const details = [
    trace.reasonShort.trim() ? `Why: ${trace.reasonShort.trim()}` : "",
    trace.requestedRoute ? `Override: forced to ${formatRouteLabel(trace.finalRoute)}` : "",
    shouldShowPromptRewrite(trace) ? `Rewrite: ${truncateText(trace.rewrittenPrompt.trim(), 220)}` : "",
    input.decision
      ? `Strategist response model: ${humanizeModelName(input.decision.model)}${
          input.decision.engine === "browser" ? " in the ChatGPT browser session" : ""
        }`
      : "",
    input.run
      ? `Builder run: ${humanizeModelName(input.run.model)}${
          input.run.status === "running" ? " still running" : ` finished as ${input.run.status}`
        }`
      : "",
    trace.downstreamError ? `Downstream error: ${trace.downstreamError}` : ""
  ].filter(Boolean);

  return details;
}

function describeRouterBadge(trace: NonNullable<ProjectSnapshot["routerTraces"]>[number]) {
  const model = extractCommandFlagValue(trace.command.args, "--model") || "gpt-5.4";
  const reasoning = extractReasoningEffort(trace.command.args) || "xhigh";
  return `Router · ${humanizeModelName(model)}${reasoning ? ` ${reasoning}` : ""}`;
}

function extractCommandFlagValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

function extractReasoningEffort(args: string[]) {
  const configArg = args.find((arg) => arg.includes("model_reasoning_effort"));
  const match = configArg?.match(/model_reasoning_effort="?([a-z]+)"?/i);
  return match?.[1]?.toLowerCase() ?? "";
}

function shouldShowPromptRewrite(trace: NonNullable<ProjectSnapshot["routerTraces"]>[number]) {
  const normalized = trace.normalizedPrompt.trim();
  const rewritten = trace.rewrittenPrompt.trim();
  return Boolean(rewritten && normalized && rewritten !== normalized);
}

function formatRouteLabel(route: NonNullable<ProjectSnapshot["routerTraces"]>[number]["finalRoute"]) {
  return route === "mixed" ? "strategist then builder" : route;
}

function humanizeModelName(value: string) {
  const normalized = value.trim().toLowerCase();

  if (!normalized.startsWith("gpt-")) {
    return value.trim();
  }

  const segments = normalized.slice(4).split("-").filter(Boolean);
  const version = segments.shift() ?? "";
  const suffix = segments
    .map((segment) =>
      segment === "pro" ? "Pro" : segment === "codex" ? "Codex" : segment.toUpperCase()
    )
    .join(" ");

  return [`GPT-${version}`, suffix].filter(Boolean).join(" ").trim();
}

export function formatBuilderBody(
  run: ProjectSnapshot["runs"][number],
  builderInspection: Pick<BuilderRunInspection, "progressSummary" | "progressDetails" | "activeCommand"> | null = null
) {
  if (run.status === "running") {
    const liveBody = formatLiveProgressBody(builderInspection);

    if (liveBody) {
      return liveBody;
    }

    return "Lithium is still working on this task.";
  }

  const handoffMessage = handoffUserMessage(run.handoff);

  if (handoffMessage) {
    return handoffMessage;
  }

  const body = stripBuilderFooterForDisplay(run.finalMessage).trim();

  if (body && !looksLikeInternalExecutionTranscript(body) && !looksLikeInternalBuilderStatusMessage(body)) {
    return body;
  }

  const compactAutomationSummary = isAutopilotPrompt(run.displayPrompt || run.prompt)
    ? handoffMachineSummary(run.handoff) || extractCompactBuilderSummary(body)
    : "";

  if (compactAutomationSummary) {
    if (looksLikeInternalBuilderStatusMessage(compactAutomationSummary)) {
      if (run.status === "failed" || run.status === "cancelled") {
        return "직전 단계가 깔끔하게 끝나지 않았습니다. 자동으로 다음 복구 경로를 정리하고 있습니다.";
      }

      return "방금 끝난 단계를 정리하고 있습니다.";
    }

    return compactAutomationSummary;
  }

  if (looksLikeInternalExecutionTranscript(body)) {
    if (run.status === "cancelled") {
      return "Stopped after finishing the current step.";
    }

    return "Internal execution log hidden.";
  }

  return body || "Lithium completed the task without a final message.";
}

export function formatLiveProgressBody(
  progress:
    | Pick<BuilderRunInspection, "progressSummary" | "progressDetails" | "activeCommand">
    | Pick<ChatProgressInspection, "progressSummary" | "progressDetails" | "activeCommand">
    | null
) {
  if (!progress) {
    return "";
  }

  const summary = progress.progressSummary.trim();
  const lines: string[] = [];

  if (progress.progressDetails.length) {
    for (const detail of progress.progressDetails) {
      if (detail.trim()) {
        lines.push(detail.trim());
      }
    }
  }

  if (summary && !lines.includes(summary)) {
    lines.push(summary);
  }

  const command = progress.activeCommand?.trim() || "";

  if (command && (!summary || isGenericLiveProgressSummary(summary)) && !lines.some((line) => line.includes(command))) {
    lines.push(`Command: \`${truncateText(command, 160)}\``);
  }

  if (!lines.length) {
    return "";
  }

  return lines.join("\n\n");
}

function isGenericLiveProgressSummary(value: string) {
  return /^(thinking|thinking…|working|working…|starting|starting…|researching|researching…|finishing|finishing…|routing your message\.?)$/i.test(
    value.trim()
  );
}

function extractCompactBuilderSummary(value: string) {
  const normalized = value.replace(/\n{3,}/g, "\n\n").trim();

  if (!normalized) {
    return "";
  }

  const firstParagraph = normalized.split(/\n\s*\n/).find((paragraph) => paragraph.trim()) ?? normalized;
  return truncateText(firstParagraph.replace(/\s+/g, " ").trim(), 220);
}

function looksLikeInternalBuilderStatusMessage(value: string) {
  return isOperationalAutomationMessage(value);
}

export function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

export function basenamePath(value: string) {
  return normalizePath(value).split("/").pop() ?? value;
}

export function isUntitledCodePath(value: string) {
  return normalizePath(value).startsWith(UNTITLED_CODE_PREFIX);
}

export function untitledCodeLabel(value: string) {
  const match = normalizePath(value).match(/^untitled:(\d+)$/);
  const index = Number(match?.[1] ?? 1);
  return `Untitled-${Number.isFinite(index) && index > 0 ? index : 1}`;
}

export function nextUntitledCodePath(values: string[]) {
  const maxIndex = values.reduce((currentMax, value) => {
    const match = normalizePath(value).match(/^untitled:(\d+)$/);
    const index = Number(match?.[1] ?? 0);
    return Number.isFinite(index) ? Math.max(currentMax, index) : currentMax;
  }, 0);

  return `${UNTITLED_CODE_PREFIX}${maxIndex + 1}`;
}

export function normalizeNewCodeFilePath(value: string) {
  const input = normalizePath(value.trim());

  if (!input || input.startsWith("/") || /^[A-Za-z]:\//.test(input)) {
    return "";
  }

  const normalized = input
    .replace(/^\.\//, "")
    .split("/")
    .filter((segment) => segment && segment !== ".");

  if (!normalized.length || normalized.some((segment) => segment === "..")) {
    return "";
  }

  return normalized.join("/");
}

export function suggestNewCodeFilePath(files: WorkspaceFileRecord[]) {
  const normalizedPaths = new Set(files.map((file) => normalizePath(file.relativePath)));
  const preferredRoot = ["experiments", "src", "scripts", "results"].find((root) =>
    [...normalizedPaths].some((relativePath) => relativePath === root || relativePath.startsWith(`${root}/`))
  );
  const extension = preferredRoot === "results" ? ".json" : ".py";
  const baseRoot = preferredRoot ? `${preferredRoot}/` : "";

  for (let index = 1; index < 500; index += 1) {
    const stem = index === 1 ? "untitled" : `untitled-${index}`;
    const candidate = `${baseRoot}${stem}${extension}`;

    if (!normalizedPaths.has(candidate)) {
      return candidate;
    }
  }

  return `${baseRoot}untitled${extension}`;
}

export function summarizeContextPack(value: string, maxLines = 26) {
  const lines = value.trimEnd().split("\n");

  if (lines.length <= maxLines) {
    return value.trim();
  }

  const remaining = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join("\n")}\n… ${remaining} more line${remaining === 1 ? "" : "s"}`;
}

function looksLikeInternalExecutionTranscript(value: string) {
  if (!value.trim()) {
    return false;
  }

  const legacyMarkers = [
    /^OpenAI Codex v/im.test(value),
    /\nuser\s*\nYou are the Lithium builder/i.test(value),
    /\nCONTEXT_PACK:\n/i.test(value) ||
      /\nRUNTIME_CONTEXT:\n/i.test(value) ||
      /\nFULL_ARTIFACT_CONTEXT:\n/i.test(value),
    /\nexec\s*\n\/bin\/zsh -lc/i.test(value),
    /\nPlan update\s*\n/i.test(value)
  ].filter(Boolean).length;

  if (legacyMarkers >= 2) {
    return true;
  }

  const jsonMarkers = [
    /(?:^|\s)\{"type":"thread\.(?:started|completed)"/m.test(value),
    /(?:^|\s)\{"type":"turn\.(?:started|completed)"/m.test(value),
    /"type":"item\.(?:started|completed|updated)"/.test(value),
    /"type":"(?:agent_message|command_execution|web_search|todo_list)"/.test(value)
  ].filter(Boolean).length;

  if (jsonMarkers >= 3) {
    return true;
  }

  return (value.match(/\{"type":"[^"]+"/g)?.length ?? 0) >= 4;
}

export function handoffItems(handoff: LithiumHandoff | null | undefined) {
  if (!handoff) {
    return [];
  }

  return [
    { label: "Files", values: handoff.files },
    { label: "Risks", values: handoff.risks },
    { label: "Paper", values: handoff.paperActions },
    { label: "Runs", values: handoff.runActions },
    { label: "Success", values: handoff.successCriteria },
    { label: "Open", values: handoff.openQuestions }
  ].filter((entry) => entry.values.length);
}

export function stripBuilderFooterForDisplay(finalMessage: string) {
  return finalMessage.replace(/\n*LITHIUM_STATUS[\s\S]*$/m, "").trim();
}

export function stripStrategistFooterForDisplay(rawOutput: string) {
  return rawOutput.replace(/\n*LITHIUM_HANDOFF[\s\S]*$/m, "").trim();
}

export function sortCodeExplorerFiles(files: WorkspaceFileRecord[]) {
  return [...files]
    .filter((file) => !isResultSummary(file.relativePath))
    .sort((left, right) => compareExplorerPaths(left.relativePath, right.relativePath));
}

export function sortPaperExplorerFiles(files: WorkspaceFileRecord[]) {
  return [...files].sort((left, right) => {
    const priorityDifference = paperPriority(left.relativePath) - paperPriority(right.relativePath);
    return priorityDifference || normalizePath(left.relativePath).localeCompare(normalizePath(right.relativePath));
  });
}

export function selectPreferredCodePath(files: WorkspaceFileRecord[], changedFiles: string[]) {
  const changedPaths = changedFiles.map(normalizePath);
  const changedCandidate = files.find((file) =>
    changedPaths.some((changedPath) => {
      const relativePath = normalizePath(file.relativePath);
      return changedPath === relativePath || changedPath.endsWith(`/${relativePath}`);
    })
  );

  if (changedCandidate) {
    return changedCandidate.path;
  }

  const experimentCandidate = files.find((file) => normalizePath(file.relativePath).startsWith("experiments/"));
  if (experimentCandidate) {
    return experimentCandidate.path;
  }

  const srcCandidate = files.find((file) => normalizePath(file.relativePath).startsWith("src/"));
  if (srcCandidate) {
    return srcCandidate.path;
  }

  return files[0]?.path ?? "";
}

export function selectPreferredPaperPath(files: WorkspaceFileRecord[], hasRun: boolean) {
  if (!files.length) {
    return "";
  }

  const mainTex = files.find((file) => normalizePath(file.relativePath) === "paper/main.tex");
  if (mainTex) {
    return mainTex.path;
  }

  if (hasRun) {
    const resultsSection = files.find((file) => normalizePath(file.relativePath) === "paper/sections/results.tex");
    if (resultsSection) {
      return resultsSection.path;
    }
  }

  const texFile = files.find((file) => normalizePath(file.relativePath).endsWith(".tex"));
  if (texFile) {
    return texFile.path;
  }

  return files[0]?.path ?? "";
}

export function resolvePdfPreviewPath(selectedPaperPath: string, paperFiles: WorkspaceFileRecord[]) {
  const mainPdf = paperFiles.find((file) => normalizePath(file.relativePath) === "paper/main.pdf")?.path;

  if (selectedPaperPath.toLowerCase().endsWith(".pdf")) {
    return selectedPaperPath;
  }

  const siblingPdf = selectedPaperPath
    ? paperFiles.find((file) => file.path === selectedPaperPath.replace(/\.[^.]+$/, ".pdf"))?.path
    : null;

  return siblingPdf || mainPdf || paperFiles.find((file) => file.path.toLowerCase().endsWith(".pdf"))?.path || null;
}

function paperPriority(relativePath: string) {
  const normalized = normalizePath(relativePath);
  if (normalized === "paper/main.tex") return 0;
  if (normalized.startsWith("paper/sections/")) return 1 + paperSectionPriority(normalized);
  if (normalized === "paper/references.bib") return 20;
  if (normalized.endsWith(".pdf")) return 30;
  return 4;
}

export function buildExplorerRows(
  files: WorkspaceFileRecord[],
  changedFiles: string[],
  collapsedFolders: Record<string, boolean>
) {
  type DirectoryNode = {
    name: string;
    path: string;
    directories: Map<string, DirectoryNode>;
    files: WorkspaceFileRecord[];
  };

  const root: DirectoryNode = {
    name: "",
    path: "",
    directories: new Map(),
    files: []
  };

  for (const file of files) {
    const normalized = normalizePath(file.relativePath);
    const parts = normalized.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";

    for (const segment of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const next = current.directories.get(segment) ?? {
        name: segment,
        path: currentPath,
        directories: new Map(),
        files: []
      };
      current.directories.set(segment, next);
      current = next;
    }

    current.files.push(file);
  }

  const rows: ExplorerRow[] = [];
  const changedPaths = changedFiles.map(normalizePath);

  const walk = (node: DirectoryNode, depth: number) => {
    const directories = [...node.directories.values()].sort((left, right) =>
      compareExplorerPaths(left.path, right.path)
    );
    const fileEntries = [...node.files].sort((left, right) =>
      compareExplorerPaths(left.relativePath, right.relativePath)
    );

    for (const directory of directories) {
      const collapsed = collapsedFolders[directory.path] ?? false;
      rows.push({
        id: `dir:${directory.path}`,
        kind: "dir",
        label: directory.name,
        depth,
        path: directory.path,
        collapsed
      });

      if (!collapsed) {
        walk(directory, depth + 1);
      }
    }

    for (const file of fileEntries) {
      const relativePath = normalizePath(file.relativePath);
      rows.push({
        id: `file:${file.path}`,
        kind: "file",
        label: file.name,
        depth,
        path: file.path,
        changed: changedPaths.some(
          (changedPath) => changedPath === relativePath || changedPath.endsWith(`/${relativePath}`)
        )
      });
    }
  };

  walk(root, 0);
  return rows;
}

export function buildCollapsedCodeFolderState(
  files: WorkspaceFileRecord[],
  currentState: Record<string, boolean> = {}
) {
  const nextState: Record<string, boolean> = {};

  for (const directoryPath of collectExplorerDirectoryPaths(files)) {
    nextState[directoryPath] = currentState[directoryPath] ?? true;
  }

  return nextState;
}

export function expandCollapsedFolderAncestors(
  collapsedFolders: Record<string, boolean>,
  relativePath: string
) {
  const nextFolders = { ...collapsedFolders };

  for (const directoryPath of collectAncestorDirectoryPaths(relativePath)) {
    nextFolders[directoryPath] = false;
  }

  return nextFolders;
}

function collectExplorerDirectoryPaths(files: WorkspaceFileRecord[]) {
  const paths = new Set<string>();

  for (const file of files) {
    for (const directoryPath of collectAncestorDirectoryPaths(file.relativePath)) {
      paths.add(directoryPath);
    }
  }

  return [...paths].sort(compareExplorerPaths);
}

function collectAncestorDirectoryPaths(relativePath: string) {
  const segments = normalizePath(relativePath).split("/").filter(Boolean).slice(0, -1);
  const paths: string[] = [];
  let currentPath = "";

  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    paths.push(currentPath);
  }

  return paths;
}

export function selectPaperWorkbenchFiles(files: WorkspaceFileRecord[]) {
  const normalizedFiles = files.filter((file) => {
    const relativePath = normalizePath(file.relativePath);
    return relativePath.startsWith("paper/");
  });

  const source = normalizedFiles.length ? normalizedFiles : files;
  return source.filter((file) => {
    const normalized = normalizePath(file.relativePath);
    return (
      normalized.endsWith(".tex") ||
      normalized.endsWith(".bib") ||
      normalized.endsWith(".md") ||
      normalized.endsWith(".txt") ||
      normalized.endsWith(".pdf")
    );
  });
}

export function extractLatexOutlineRows(
  selectedPaperPath: string,
  currentContent: string,
  files: WorkspaceFileRecord[]
) {
  const selectedFile = files.find((file) => file.path === selectedPaperPath);
  if (!selectedFile) {
    return [];
  }

  const currentDir = normalizePath(selectedFile.relativePath).split("/").slice(0, -1).join("/");
  const rows: PaperOutlineRow[] = [];
  const lines = currentContent.split("\n");
  const sectionPattern = /\\(section|subsection|subsubsection)\*?\{([^}]*)\}/;
  const inputPattern = /\\input\{([^}]+)\}/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionMatch = line.match(sectionPattern);
    if (sectionMatch) {
      rows.push({
        id: `outline:${selectedPaperPath}:${index}`,
        kind: "file",
        label: sectionMatch[2].trim(),
        path: selectedPaperPath,
        tone: "section",
        lineNumber: index + 1
      });
      continue;
    }

    const inputMatch = line.match(inputPattern);
    if (inputMatch) {
      const resolved = resolveInputTarget(currentDir, inputMatch[1], files);
      rows.push({
        id: `input:${selectedPaperPath}:${index}`,
        kind: "file",
        label: formatPaperLabel(resolved?.relativePath ?? inputMatch[1]),
        path: resolved?.path ?? selectedPaperPath,
        tone: "section",
        lineNumber: resolved?.path ? undefined : index + 1
      });
    }
  }

  return rows;
}

export function formatPaperLabel(relativePath: string) {
  const normalized = normalizePath(relativePath);

  if (normalized === "paper/main.tex") {
    return "Main document";
  }

  if (normalized === "paper/references.bib") {
    return "References";
  }

  const fileName = normalized.split("/").pop() ?? normalized;
  const stem = fileName.replace(/\.[^.]+$/, "");

  switch (stem) {
    case "abstract":
      return "Abstract";
    case "introduction":
      return "Introduction";
    case "related_work":
      return "Related Work";
    case "methods":
      return "Methods";
    case "experiment":
    case "experimental_setup":
      return "Experimental Setup";
    case "results":
      return "Results";
    case "discussion":
      return "Discussion";
    case "conclusion":
      return "Conclusion";
    case "appendix":
      return "Appendix";
    default:
      return stem
        .split(/[_-]/)
        .filter(Boolean)
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(" ");
  }
}

export function resolveInputTarget(currentDir: string, inputValue: string, files: WorkspaceFileRecord[]) {
  const normalizedInput = normalizePath(inputValue).replace(/^\.\//, "");
  const candidates = [
    normalizedInput,
    `${normalizedInput}.tex`,
    currentDir ? `${currentDir}/${normalizedInput}` : normalizedInput,
    currentDir ? `${currentDir}/${normalizedInput}.tex` : `${normalizedInput}.tex`,
    normalizedInput.startsWith("paper/") ? normalizedInput : `paper/${normalizedInput}`,
    normalizedInput.startsWith("paper/") ? `${normalizedInput}.tex` : `paper/${normalizedInput}.tex`
  ];

  const match = candidates.find((candidate) =>
    files.some((file) => normalizePath(file.relativePath) === candidate)
  );

  return files.find((file) => normalizePath(file.relativePath) === match) ?? null;
}

export function normalizePath(value: string) {
  return value.replace(/\\/g, "/");
}

export function compareExplorerPaths(left: string, right: string) {
  const leftParts = normalizePath(left).split("/").filter(Boolean);
  const rightParts = normalizePath(right).split("/").filter(Boolean);
  const leftRoot = leftParts[0] ?? "";
  const rightRoot = rightParts[0] ?? "";
  const rootDifference = codeRootPriority(leftRoot) - codeRootPriority(rightRoot);

  if (rootDifference !== 0) {
    return rootDifference;
  }

  return normalizePath(left).localeCompare(normalizePath(right));
}

function codeRootPriority(segment: string) {
  switch (segment) {
    case "experiments":
      return 0;
    case "results":
      return 1;
    case "src":
      return 2;
    case "scripts":
      return 3;
    default:
      return 10;
  }
}

function paperSectionPriority(relativePath: string) {
  const fileName = normalizePath(relativePath).split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  switch (fileName) {
    case "abstract":
      return 0;
    case "introduction":
      return 1;
    case "related_work":
      return 2;
    case "methods":
      return 3;
    case "experiment":
    case "experimental_setup":
      return 4;
    case "results":
      return 5;
    case "discussion":
      return 6;
    case "conclusion":
      return 7;
    case "appendix":
      return 8;
    default:
      return 20;
  }
}

function isResultSummary(relativePath: string) {
  return normalizePath(relativePath) === "results/summary.json";
}

export function toLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

export function toErrorMessage(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);

  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function resolveThemeMode(
  themePreference: ThemePreference,
  prefersDark = false
): ResolvedTheme {
  if (themePreference === "system") {
    return prefersDark ? "dark" : "light";
  }

  return themePreference;
}
