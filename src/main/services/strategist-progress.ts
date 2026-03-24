import os from "node:os";
import path from "node:path";
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
      const normalizedPreview = sanitizeOracleProgressText(explicitPreview);

      if (normalizedPreview) {
        assistantPreviews.push(normalizedPreview);
      }
      continue;
    }

    const thinkingMatch = line.match(/^\d+%\s+\[[^\]]+\]\s+—\s+(.+)$/);

    if (thinkingMatch?.[1]) {
      const normalizedThinking = sanitizeOracleProgressText(thinkingMatch[1]);

      if (normalizedThinking) {
        thinkingPreviews.push(normalizedThinking);
      }
    }
  }

  const uniqueErrorPreviews = dedupeOracleProgressEntries(errorPreviews);
  const uniqueAssistantPreviews = dedupeOracleProgressEntries(assistantPreviews);
  const uniqueThinkingPreviews = dedupeOracleProgressEntries(thinkingPreviews);
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

  const liveSummary = liveProgress?.progressSummary ?? "";
  const logSummary = logProgress.progressSummary ?? "";
  const preferredSummary =
    isGenericStrategistProgressSummary(liveSummary) && !isGenericStrategistProgressSummary(logSummary)
      ? logSummary
      : liveSummary || logSummary;
  const preferredDetails = dedupeOracleProgressEntries([
    ...logProgress.progressDetails,
    ...(liveProgress?.progressDetails ?? [])
  ]).filter((detail) => detail !== preferredSummary);

  return {
    progressSummary: preferredSummary,
    progressDetails: preferredDetails
  };
}

export async function readLiveOracleSessionProgress(sessionSlug: string): Promise<StrategistProgress | null> {
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
      const assistantPreview = sanitizeOracleProgressText(value?.assistantPreview ?? "");
      const thinkingStatus = sanitizeOracleProgressText(value?.thinkingStatus ?? "");
      const previewHistory =
        assistantPreview.length > 0
          ? [assistantPreview]
          : thinkingStatus.length > 0
            ? [thinkingStatus]
            : [];

      return {
        progressSummary: previewHistory.at(-1) ?? "",
        progressDetails: previewHistory.slice(0, -1)
      };
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

  return /^(thinking|thinking…|reading documents?|reading document|heavy thinking|searching|browsing|analyzing|processing|생각 중|문서를 읽는 중)$/i.test(
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

function dedupeOracleProgressEntries(values: string[]) {
  const entries: string[] = [];

  for (const value of values) {
    const normalized = sanitizeOracleProgressText(value);

    if (!normalized || entries.includes(normalized)) {
      continue;
    }

    entries.push(normalized);
  }

  return entries;
}

function buildLiveOracleProgressExpression() {
  return `(() => {
    const markdownSelector = '.markdown,[data-message-content],.prose,[class*="markdown"]';
    const excluded = (node) =>
      Boolean(node?.closest?.('form, nav, aside, [data-testid*="sidebar"], [data-testid*="composer"]'));
    const assistantContainers = Array.from(
      document.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]')
    );
    let assistantPreview = '';

    for (let index = assistantContainers.length - 1; index >= 0; index -= 1) {
      const container = assistantContainers[index];
      const candidates = Array.from(container.querySelectorAll(markdownSelector)).filter((node) => !excluded(node));

      for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
        const node = candidates[candidateIndex];
        const text = (node.innerText || node.textContent || '').trim();

        if (text) {
          assistantPreview = text;
          break;
        }
      }

      if (assistantPreview) {
        break;
      }
    }

    if (!assistantPreview) {
      const fallbacks = Array.from(document.querySelectorAll(markdownSelector)).filter((node) => {
        if (excluded(node)) return false;
        const roleNode = node.closest('[data-message-author-role], [data-turn]');
        const role =
          (roleNode?.getAttribute('data-message-author-role') || roleNode?.getAttribute('data-turn') || '').toLowerCase();
        return role !== 'user';
      });

      for (let index = fallbacks.length - 1; index >= 0; index -= 1) {
        const text = (fallbacks[index].innerText || fallbacks[index].textContent || '').trim();
        if (text) {
          assistantPreview = text;
          break;
        }
      }
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
