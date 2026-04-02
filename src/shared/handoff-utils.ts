import type { LithiumHandoff } from "./types";

const OPERATIONAL_AUTOMATION_MESSAGE_PATTERN =
  /builder run (?:stalled without producing|ended without writing) a final answer|background strategist research (?:stalled|ended) without producing a usable answer|background strategist research is still running while automation continues|a background strategist branch is still running\. waiting for fresh research before replanning|oracle strategist run completed without producing output|oracle strategist output looked truncated or non-final|latest issue:|retry \d+\/\d+|shell_snapshot|module not founderror|automation is still running\.|automation stopped when (?:the app|lithium) restarted during (?:the )?builder step|automation was interrupted when (?:the app|lithium) restarted|automation stopped with an issue|automation stopped by the user|blocked on the strategist run|waiting for your direction|runtime budget reached|step budget reached|recovering after an automation controller issue|resuming the in-flight (?:strategist|builder) step after (?:the app|lithium) restarted|retrying the interrupted strategist step after (?:the app|lithium) restarted|detached builder process after (?:an app )?restart|cancelled this task while recovering a detached builder process|cancelled this task before it finished|the strategist browser step needs help before automation can continue|chrome window closed before oracle finished|chrome disconnected before completion|connect econnrefused|prompt textarea did not appear before timeout|prompt did not appear in conversation before timeout|prompt-not-in-composer|send may have failed|reconnecting\.\.\.|stream disconnected before comp|write_stdin failed|stdin is closed|saved chatgpt session expired|chatgpt session expired|lithium_oracle_visible=1|no (?:chatgpt )?cookies were applied|log in to chatgpt in chrome|provide inline cookies|unable to find model option matching/i;

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

  return OPERATIONAL_AUTOMATION_MESSAGE_PATTERN.test(trimmed);
}

export function resolveMeaningfulAutomationSummary(
  currentStepSummary?: string | null,
  displayObjective?: string | null,
  objective?: string | null
) {
  const current = currentStepSummary?.trim() || "";
  const display = displayObjective?.trim() || "";
  const base = display || objective?.trim() || "";

  if (current && !isOperationalAutomationMessage(current)) {
    return current;
  }

  if (base) {
    return base;
  }

  return current;
}
