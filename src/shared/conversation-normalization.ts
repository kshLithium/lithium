export function normalizeConversationComparable(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function dedupeNormalizedParagraphs(value: string) {
  const paragraphs = splitConversationParagraphs(value);

  if (!paragraphs.length) {
    return "";
  }

  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const paragraph of paragraphs) {
    const comparable = normalizeConversationComparable(paragraph);

    if (!comparable || seen.has(comparable)) {
      continue;
    }

    seen.add(comparable);
    deduped.push(paragraph);
  }

  return deduped.join("\n\n").trim();
}

export function buildNormalizedConversationBodyKey(value: string) {
  const paragraphs = splitConversationParagraphs(dedupeNormalizedParagraphs(value));

  return paragraphs
    .map((paragraph) => normalizeConversationComparable(paragraph))
    .filter(Boolean)
    .join("\n\n");
}

function splitConversationParagraphs(value: string) {
  return value
    .trim()
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}
