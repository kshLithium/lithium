import path from "node:path";
import type { ConversationEntryRecord, ProjectSnapshot, ThreadRecord } from "../shared/types";

export function resolveInitialWorkspacePath(
  argv: string[],
  lastWorkspacePath: string,
  cwd: string
) {
  const candidate = argv.find((value) => value.trim() && !value.startsWith("-"))?.trim() || "";

  if (candidate) {
    return path.resolve(cwd, candidate);
  }

  if (lastWorkspacePath.trim()) {
    return path.resolve(cwd, lastWorkspacePath.trim());
  }

  return path.resolve(cwd);
}

export function splitShellLikeArguments(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function resolveThreadSelection(target: string, threads: ThreadRecord[]) {
  const normalizedTarget = target.trim();
  const numericIndex = Number.parseInt(normalizedTarget, 10);

  if (Number.isFinite(numericIndex) && `${numericIndex}` === normalizedTarget) {
    const selectedThread = threads[numericIndex - 1];

    if (!selectedThread) {
      throw new Error(`Thread index out of range: ${normalizedTarget}`);
    }

    return selectedThread.id;
  }

  const thread = threads.find((candidate) => candidate.id === normalizedTarget);

  if (!thread) {
    throw new Error(`Thread not found: ${normalizedTarget}`);
  }

  return thread.id;
}

export function resolveConversationAttachmentLabels(
  entry: ConversationEntryRecord,
  snapshot: ProjectSnapshot
) {
  const attachmentIds = new Set(entry.attachmentIds ?? []);
  return snapshot.attachments
    .filter((attachment) => attachmentIds.has(attachment.id))
    .map((attachment) => attachment.relativePath);
}

export function summarizeRun(value: string) {
  const normalized = value
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized ? normalized.slice(0, 160) : "none";
}

export function resolveWorkspacePath(value: string, cwd: () => string) {
  return path.resolve(cwd(), value.trim());
}
