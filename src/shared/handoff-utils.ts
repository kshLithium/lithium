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

  return /builder run (?:stalled without producing|ended without writing) a final answer|latest issue:|retry \d+\/\d+|shell_snapshot|module not founderror|automation is still running\.|automation stopped when lithium restarted during (?:the )?builder step|detached builder process after an app restart|cancelled this task while recovering a detached builder process|cancelled this task before it finished|the strategist browser step needs help before automation can continue|chrome window closed before oracle finished/i.test(
    trimmed
  );
}
