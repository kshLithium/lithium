import type { LithiumHandoff } from "./types";

export function handoffMachineSummary(handoff?: LithiumHandoff | null) {
  return handoff?.machineSummary?.trim() || handoff?.summary?.trim() || "";
}

export function handoffUserMessage(handoff?: LithiumHandoff | null) {
  return handoff?.userMessage?.trim() || "";
}

export function isOperationalAutomationMessage(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return false;
  }

  return /builder run (?:stalled without producing|ended without writing) a final answer|background strategist research (?:stalled|ended) without producing a usable answer|oracle strategist run completed without producing output|oracle strategist output looked truncated or non-final|latest issue:|retry \d+\/\d+|shell_snapshot|module not founderror|automation is still running\.|automation stopped when (?:the app|lithium) restarted during (?:the )?builder step|detached builder process after (?:an app )?restart|cancelled this task while recovering a detached builder process|cancelled this task before it finished|the strategist browser step needs help before automation can continue|chrome window closed before oracle finished|saved chatgpt session expired|chatgpt session expired|lithium_oracle_visible=1|no (?:chatgpt )?cookies were applied|log in to chatgpt in chrome|provide inline cookies|unable to find model option matching/i.test(
    trimmed
  );
}
