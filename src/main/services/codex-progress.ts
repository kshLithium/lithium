type CodexEventItem = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
};

type CodexEvent = {
  type?: string;
  item?: CodexEventItem;
};

export type CodexProgressState = {
  progressSummary: string;
  progressDetails: string[];
  activeCommand: string | null;
};

const MAX_PROGRESS_DETAILS = 3;

export function parseCodexProgressLog(stdout: string): CodexProgressState {
  const agentMessages = new Map<string, string>();
  const agentMessageOrder: string[] = [];
  const activeCommands = new Map<string, string>();

  for (const [lineIndex, line] of stdout.split("\n").entries()) {
    const event = parseJsonLine(line);

    if (!event?.item?.type) {
      continue;
    }

    if (event.item.type === "agent_message") {
      const message = normalizeAgentMessage(event.item.text);
      const itemId = event.item.id?.trim() || `agent:${lineIndex}`;

      if (!message) {
        continue;
      }

      const existing = agentMessages.get(itemId) ?? "";

      if (!existing) {
        agentMessageOrder.push(itemId);
      }

      agentMessages.set(itemId, chooseRicherProgressMessage(existing, message));
      continue;
    }

    if (event.item.type !== "command_execution") {
      continue;
    }

    const itemId = event.item.id?.trim();
    const command = normalizeCommandLabel(event.item.command);

    if (!itemId || !command) {
      continue;
    }

    if (event.type === "item.started") {
      activeCommands.set(itemId, command);
      continue;
    }

    if (event.type === "item.completed") {
      activeCommands.delete(itemId);
    }
  }

  const orderedMessages = normalizeProgressMessageHistory(
    agentMessageOrder.map((itemId) => agentMessages.get(itemId) ?? "")
  );
  const progressSummary = orderedMessages.at(-1) ?? "";
  const progressDetails = orderedMessages
    .slice(0, -1)
    .slice(-MAX_PROGRESS_DETAILS)
    .map((message) => summarizeProgressMessage(message));
  const activeCommand = Array.from(activeCommands.values()).at(-1) ?? null;

  return {
    progressSummary,
    progressDetails,
    activeCommand
  };
}

function parseJsonLine(line: string) {
  const trimmed = line.trim();

  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as CodexEvent;
  } catch {
    return null;
  }
}

function normalizeAgentMessage(value: string | undefined) {
  if (!value) {
    return "";
  }

  return value.replace(/\r\n/g, "\n").trim();
}

function summarizeProgressMessage(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeProgressMessageHistory(values: string[]) {
  const history: string[] = [];

  for (const value of values) {
    const normalized = normalizeAgentMessage(value);

    if (!normalized) {
      continue;
    }

    const existing = history.at(-1);

    if (!existing) {
      history.push(normalized);
      continue;
    }

    if (existing === normalized) {
      continue;
    }

    if (isProgressPrefixVariant(existing, normalized)) {
      history[history.length - 1] = existing.length >= normalized.length ? existing : normalized;
      continue;
    }

    history.push(normalized);
  }

  return history;
}

function chooseRicherProgressMessage(existing: string, candidate: string) {
  if (!existing) {
    return candidate;
  }

  if (!candidate || existing === candidate) {
    return existing;
  }

  if (isProgressPrefixVariant(existing, candidate)) {
    return existing.length >= candidate.length ? existing : candidate;
  }

  return candidate;
}

function isProgressPrefixVariant(left: string, right: string) {
  const normalizedLeft = summarizeProgressMessage(left).replace(/[.…\s]+$/g, "");
  const normalizedRight = summarizeProgressMessage(right).replace(/[.…\s]+$/g, "");
  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;

  if (!shorter || shorter.length < 12) {
    return false;
  }

  return longer.startsWith(shorter);
}

function normalizeCommandLabel(value: string | undefined) {
  if (!value) {
    return "";
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/);
  const command = match?.[2] ?? trimmed;

  return command
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\n/g, " ")
    .trim();
}
