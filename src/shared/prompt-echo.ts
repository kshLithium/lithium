export type PromptEchoMatcher = {
  isEcho: (value: string | null | undefined) => boolean;
};

export function buildPromptEchoMatcher(promptPreview?: string | null): PromptEchoMatcher | null {
  const normalizedPrompt = normalizePromptEchoComparable(promptPreview ?? "");

  if (!normalizedPrompt) {
    return null;
  }

  const promptPrefix =
    normalizedPrompt.length >= 80 ? normalizedPrompt.slice(0, Math.min(200, normalizedPrompt.length)) : "";
  const minFragment = Math.min(40, normalizedPrompt.length);

  return {
    isEcho(value) {
      const normalized = normalizePromptEchoComparable(value ?? "");

      if (!normalized) {
        return false;
      }

      if (normalized === normalizedPrompt) {
        return true;
      }

      if (promptPrefix && normalized.startsWith(promptPrefix)) {
        return true;
      }

      if (normalized.length >= minFragment && normalizedPrompt.startsWith(normalized)) {
        return true;
      }

      if (normalized.includes("…") || normalized.includes("...")) {
        const marker = normalized.includes("…") ? "…" : "...";
        const [prefixRaw, suffixRaw] = normalized.split(marker);
        const prefix = prefixRaw?.trim() ?? "";
        const suffix = suffixRaw?.trim() ?? "";

        if (!prefix && !suffix) {
          return false;
        }

        if (prefix && !normalizedPrompt.includes(prefix)) {
          return false;
        }

        if (suffix && !normalizedPrompt.includes(suffix)) {
          return false;
        }

        return prefix.length + suffix.length >= minFragment;
      }

      return false;
    }
  };
}

export function stripLeadingPromptEchoParagraph(
  body: string,
  promptPreview?: string | null,
  minimumPromptLength = 16
) {
  const trimmedBody = body.trim();
  const normalizedPrompt = normalizePromptEchoComparable(promptPreview ?? "");
  const matcher = buildPromptEchoMatcher(promptPreview);

  if (!trimmedBody || !matcher || normalizedPrompt.length < minimumPromptLength) {
    return trimmedBody;
  }

  const paragraphs = trimmedBody
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (!paragraphs.length) {
    return "";
  }

  const [firstParagraph, ...rest] = paragraphs;

  if (!matcher.isEcho(firstParagraph)) {
    return trimmedBody;
  }

  return rest.join("\n\n").trim();
}

export function sanitizePromptEchoProgress<
  T extends {
    progressSummary: string;
    progressDetails: string[];
  }
>(progress: T, promptPreview?: string | null): T {
  const matcher = buildPromptEchoMatcher(promptPreview);

  if (!matcher) {
    return progress;
  }

  const filteredLines = dedupeLines(
    [progress.progressSummary, ...progress.progressDetails]
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !matcher.isEcho(line))
  );

  return {
    ...progress,
    progressSummary: filteredLines[0] ?? "",
    progressDetails: filteredLines.slice(1)
  };
}

export function isPromptEcho(value: string, promptPreview?: string | null) {
  return Boolean(buildPromptEchoMatcher(promptPreview)?.isEcho(value));
}

function normalizePromptEchoComparable(value: string) {
  return value
    .replace(/^["'“”‘’「」『』<>\[\](){}]+|["'“”‘’「」『』<>\[\](){}]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function dedupeLines(values: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}
