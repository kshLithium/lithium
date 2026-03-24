import { useEffect, useState } from "react";
import type { ThreadRecord } from "../shared/types";

type ThreadSeenState = Record<string, string>;

type UseThreadSeenStateArgs = {
  workspacePath: string;
  projectId?: string;
  threads: ThreadRecord[];
  activeThread?: ThreadRecord | null;
};

export function useThreadSeenState({
  workspacePath,
  projectId,
  threads,
  activeThread
}: UseThreadSeenStateArgs) {
  const [threadSeenState, setThreadSeenState] = useState<ThreadSeenState>({});

  useEffect(() => {
    if (!workspacePath || typeof window === "undefined") {
      setThreadSeenState({});
      return;
    }

    const raw = window.localStorage.getItem(buildThreadSeenStorageKey(workspacePath));
    setThreadSeenState(readThreadSeenState(raw, threads));
  }, [projectId, workspacePath]);

  useEffect(() => {
    if (!workspacePath || typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(buildThreadSeenStorageKey(workspacePath), JSON.stringify(threadSeenState));
    } catch {
      // Ignore local persistence failures.
    }
  }, [threadSeenState, workspacePath]);

  useEffect(() => {
    if (!workspacePath || !threads.length) {
      return;
    }

    setThreadSeenState((current) => mergeThreadSeenState(current, threads));
  }, [threads, workspacePath]);

  useEffect(() => {
    if (!workspacePath || !activeThread) {
      return;
    }

    setThreadSeenState((current) => markThreadSeen(current, activeThread));
  }, [activeThread?.id, activeThread?.updatedAt, workspacePath]);

  return threadSeenState;
}

export function buildThreadSeenStorageKey(workspacePath: string) {
  return `lithium:thread-seen:${encodeURIComponent(workspacePath)}`;
}

export function isThreadUnread(lastSeenAt: string | undefined, updatedAt: string) {
  if (!lastSeenAt) {
    return false;
  }

  return updatedAt > lastSeenAt;
}

export function readThreadSeenState(raw: string | null, threads: ThreadRecord[]) {
  const fallback = seedThreadSeenState(threads);

  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return mergeThreadSeenState(parsed, threads);
  } catch {
    return fallback;
  }
}

export function seedThreadSeenState(threads: ThreadRecord[]) {
  return Object.fromEntries(threads.map((thread) => [thread.id, thread.updatedAt] as const));
}

export function mergeThreadSeenState(current: ThreadSeenState, threads: ThreadRecord[]) {
  let changed = false;
  const next = { ...current };

  for (const thread of threads) {
    if (!next[thread.id]) {
      next[thread.id] = thread.updatedAt;
      changed = true;
    }
  }

  return changed ? next : current;
}

function markThreadSeen(current: ThreadSeenState, activeThread: ThreadRecord) {
  if ((current[activeThread.id] ?? "") === activeThread.updatedAt) {
    return current;
  }

  return {
    ...current,
    [activeThread.id]: activeThread.updatedAt
  };
}
