import type { ChatProgressInspection } from "../shared/types";

export function stabilizeChatProgress(
  current: ChatProgressInspection | null,
  next: ChatProgressInspection | null
) {
  if (current && !next) {
    return current;
  }

  if (!current || !next) {
    return next;
  }

  if (
    current.threadId === next.threadId &&
    current.lane === next.lane &&
    hasMeaningfulChatProgress(current) &&
    isGenericChatProgress(next)
  ) {
    return current;
  }

  if (
    current.active === next.active &&
    current.lane === next.lane &&
    current.threadId === next.threadId &&
    current.progressSummary === next.progressSummary &&
    current.activeCommand === next.activeCommand &&
    current.progressDetails.length === next.progressDetails.length &&
    current.progressDetails.every((detail, index) => detail === next.progressDetails[index])
  ) {
    return current;
  }

  return next;
}

function hasMeaningfulChatProgress(progress: ChatProgressInspection) {
  const summary = progress.progressSummary.trim();
  const details = progress.progressDetails
    .map((detail) => detail.trim())
    .filter(Boolean);

  if (!summary && !details.length) {
    return false;
  }

  return !isGenericChatProgress(progress);
}

function isGenericChatProgress(progress: ChatProgressInspection) {
  const summary = progress.progressSummary.trim();
  const details = progress.progressDetails
    .map((detail) => detail.trim())
    .filter(Boolean);

  if (!summary) {
    return details.length === 0;
  }

  if (summary !== "Thinking…") {
    return false;
  }

  return (
    details.length === 0 ||
    details.every((detail) => detail === "Reviewing the latest thread state and choosing the next move.")
  );
}
