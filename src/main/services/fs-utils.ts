import { mkdirSync, writeFileSync, type Stats, type WriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";

export const OUTPUT_TRUNCATION_MARKER = "\n[lithium output truncated]\n";

export async function pathExists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFileIfExists(filePath: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function prepareTextFiles(filePaths: string[]) {
  await Promise.all(filePaths.map(async (filePath) => await prepareTextFile(filePath)));
}

export function prepareTextFilesSync(filePaths: string[]) {
  for (const filePath of filePaths) {
    prepareTextFileSync(filePath);
  }
}

export async function statIfExists(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

export function appendTailBuffer(current: string, nextChunk: string, maxBytes: number) {
  const combined = current + nextChunk;
  const buffer = Buffer.from(combined, "utf8");

  if (buffer.byteLength <= maxBytes) {
    return combined;
  }

  return buffer.subarray(buffer.byteLength - maxBytes).toString("utf8");
}

export function appendHeadTailBuffer(current: string, nextChunk: string, maxBytes: number) {
  const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8");

  if (maxBytes <= markerBytes + 2) {
    return appendTailBuffer(current, nextChunk, maxBytes);
  }

  const availableBytes = maxBytes - markerBytes;
  const headBytes = Math.max(1, Math.ceil(availableBytes / 2));
  const tailBytes = Math.max(1, availableBytes - headBytes);
  const markerIndex = current.indexOf(OUTPUT_TRUNCATION_MARKER);

  if (markerIndex < 0) {
    const combined = current + nextChunk;
    const buffer = Buffer.from(combined, "utf8");

    if (buffer.byteLength <= maxBytes) {
      return combined;
    }

    return [
      buffer.subarray(0, headBytes).toString("utf8"),
      OUTPUT_TRUNCATION_MARKER,
      buffer.subarray(buffer.byteLength - tailBytes).toString("utf8")
    ].join("");
  }

  const head = current.slice(0, markerIndex);
  const tail = current.slice(markerIndex + OUTPUT_TRUNCATION_MARKER.length);

  return [head, OUTPUT_TRUNCATION_MARKER, appendTailBuffer(tail, nextChunk, tailBytes)].join("");
}

export async function endWriteStream(stream: WriteStream) {
  stream.end();
  await finished(stream);
}

async function prepareTextFile(filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "", "utf8");
}

function prepareTextFileSync(filePath: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "", "utf8");
}
