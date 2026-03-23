import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export type SyncTeXTarget = {
  pageNumber: number;
  yRatio: number | null;
};

export type SyncTeXSourceLocation = {
  sourcePath: string;
  lineNumber: number;
};

type SyncTeXRecord = {
  sourcePath: string;
  pageNumber: number;
  lineNumber: number;
  y: number;
  yRatio: number | null;
};

export async function resolveSyncTeXTarget(input: {
  synctexPath: string;
  sourcePath: string;
  lineNumber: number;
}): Promise<SyncTeXTarget | null> {
  const content = await readSyncTeXContent(input.synctexPath);
  return parseSyncTeX(content, input.sourcePath, input.lineNumber);
}

export async function resolveSyncTeXSourceLocation(input: {
  synctexPath: string;
  pageNumber: number;
  yRatio: number;
}): Promise<SyncTeXSourceLocation | null> {
  const content = await readSyncTeXContent(input.synctexPath);
  return parseSyncTeXSourceLocation(content, input.pageNumber, input.yRatio);
}

export function parseSyncTeX(content: string, sourcePath: string, lineNumber: number): SyncTeXTarget | null {
  const normalizedSourcePath = normalizePath(sourcePath);
  const records = parseSyncTeXRecords(content);
  let bestMatch: SyncTeXRecord | null = null;

  for (const record of records) {
    if (record.sourcePath !== normalizedSourcePath) {
      continue;
    }

    if (!bestMatch) {
      bestMatch = record;
      continue;
    }

    const currentDelta = scoreSyncLine(bestMatch.lineNumber, lineNumber);
    const nextDelta = scoreSyncLine(record.lineNumber, lineNumber);

    if (nextDelta < currentDelta || (nextDelta === currentDelta && record.lineNumber >= bestMatch.lineNumber)) {
      bestMatch = record;
    }
  }

  if (!bestMatch) {
    return null;
  }

  return {
    pageNumber: bestMatch.pageNumber,
    yRatio: bestMatch.yRatio
  };
}

export function parseSyncTeXSourceLocation(
  content: string,
  pageNumber: number,
  yRatio: number
): SyncTeXSourceLocation | null {
  const records = parseSyncTeXRecords(content).filter((record) => record.pageNumber === pageNumber);
  if (!records.length) {
    return null;
  }

  const targetRatio = clamp(yRatio, 0, 1);
  let bestMatch = records[0];
  let bestDistance = scoreSyncRatio(records[0].yRatio ?? 0, targetRatio);

  for (const record of records.slice(1)) {
    const distance = scoreSyncRatio(record.yRatio ?? 0, targetRatio);
    if (distance < bestDistance) {
      bestMatch = record;
      bestDistance = distance;
    }
  }

  return {
    sourcePath: bestMatch.sourcePath,
    lineNumber: bestMatch.lineNumber
  };
}

function parseSyncTeXRecords(content: string): SyncTeXRecord[] {
  const sourceTags = new Map<number, string>();
  const pageMaxY = new Map<number, number>();
  const rawRecords: Array<{
    sourcePath: string;
    pageNumber: number;
    lineNumber: number;
    y: number;
  }> = [];
  let currentPage = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    const inputMatch = line.match(/^Input:(\d+):(.*)$/);
    if (inputMatch) {
      const tag = Number.parseInt(inputMatch[1], 10);
      const inputPath = normalizePath(inputMatch[2] ?? "");
      if (inputPath) {
        sourceTags.set(tag, inputPath);
      }
      continue;
    }

    const pageMatch = line.match(/^\{(\d+)/);
    if (pageMatch) {
      currentPage = Number.parseInt(pageMatch[1], 10);
      continue;
    }

    const recordMatch = line.match(/^[\[\(vhxgk\$c]([0-9]+),([0-9]+)(?:,([0-9]+))?:(-?[0-9]+),(-?[0-9]+)/i);
    if (!recordMatch || !currentPage) {
      continue;
    }

    const tag = Number.parseInt(recordMatch[1], 10);
    const sourcePath = sourceTags.get(tag);
    if (!sourcePath) {
      continue;
    }

    const lineNumber = Number.parseInt(recordMatch[2], 10);
    const y = Math.max(0, Number.parseInt(recordMatch[5], 10));
    pageMaxY.set(currentPage, Math.max(pageMaxY.get(currentPage) ?? 0, y));

    rawRecords.push({
      sourcePath,
      pageNumber: currentPage,
      lineNumber,
      y
    });
  }

  return rawRecords.map((record) => {
    const maxY = pageMaxY.get(record.pageNumber) ?? 0;
    return {
      ...record,
      yRatio: maxY > 0 ? clamp(record.y / maxY, 0, 1) : null
    };
  });
}

function scoreSyncLine(candidateLine: number, targetLine: number) {
  const delta = Math.abs(candidateLine - targetLine);
  const futurePenalty = candidateLine > targetLine ? 0.25 : 0;
  return delta + futurePenalty;
}

function scoreSyncRatio(candidateRatio: number, targetRatio: number) {
  return Math.abs(candidateRatio - targetRatio);
}

function normalizePath(value: string) {
  if (!value) {
    return "";
  }

  return path.normalize(path.resolve(value));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

async function readSyncTeXContent(synctexPath: string) {
  const compressed = await readFile(synctexPath);
  return gunzipSync(compressed).toString("utf8");
}
