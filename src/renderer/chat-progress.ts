import type { ChatProgressInspection } from "../shared/types";

export function stabilizeChatProgress(
  current: ChatProgressInspection | null,
  next: ChatProgressInspection | null
) {
  if (!current || !next) {
    return next;
  }

  if (
    current.threadId === next.threadId &&
    current.lane === next.lane &&
    hasMeaningfulChatProgress(current) &&
    !hasMeaningfulChatProgress(next)
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

  return Boolean(summary || details.length);
}
