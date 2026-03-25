import type { ProjectSnapshot, RuntimeAppState } from "../shared/types";

const UNASSIGNED_PENDING_THREAD_ID = "__pending__";

export function isPendingChatVisible(
  pendingThreadId: string | null | undefined,
  activeThreadId: string | null | undefined
) {
  if (!pendingThreadId) {
    return false;
  }

  if (pendingThreadId === UNASSIGNED_PENDING_THREAD_ID) {
    return true;
  }

  return Boolean(activeThreadId && pendingThreadId === activeThreadId);
}

export function describeBusyAction(value: string) {
  const normalized = value.trim().toLowerCase();

  if (normalized.includes("sign-in")) {
    return "Preparing the research browser session…";
  }

  if (normalized.includes("automation")) {
    return "Updating the automation loop…";
  }

  if (normalized.includes("attachment")) {
    return "Updating thread attachments…";
  }

  if (normalized.includes("thread")) {
    return "Updating the current thread…";
  }

  return "Working…";
}

export function summarizeWorkspacePath(workspacePath: string) {
  const normalized = workspacePath.trim().replace(/[\\/]+$/, "");

  if (!normalized) {
    return "";
  }

  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] ?? normalized;
}

export function buildAppStateRevision(appState: RuntimeAppState | null) {
  if (!appState) {
    return "";
  }

  const { settings } = appState;
  return JSON.stringify([
    appState.platform,
    appState.selectedWorkspacePath,
    settings.autopilotPromptLanguage,
    settings.strategistSessionReady,
    settings.lastWorkspacePath,
    settings.strategistModel,
    settings.strategistReasoningIntensity,
    settings.builderModel,
    settings.builderReasoningEffort
  ]);
}

export function buildSnapshotRevision(snapshot: ProjectSnapshot) {
  return JSON.stringify([
    snapshot.project?.id ?? "",
    snapshot.project?.updatedAt ?? "",
    snapshot.activeThreadId ?? "",
    snapshot.threads.length,
    snapshot.activeThread?.id ?? "",
    snapshot.activeThread?.updatedAt ?? "",
    snapshot.latestConversationEntry?.id ?? "",
    snapshot.latestConversationEntry?.createdAt ?? "",
    snapshot.latestDecision?.id ?? "",
    snapshot.latestDecision?.createdAt ?? "",
    snapshot.latestRun?.id ?? "",
    snapshot.latestRun?.status ?? "",
    snapshot.latestRun?.endedAt ?? snapshot.latestRun?.startedAt ?? "",
    snapshot.latestAutomationSession?.id ?? "",
    snapshot.latestAutomationSession?.status ?? "",
    snapshot.latestAutomationSession?.updatedAt ?? "",
    snapshot.latestAutomationCheckpoint?.id ?? "",
    snapshot.latestAutomationCheckpoint?.updatedAt ?? snapshot.latestAutomationCheckpoint?.createdAt ?? "",
    snapshot.attachments.length,
    snapshot.activeThreadAttachments.length,
    snapshot.logs.length
  ]);
}

export { UNASSIGNED_PENDING_THREAD_ID };
