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
  const agentMessages: string[] = [];
  const activeCommands = new Map<string, string>();

  for (const line of stdout.split("\n")) {
    const event = parseJsonLine(line);

    if (!event?.item?.type) {
      continue;
    }

    if (event.item.type === "agent_message") {
      const message = normalizeAgentMessage(event.item.text);

      if (message && agentMessages[agentMessages.length - 1] !== message) {
        agentMessages.push(message);
      }

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

  const progressSummary = agentMessages.at(-1) ?? "";
  const progressDetails = agentMessages
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
