import type {
  AttachmentRecord,
  AutomationCheckpointRecord,
  AutomationSessionRecord,
  AutomationStepRecord,
  ArtifactKind,
  ChatProgressInspection,
  ConversationEntryRecord,
  BuilderRunInspection,
  LithiumHandoff,
  ProjectSnapshot,
  ThreadRecord,
} from "../shared/types";
import {
  handoffMachineSummary,
  handoffUserMessage,
  isOperationalAutomationMessage
} from "../shared/handoff-utils";
import {
  sanitizePromptEchoProgress,
  stripLeadingPromptEchoParagraph
} from "../shared/prompt-echo";
import type { ChatItem } from "./app-types";

type AutomationCheckpointTone =
  | "running"
  | "paused"
  | "failed"
  | "blocked"
  | "recorded"
  | "approved";

export function buildChatItems(
  snapshot: ProjectSnapshot,
  workspacePath = ""
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
  const hasAutomationTimeline = automationSessions.length > 0 || automationSteps.length > 0 || automationCheckpoints.length > 0;
  const shouldRenderStandaloneWorkerArtifacts = !hasConversationEntries && !hasAutomationTimeline;

  if (hasConversationEntries) {
    for (const entry of conversationEntries) {
      items.push(
        formatConversationEntry(
          entry,
          items.length,
          toOptionalArtifacts(
            buildAttachmentArtifactRefs(
              attachmentsByConversationEntryId.get(entry.id) ?? [],
              workspacePath
            )
          )
        )
      );
    }
  }

  for (const decision of shouldRenderStandaloneWorkerArtifacts ? decisions : []) {
    const visiblePrompt = resolveVisibleDecisionPrompt(decision);

    if (visiblePrompt) {
      items.push({
        id: `decision:${decision.id}`,
        role: "user",
        body: visiblePrompt,
        timestamp: decision.createdAt,
        order: items.length,
        artifacts: toOptionalArtifacts(
          buildAttachmentArtifactRefs(attachmentsByDecisionId.get(decision.id) ?? [], workspacePath)
        )
      });
    }

    items.push({
      id: `decision-result:${decision.id}`,
      role: "assistant",
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

  for (const run of shouldRenderStandaloneWorkerArtifacts ? runs : []) {
    if (shouldSuppressAutomationRun(run, latestAutomationTimelineTimestamp)) {
      continue;
    }

    const visibleRunPrompt = resolveVisibleRunPrompt(run);

    if (!mixedFollowupRunIds.has(run.id) && visibleRunPrompt) {
      items.push({
        id: `task:${run.taskId}`,
        role: "user",
        body: visibleRunPrompt,
        timestamp: run.startedAt,
        order: items.length,
        artifacts: toOptionalArtifacts(
          buildAttachmentArtifactRefs(attachmentsByRunId.get(run.id) ?? [], workspacePath)
        )
      });
    }

    items.push({
      id: `run:${run.id}`,
      role: "assistant",
      body: formatBuilderBody(run),
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
      role: "assistant",
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
  const visiblePendingChatItems = filterAcknowledgedPendingChatItems(chatItems, pendingChatItems);
  const items = [...chatItems, ...visiblePendingChatItems];
  const latestVisibleUserBody = [...items].reverse().find((item) => item.role === "user")?.body;
  const sanitizedLiveProgress = input.chatProgress
    ? sanitizePromptEchoProgress(
        {
          progressSummary: input.chatProgress.progressSummary,
          progressDetails: input.chatProgress.progressDetails,
          activeCommand: input.chatProgress.activeCommand
        },
        latestVisibleUserBody
      )
    : null;
  const liveProgressBody = sanitizedLiveProgress
    ? formatLiveProgressBody(sanitizedLiveProgress)
    : formatLiveProgressBody(input.chatProgress ?? null);
  const order = items.length;
  const latestPersistedTimestamp = [...chatItems]
    .reverse()
    .find((item) => !item.pending)?.timestamp;
  const transientAssistantTimestamp = maxTimestamp(
    latestPersistedTimestamp,
    pendingChatItems[pendingChatItems.length - 1]?.timestamp,
    input.chatProgress?.updatedAt
  );
  const transientThreadKey =
    input.chatProgress?.threadId || input.activeThreadId || input.workspacePath || pendingChatItems[0]?.id || "chat";
  const transientBusyBody = input.busyBody?.trim()
    ? stripLeadingPromptEchoParagraph(input.busyBody, latestVisibleUserBody)
    : liveProgressBody;

  if (input.busyAction && pendingChatItems.length && transientBusyBody) {
    items.push({
      id: `busy:${transientThreadKey}:${input.busyAction}`,
      role: "assistant",
      body: transientBusyBody,
      timestamp: transientAssistantTimestamp || new Date().toISOString(),
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
      body: liveProgressBody,
      timestamp: input.chatProgress.updatedAt,
      order,
      pending: true
    });
  }

  return sortChatItems(items);
}

function filterAcknowledgedPendingChatItems(
  chatItems: ChatItem[],
  pendingChatItems: ChatItem[]
) {
  return pendingChatItems.filter((pendingItem) => {
    if (pendingItem.role !== "user") {
      return true;
    }

    const normalizedPendingBody = normalizePromptForComparison(pendingItem.body);

    if (!normalizedPendingBody) {
      return true;
    }

    return !chatItems.some((item) => {
      if (item.role !== pendingItem.role || item.pending) {
        return false;
      }

      const normalizedBody = normalizePromptForComparison(item.body);

      if (!normalizedBody || normalizedBody !== normalizedPendingBody) {
        return false;
      }

      return isAcknowledgedPendingTimestamp(item.timestamp, pendingItem.timestamp);
    });
  });
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

  if (looksLikeInternalAutomationSummary(summary)) {
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
  const summary = simplifyAutomationCheckpointSummary(checkpoint.summary, session);
  const approvedResponse = checkpoint.userResponse?.trim() || "";

  if (summary) {
    return summary;
  }

  if (approvedResponse && approvedResponse !== checkpoint.summary.trim()) {
    return approvedResponse;
  }

  return "";
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
    return session?.currentStepSummary?.trim() ?? "";
  }

  if (looksLikeInternalAutomationSummary(trimmed)) {
    return "";
  }

  return trimmed;
}

function looksLikeInternalAutomationSummary(value: string) {
  return (
    isOperationalAutomationMessage(value) ||
    /latest strategist result:|latest builder result:|retry \d+\/\d+|module not founderror|shell_snapshot|automation is still running\.|automation stopped when lithium restarted during (?:the )?builder step/i.test(
      value
    )
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

  if (looksLikeInternalAutomationSummary(trimmed)) {
    return "";
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

function resolveAutomationCheckpointTone(
  checkpoint: AutomationCheckpointRecord,
  session?: AutomationSessionRecord
): AutomationCheckpointTone {
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

  return /automation blocked|oracle strategist run completed without producing output|chrome window closed before oracle finished|lithium_oracle_visible=1|saved chatgpt session expired|chatgpt session expired|no (?:chatgpt )?cookies were applied|log in to chatgpt in chrome|provide inline cookies|unable to find model option matching/.test(
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

  return /chrome window closed before oracle finished|lithium_oracle_visible=1|saved chatgpt session expired|chatgpt session expired|no (?:chatgpt )?cookies were applied|log in to chatgpt in chrome|provide inline cookies|unable to find model option matching/.test(
    haystack
  );
}

function isStrategistLoginBlockedCheckpoint(
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

  return /no (?:chatgpt )?cookies were applied|log in to chatgpt in chrome|provide inline cookies|unable to find model option matching/.test(
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
  let lastVisibleNonUserBody = "";
  let lastVisibleNonUserRole: ChatItem["role"] | "" = "";
  let lastVisibleNonUserTimestamp = "";

  for (const item of items) {
    if (item.role !== "user") {
      const normalizedBody = normalizePromptForComparison(item.body);
      const isDuplicateNonUser =
        normalizedBody &&
        item.role === lastVisibleNonUserRole &&
        normalizedBody === lastVisibleNonUserBody &&
        isNearDuplicateTimestamp(item.timestamp, lastVisibleNonUserTimestamp);

      if (isDuplicateNonUser) {
        continue;
      }

      filtered.push(item);

      if (normalizedBody) {
        lastVisibleNonUserBody = normalizedBody;
        lastVisibleNonUserRole = item.role;
        lastVisibleNonUserTimestamp = item.timestamp;
      }

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

function maxTimestamp(...values: Array<string | null | undefined>) {
  const normalized = values.filter((value): value is string => Boolean(value)).sort();
  return normalized[normalized.length - 1] ?? "";
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

function isAcknowledgedPendingTimestamp(persistedTimestamp: string, pendingTimestamp: string) {
  if (!isNearDuplicateTimestamp(persistedTimestamp, pendingTimestamp)) {
    return false;
  }

  const persistedTime = Date.parse(persistedTimestamp);
  const pendingTime = Date.parse(pendingTimestamp);

  if (!Number.isFinite(persistedTime) || !Number.isFinite(pendingTime)) {
    return persistedTimestamp >= pendingTimestamp;
  }

  return persistedTime >= pendingTime - 2_000;
}

function buildAttachmentArtifactRefs(
  attachments: AttachmentRecord[],
  workspacePath: string
) {
  if (!attachments.length) {
    return [];
  }

  const seen = new Set<string>();
  const refs = [];

  for (const attachment of attachments) {
    const resolvedPath = joinWorkspacePath(workspacePath, attachment.relativePath);

    if (seen.has(resolvedPath)) {
      continue;
    }

    seen.add(resolvedPath);
    refs.push({
      id: attachment.id,
      path: resolvedPath,
      relativePath: attachment.relativePath,
      label: attachment.name,
      kind: "artifact" as const,
      artifactKind: attachmentKindToArtifactKind(attachment.kind)
    });
  }

  return refs.slice(0, 8);
}

function formatConversationEntry(
  entry: ConversationEntryRecord,
  order: number,
  artifacts?: ChatItem["artifacts"]
): ChatItem {
  return {
    id: `conversation:${entry.id}`,
    role: entry.role,
    body: entry.body.trim(),
    timestamp: entry.createdAt,
    order,
    artifacts
  };
}

function attachmentKindToArtifactKind(kind: AttachmentRecord["kind"] | "pdf"): ArtifactKind {
  switch (kind) {
    case "text":
    case "json":
    case "csv":
    case "document":
    case "image":
      return kind;
    case "pdf":
      return "document";
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

export function formatThreadLabel(thread: ThreadRecord, index: number, fallback?: string) {
  const raw = fallback || thread.title || `Chat ${index + 1}`;

  return raw
    .replace(/^New thread\b/i, "New chat")
    .replace(/^Thread\b/i, "Chat");
}

function formatDecisionBody(
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
  if (/^oracle did not return a structured rationale\.?$/i.test(value.trim())) {
    return "";
  }

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
    /^(summary|machine_summary|user_message|rationale|files|risks|run_actions|success_criteria|open_questions)\s*:/i.test(
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

function formatBuilderBody(
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

  const summary = stripProgressControlFooters(progress.progressSummary).trim();
  const lines: string[] = [];

  if (summary) {
    lines.push(summary);
  }

  if (progress.progressDetails.length) {
    for (const detail of progress.progressDetails) {
      const sanitizedDetail = stripProgressControlFooters(detail).trim();

      if (sanitizedDetail && !lines.includes(sanitizedDetail)) {
        lines.push(sanitizedDetail);
      }
    }
  }

  if (!lines.length) {
    return "";
  }

  return lines.join("\n\n");
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

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function looksLikeInternalExecutionTranscript(value: string) {
  if (!value.trim()) {
    return false;
  }

  const transcriptSignals = [
    /(?:^|\s)\{"type":"thread\.(?:started|completed)"/m.test(value),
    /(?:^|\s)\{"type":"turn\.(?:started|completed)"/m.test(value),
    /"type":"item\.(?:started|completed|updated)"/.test(value),
    /"type":"(?:agent_message|command_execution|web_search|todo_list)"/.test(value)
  ].filter(Boolean).length;

  if (transcriptSignals >= 3) {
    return true;
  }

  return (value.match(/\{"type":"[^"]+"/g)?.length ?? 0) >= 4;
}

function stripBuilderFooterForDisplay(finalMessage: string) {
  return finalMessage.replace(/\n*LITHIUM_STATUS(?:\s*\n|\s+)?[\s\S]*$/i, "").trim();
}

function stripStrategistFooterForDisplay(rawOutput: string) {
  return rawOutput.replace(/\n*LITHIUM_HANDOFF(?:\s*\n|\s+)?[\s\S]*$/i, "").trim();
}

function stripProgressControlFooters(value: string) {
  return value
    .replace(/\n*LITHIUM_STATUS(?:\s*\n|\s+)?[\s\S]*$/i, "")
    .replace(/\n*LITHIUM_HANDOFF(?:\s*\n|\s+)?[\s\S]*$/i, "")
    .replace(/\n*LITHIUM_ROUTE(?:\s*\n|\s+)?[\s\S]*$/i, "")
    .trim();
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/");
}

export function toErrorMessage(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);

  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}
