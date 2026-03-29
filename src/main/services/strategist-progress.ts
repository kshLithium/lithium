import os from "node:os";
import path from "node:path";
import { sanitizePromptEchoProgress } from "../../shared/prompt-echo";
import { readTextFile } from "./run-artifacts";

export type StrategistProgress = {
  progressSummary: string;
  progressDetails: string[];
};

export function extractOracleSessionProgress(logText: string): StrategistProgress {
  const lines = logText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const assistantPreviews: string[] = [];
  const thinkingPreviews: string[] = [];
  const errorPreviews: string[] = [];

  for (const line of lines) {
    const browserError =
      line.match(/^user error \(browser-automation\):\s*(.+)$/i)?.[1]?.trim() ||
      line.match(/^error:\s*(.+)$/i)?.[1]?.trim();

    if (browserError) {
      errorPreviews.push(browserError);
      continue;
    }

    if (
      /^launching browser mode\b/i.test(line) ||
      /^this run can take up to\b/i.test(line) ||
      /^answer:\s*$/i.test(line) ||
      /^saved assistant output to\b/i.test(line) ||
      /^files=\d+\b/i.test(line) ||
      /^\d+[smhd].*·\s*gpt-[\d.]+/i.test(line)
    ) {
      continue;
    }

    const explicitPreview = line.match(/^\[assistant-preview\]\s*([\s\S]+)$/i)?.[1]?.trim();

    if (explicitPreview) {
      assistantPreviews.push(...extractOracleProgressEntries(explicitPreview));
      continue;
    }

    const thinkingMatch = line.match(/^\d+%\s+\[[^\]]+\]\s+—\s+(.+)$/);

    if (thinkingMatch?.[1]) {
      thinkingPreviews.push(...extractOracleProgressEntries(thinkingMatch[1]));
    }
  }

  const uniqueErrorPreviews = buildStableOracleProgressHistory(errorPreviews);
  const uniqueAssistantPreviews = buildStableOracleProgressHistory(assistantPreviews);
  const uniqueThinkingPreviews = buildStableOracleProgressHistory(thinkingPreviews);
  const previewHistory =
    uniqueAssistantPreviews.length > 0
      ? uniqueAssistantPreviews.slice(-3)
      : uniqueThinkingPreviews.slice(-3);

  return {
    progressSummary: uniqueErrorPreviews.at(-1) ?? previewHistory.at(-1) ?? "",
    progressDetails: uniqueErrorPreviews.length > 0 ? [] : previewHistory.slice(0, -1)
  };
}

export function mergeStrategistLiveProgress(
  liveProgress: StrategistProgress | null,
  logProgress: StrategistProgress
): StrategistProgress {
  if (!liveProgress?.progressSummary && !liveProgress?.progressDetails.length) {
    return logProgress;
  }

  const logHistory = buildStableOracleProgressHistory([
    ...logProgress.progressDetails,
    logProgress.progressSummary
  ]);
  const liveHistory = buildStableOracleProgressHistory([
    ...(liveProgress?.progressDetails ?? []),
    liveProgress?.progressSummary ?? ""
  ]);
  const mergedHistory = buildStableOracleProgressHistory([
    ...logHistory,
    ...(shouldUseLiveStrategistHistory(logHistory, liveHistory) ? liveHistory : [])
  ]);
  const preferredSummary = mergedHistory.at(-1) ?? logHistory.at(-1) ?? liveHistory.at(-1) ?? "";
  const preferredDetails = mergedHistory.slice(0, -1);

  return {
    progressSummary: preferredSummary,
    progressDetails: preferredDetails.slice(-3)
  };
}

export async function readLiveOracleSessionProgress(
  sessionSlug: string,
  promptPreview?: string
): Promise<StrategistProgress | null> {
  try {
    const sessionDir = path.join(resolveOracleHomeDir(), "sessions", sessionSlug);
    const metadataRaw = await readTextFile(path.join(sessionDir, "meta.json"));

    if (!metadataRaw.trim()) {
      return null;
    }

    const metadata = JSON.parse(metadataRaw) as {
      browser?: {
        runtime?: {
          chromeHost?: string;
          chromePort?: number;
          chromeTargetId?: string;
          tabUrl?: string;
        };
      };
    };
    const runtime = metadata.browser?.runtime;
    const host = runtime?.chromeHost || "127.0.0.1";
    const port = Number(runtime?.chromePort ?? 0);

    if (!Number.isFinite(port) || port <= 0) {
      return null;
    }

    const cdpModule = (await withOracleCdpTimeout(import("chrome-remote-interface"))) as any;
    const CDP = cdpModule.default ?? cdpModule;
    const targets = (await withOracleCdpTimeout(CDP.List({ host, port }))) as Array<{
      id?: string;
      url?: string;
    }>;
    const target =
      targets.find((entry) => entry.id === runtime?.chromeTargetId) ||
      targets.find((entry) => entry.url === runtime?.tabUrl) ||
      targets.find((entry) => /chatgpt\.com\/c\//.test(entry.url ?? "")) ||
      targets.find((entry) => /chatgpt\.com/.test(entry.url ?? ""));

    if (!target) {
      return null;
    }

    const client: any = await withOracleCdpTimeout(CDP({ host, port, target }));

    try {
      const { Runtime } = client;
      const evaluation: any = await withOracleCdpTimeout(
        Runtime.evaluate({
          expression: buildLiveOracleProgressExpression(),
          returnByValue: true
        })
      );
      const value = evaluation?.result?.value as
        | {
            assistantPreview?: string;
            thinkingStatus?: string;
          }
        | undefined;
      const assistantPreview = buildStableOracleProgressHistory(
        extractOracleProgressEntries(value?.assistantPreview ?? "")
      );
      const thinkingStatus = buildStableOracleProgressHistory(
        extractOracleProgressEntries(value?.thinkingStatus ?? "")
      );
      const previewHistory =
        assistantPreview.length > 0
          ? assistantPreview.slice(-3)
          : thinkingStatus.length > 0
            ? thinkingStatus.slice(-3)
            : [];

      return sanitizePromptEchoProgress({
        progressSummary: previewHistory.at(-1) ?? "",
        progressDetails: previewHistory.slice(0, -1)
      }, promptPreview);
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

function isGenericStrategistProgressSummary(value: string) {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  return /^(thinking|thinking…|reading documents?|reading document|searching|browsing|analyzing|processing|생각 중|문서를 읽는 중)$/i.test(
    normalized
  );
}

function sanitizeOracleProgressText(value: string) {
  const decoded = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  const paragraphs = decoded
    .split(/\n+/)
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const dedupedParagraphs: string[] = [];

  for (const paragraph of paragraphs) {
    if (!dedupedParagraphs.includes(paragraph)) {
      dedupedParagraphs.push(paragraph);
    }
  }

  return dedupedParagraphs.join("\n\n").trim();
}

function extractOracleProgressEntries(value: string) {
  return sanitizeOracleProgressText(value)
    .split(/\n\s*\n/)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function buildStableOracleProgressHistory(values: string[]) {
  return trimOracleProgressTail(pruneOracleProgressFragments(dedupeOracleProgressEntries(values)));
}

function trimOracleProgressTail(values: string[]) {
  const entries = [...values];

  while (entries.length > 1 && looksLikeOracleTrailingFragment(entries.at(-1) ?? "")) {
    entries.pop();
  }

  return entries;
}

function pruneOracleProgressFragments(values: string[]) {
  return values.filter((entry, index, entries) => {
    if (!looksLikeOracleTrailingFragment(entry)) {
      return true;
    }

    const normalizedEntry = entry.replace(/[.…\s]+$/g, "").trim();

    if (!normalizedEntry) {
      return false;
    }

    return !entries.slice(index + 1).some((candidate) => {
      const normalizedCandidate = candidate.trim();

      if (!normalizedCandidate || looksLikeOracleTrailingFragment(normalizedCandidate)) {
        return false;
      }

      return normalizedCandidate.startsWith(normalizedEntry);
    });
  });
}

function dedupeOracleProgressEntries(values: string[]) {
  const entries: string[] = [];

  for (const value of values) {
    const normalized = sanitizeOracleProgressText(value);

    if (!normalized) {
      continue;
    }

    let handled = false;

    for (let index = 0; index < entries.length; index += 1) {
      const existing = entries[index];

      if (existing === normalized) {
        handled = true;
        break;
      }

      if (isOracleProgressPrefixVariant(existing, normalized)) {
        if (normalized.length > existing.length) {
          entries[index] = normalized;
        }
        handled = true;
        break;
      }
    }

    if (handled) {
      continue;
    }

    entries.push(normalized);
  }

  return entries;
}

function shouldUseLiveStrategistHistory(logHistory: string[], liveHistory: string[]) {
  const liveSummary = liveHistory.at(-1) ?? "";
  const logSummary = logHistory.at(-1) ?? "";

  if (!liveSummary) {
    return false;
  }

  if (!logSummary) {
    return true;
  }

  if (isGenericStrategistProgressSummary(liveSummary) && !isGenericStrategistProgressSummary(logSummary)) {
    return false;
  }

  if (looksLikeOracleTrailingFragment(liveSummary) && !looksLikeOracleTrailingFragment(logSummary)) {
    return false;
  }

  if (isOracleProgressPrefixVariant(liveSummary, logSummary) && logSummary.length >= liveSummary.length) {
    return false;
  }

  return true;
}

function isOracleProgressPrefixVariant(left: string, right: string) {
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  const normalizedShorter = shorter.replace(/[.…\s]+$/g, "").trim();
  const normalizedLonger = longer.trim();

  if (!normalizedShorter || normalizedShorter.length < 12) {
    return false;
  }

  return normalizedLonger.startsWith(normalizedShorter);
}

function looksLikeOracleTrailingFragment(value: string) {
  const normalized = value.replace(/[.…\s]+$/g, "").trim();
  const compact = normalized.replace(/\s+/g, "");

  if (!compact) {
    return true;
  }

  return compact.length <= 4 && !looksLikeFinishedOracleSentence(normalized);
}

function looksLikeFinishedOracleSentence(value: string) {
  return /[.!?…]$/.test(value) || /(니다|요|죠|함|합니다|됩니다|였습니다|하겠습니다|할게요|했어요|중입니다|입니다)$/u.test(
    value
  );
}

function buildLiveOracleProgressExpression() {
  return `(() => {
    const markdownSelector = '.markdown,[data-message-content],.prose,[class*="markdown"]';
    const assistantTurnSelector = [
      'article[data-testid^="conversation-turn"][data-message-author-role="assistant"]',
      'article[data-testid^="conversation-turn"][data-turn="assistant"]',
      'div[data-testid^="conversation-turn"][data-message-author-role="assistant"]',
      'div[data-testid^="conversation-turn"][data-turn="assistant"]',
      'section[data-testid^="conversation-turn"][data-message-author-role="assistant"]',
      'section[data-testid^="conversation-turn"][data-turn="assistant"]',
      '[data-message-author-role="assistant"]',
      '[data-turn="assistant"]'
    ].join(', ');
    const userTurnSelector = [
      'article[data-testid^="conversation-turn"][data-message-author-role="user"]',
      'article[data-testid^="conversation-turn"][data-turn="user"]',
      'div[data-testid^="conversation-turn"][data-message-author-role="user"]',
      'div[data-testid^="conversation-turn"][data-turn="user"]',
      'section[data-testid^="conversation-turn"][data-message-author-role="user"]',
      'section[data-testid^="conversation-turn"][data-turn="user"]',
      '[data-message-author-role="user"]',
      '[data-turn="user"]'
    ].join(', ');
    const excluded = (node) =>
      Boolean(node?.closest?.('form, nav, aside, [data-testid*="sidebar"], [data-testid*="composer"]'));
    const normalizeComparable = (value) => (value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const collectContainerText = (container) => {
      const candidates = Array.from(container.querySelectorAll(markdownSelector)).filter((node) => !excluded(node));

      for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
        const node = candidates[candidateIndex];
        const text = (node.innerText || node.textContent || '').trim();

        if (text) {
          return text;
        }
      }

      const fallback = (container.innerText || container.textContent || '').trim();
      return excluded(container) ? '' : fallback;
    };
    const readLatestTurnText = (selector) => {
      const containers = Array.from(document.querySelectorAll(selector)).filter((node) => !excluded(node));

      for (let index = containers.length - 1; index >= 0; index -= 1) {
        const text = collectContainerText(containers[index]);

        if (text) {
          return text;
        }
      }

      return '';
    };
    const assistantContainers = Array.from(document.querySelectorAll(assistantTurnSelector)).filter((node) => !excluded(node));
    let assistantPreview = '';

    for (let index = assistantContainers.length - 1; index >= 0; index -= 1) {
      const container = assistantContainers[index];
      assistantPreview = collectContainerText(container);

      if (assistantPreview) {
        break;
      }
    }

    const latestUserPreview = readLatestTurnText(userTurnSelector);

    if (
      assistantPreview &&
      latestUserPreview &&
      normalizeComparable(assistantPreview) === normalizeComparable(latestUserPreview)
    ) {
      assistantPreview = '';
    }

    const thinkingSelectors = [
      'span.loading-shimmer',
      'span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary',
      '[data-testid*="thinking"]',
      '[data-testid*="reasoning"]',
      '[role="status"]',
      '[aria-live="polite"]',
    ];
    let thinkingStatus = '';

    for (const selector of thinkingSelectors) {
      const nodes = Array.from(document.querySelectorAll(selector));

      for (const node of nodes) {
        const text = (node.textContent || '').trim();
        if (text && !/what's on your mind today\\??/i.test(text)) {
          thinkingStatus = text;
          break;
        }
      }

      if (thinkingStatus) {
        break;
      }
    }

    return { assistantPreview, thinkingStatus };
  })()`;
}

async function withOracleCdpTimeout<T>(promise: Promise<T>, timeoutMs?: number | null) {
  const normalizedTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;

  if (normalizedTimeoutMs === null) {
    return await promise;
  }

  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("oracle-cdp-timeout"));
        }, normalizedTimeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function resolveOracleHomeDir() {
  return process.env.ORACLE_HOME_DIR?.trim() || path.join(os.homedir(), ".oracle");
}
