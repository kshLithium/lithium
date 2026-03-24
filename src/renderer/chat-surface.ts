import { DEFAULT_PROJECT_RESEARCH_GOAL, type ProjectSnapshot } from "../shared/types";
import { normalizePath } from "./app-utils";

const PAPER_PATH_PATTERN = /(^|\/)(paper|manuscript)\//i;
const PAPER_EXTENSION_PATTERN = /\.(tex|bib|cls|sty|pdf)$/i;
const CODE_EXTENSION_PATTERN = /\.(py|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|rs|go|java|c|cc|cpp|h|hpp|md)$/i;
export const UNASSIGNED_PENDING_THREAD_ID = "__pending__";

export function describeBusyChatState(label: string) {
  const normalized = label.trim().toLowerCase();

  if (normalized.includes("chatgpt sign-in")) {
    return "Opening the ChatGPT sign-in flow…";
  }

  if (normalized.includes("browser probe")) {
    return "Running the strategist browser probe…";
  }

  if (normalized.includes("importing attachment")) {
    return "Adding the attachment…";
  }

  if (normalized.includes("creating thread")) {
    return "Starting a new thread…";
  }

  if (normalized.includes("switching thread")) {
    return "Loading that thread…";
  }

  if (normalized.includes("running chat")) {
    return "Thinking…";
  }

  return "Working…";
}

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

export function shouldAutoOpenPaperSurface(nextSnapshot: Pick<ProjectSnapshot, "latestRun">) {
  const changedFiles = nextSnapshot.latestRun?.changedFiles ?? [];
  return changedFiles.some(isPaperRelatedPath);
}

export function shouldAutoOpenCodeSurface(nextSnapshot: Pick<ProjectSnapshot, "latestRun">) {
  const latestRun = nextSnapshot.latestRun;

  if (!latestRun || latestRun.model === "tectonic") {
    return false;
  }

  return (latestRun.changedFiles ?? []).some((filePath) => {
    if (isPaperRelatedPath(filePath)) {
      return false;
    }

    return CODE_EXTENSION_PATTERN.test(normalizePath(filePath).toLowerCase());
  });
}

export function promptRequestsPaperSurface(prompt: string) {
  return /(paper|manuscript|latex|tex\b|pdf\b|논문|원고|초록|abstract|references?|bibliography|section)/i.test(
    prompt
  );
}

export function promptRequestsCodeSurface(prompt: string) {
  return /(code|editor|canvas|source file|implementation|코드|에디터|파일 수정|파일 열어)/i.test(prompt);
}

export function resolveLatestTaskPrompt(latestTask: string | null | undefined, composerValue: string) {
  return latestTask?.trim() || composerValue.trim();
}

export function canSubmitComposerPrompt(
  prompt: string,
  latestBuilderTaskPrompt: string | null | undefined
) {
  const normalized = prompt.trim();

  if (!normalized) {
    return false;
  }

  if (/^\/(?:research|mixed|plan)\s*$/i.test(normalized)) {
    return false;
  }

  if (/^\/build\s*$/i.test(normalized)) {
    return Boolean(latestBuilderTaskPrompt?.trim());
  }

  return true;
}

export function resolveAutomationObjective(
  snapshot: Pick<ProjectSnapshot, "project" | "memory" | "activeThread" | "latestDecision" | "latestAutomationSession">
) {
  const existingObjective =
    snapshot.latestAutomationSession?.displayObjective?.trim() ||
    snapshot.latestAutomationSession?.objective?.trim();

  if (existingObjective) {
    return existingObjective;
  }

  const researchGoal = snapshot.memory?.researchGoal?.trim() ?? "";

  if (researchGoal && !isDefaultResearchGoal(researchGoal)) {
    return researchGoal;
  }

  const threadSummary = snapshot.activeThread?.summary?.trim() ?? "";

  if (threadSummary) {
    return threadSummary;
  }

  const latestDecisionSummary = snapshot.latestDecision?.summary?.trim() ?? "";

  if (latestDecisionSummary) {
    return latestDecisionSummary;
  }

  return researchGoal || snapshot.project?.name || "Advance the current research project.";
}

function isPaperRelatedPath(filePath: string) {
  const normalized = normalizePath(filePath).toLowerCase();
  return PAPER_PATH_PATTERN.test(normalized) || PAPER_EXTENSION_PATTERN.test(normalized);
}

function isDefaultResearchGoal(value: string) {
  return value.trim().toLowerCase() === DEFAULT_PROJECT_RESEARCH_GOAL.toLowerCase();
}
