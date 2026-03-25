type CodexEventItem = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
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
  let latestAgentMessageLineIndex = -1;
  let latestDerivedProgress:
    | {
        lineIndex: number;
        summary: string;
        details: string[];
      }
    | null = null;

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
      latestAgentMessageLineIndex = lineIndex;
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

    const derivedProgress = deriveCommandProgress(event.item.aggregated_output);

    if (derivedProgress) {
      latestDerivedProgress = {
        lineIndex,
        summary: derivedProgress.summary,
        details: derivedProgress.details
      };
    }

    if (event.type === "item.completed") {
      activeCommands.delete(itemId);
    }
  }

  const orderedMessages = normalizeProgressMessageHistory(
    agentMessageOrder.map((itemId) => agentMessages.get(itemId) ?? "")
  );
  let progressSummary = orderedMessages.at(-1) ?? "";
  let progressDetails = orderedMessages
    .slice(0, -1)
    .slice(-MAX_PROGRESS_DETAILS)
    .map((message) => summarizeProgressMessage(message));
  const activeCommand = Array.from(activeCommands.values()).at(-1) ?? null;

  if (latestDerivedProgress) {
    const derivedSummary = summarizeProgressMessage(latestDerivedProgress.summary);
    const derivedDetails = latestDerivedProgress.details
      .map((detail) => summarizeProgressMessage(detail))
      .filter(Boolean);

    if (
      derivedSummary &&
      (!progressSummary || latestDerivedProgress.lineIndex >= latestAgentMessageLineIndex)
    ) {
      const nextDetails = progressSummary && progressSummary !== derivedSummary
        ? [...progressDetails, progressSummary, ...derivedDetails]
        : [...progressDetails, ...derivedDetails];
      progressSummary = derivedSummary;
      progressDetails = dedupeProgressDetails(nextDetails).slice(-MAX_PROGRESS_DETAILS);
    } else if (derivedSummary) {
      progressDetails = dedupeProgressDetails([
        ...progressDetails,
        derivedSummary,
        ...derivedDetails
      ]).slice(-MAX_PROGRESS_DETAILS);
    }
  }

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

  return stripControlFooters(value.replace(/\r\n/g, "\n")).trim();
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

function deriveCommandProgress(value: string | undefined) {
  if (!value) {
    return null;
  }

  const normalized = stripControlFooters(value.replace(/\r\n/g, "\n")).trim();

  if (!normalized) {
    return null;
  }

  const progressMatches = Array.from(normalized.matchAll(/\b(?:sliding_)?val_progress:(\d+)\/(\d+)\b/g));
  const latestProgress = progressMatches.at(-1);
  const exactMatches = Array.from(
    normalized.matchAll(/(?:^|\n)[^\n]*_exact[^\n]*?\bval_bpb:([0-9.]+)/g)
  );
  const latestExact = exactMatches.at(-1)?.[1]?.trim() || "";

  if (latestExact) {
    return {
      summary: `Exact val_bpb: ${latestExact}`,
      details: latestProgress ? [`Eval progress: ${latestProgress[1]}/${latestProgress[2]}`] : []
    };
  }

  if (latestProgress) {
    return {
      summary: `Eval progress: ${latestProgress[1]}/${latestProgress[2]}`,
      details: []
    };
  }

  return null;
}

function dedupeProgressDetails(values: string[]) {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

function stripControlFooters(value: string) {
  return value
    .replace(/\n*LITHIUM_STATUS(?:\s*\n|\s+)?[\s\S]*$/i, "")
    .replace(/\n*LITHIUM_HANDOFF(?:\s*\n|\s+)?[\s\S]*$/i, "")
    .replace(/\n*LITHIUM_ROUTE(?:\s*\n|\s+)?[\s\S]*$/i, "")
    .trim();
}
