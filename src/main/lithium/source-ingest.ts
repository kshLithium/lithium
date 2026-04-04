import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactRef,
  BranchRecord,
  DiscoveredSourceSpec,
  ObjectiveRecord,
  SourceChunkRecord,
  SourceKind,
  SourceRecord
} from "../../shared/types";
import { buildProjectPaths } from "../services/workspace-layout";
import { ArtifactStore } from "./artifact-store";
import { ResearchStore } from "./store";
import { createId, normalizeWhitespace, nowIso, sha256 } from "./utils";

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_LIMIT_BYTES = 1_500_000;
const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 150;

export class SourceIngest {
  constructor(
    private readonly deps: {
      store: ResearchStore;
      artifactStore: ArtifactStore;
    }
  ) {}

  async addInputs(input: {
    workspacePath: string;
    objective: ObjectiveRecord;
    branch?: BranchRecord | null;
    inputs: string[];
  }) {
    const sources: SourceRecord[] = [];
    for (const entry of input.inputs) {
      const source = await this.ingestOne({
        workspacePath: input.workspacePath,
        objective: input.objective,
        branch: input.branch ?? undefined,
        locator: entry,
        defaultKind: inferSourceKind(entry)
      });
      if (source) {
        sources.push(source);
      }
    }
    return sources;
  }

  async addDiscoveredSources(input: {
    workspacePath: string;
    objective: ObjectiveRecord;
    branch?: BranchRecord | null;
    sources: DiscoveredSourceSpec[];
  }) {
    const created: SourceRecord[] = [];
    for (const discovered of input.sources) {
      const source = await this.ingestOne({
        workspacePath: input.workspacePath,
        objective: input.objective,
        branch: input.branch ?? undefined,
        locator: discovered.locator,
        defaultKind: discovered.kind,
        titleHint: discovered.title,
        summaryHint: discovered.summary
      });
      if (source) {
        created.push(source);
      }
    }
    return created;
  }

  async search(input: {
    workspacePath: string;
    objectiveId: string;
    branchId?: string;
    query: string;
    limit?: number;
  }): Promise<SourceChunkRecord[]> {
    const terms = tokenize(input.query);
    const chunks = this.deps.store
      .listProjections(input.workspacePath, "source_chunk")
      .filter((entry) => entry.objectiveId === input.objectiveId)
      .filter((entry) => !input.branchId || entry.branchId === input.branchId);

    return chunks
      .map((chunk) => ({
        chunk,
        score: scoreChunk(chunk.text, terms)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.chunk.chunkIndex - right.chunk.chunkIndex)
      .slice(0, input.limit ?? 6)
      .map((entry) => entry.chunk);
  }

  private async ingestOne(input: {
    workspacePath: string;
    objective: ObjectiveRecord;
    branch?: BranchRecord;
    locator: string;
    defaultKind: SourceKind;
    titleHint?: string;
    summaryHint?: string;
  }): Promise<SourceRecord | null> {
    const canonicalLocator = canonicalizeLocator(input.locator);
    const existing = this.deps.store
      .listProjections(input.workspacePath, "source")
      .find(
        (entry) =>
          entry.objectiveId === input.objective.id &&
          (entry.canonicalLocator === canonicalLocator || entry.locator === input.locator)
      );
    if (existing) {
      return existing;
    }

    const materialized = isHttpLocator(input.locator)
      ? await this.fetchRemote(input.workspacePath, input.locator, input.defaultKind)
      : await this.captureLocal(input.workspacePath, input.locator, input.defaultKind);

    if (!materialized) {
      return null;
    }

    const text = extractTextByMime(materialized.body, materialized.contentType, input.locator);
    const normalizedText = normalizeWhitespace(text);
    const now = nowIso();
    const sourceId = createId("src");
    const title = input.titleHint?.trim() || guessTitle(input.locator, normalizedText);
    const textArtifactRef = normalizedText
      ? await this.deps.artifactStore.writeTextArtifact({
          workspacePath: input.workspacePath,
          directory: buildProjectPaths(input.workspacePath).sourceTextsDir,
          fileName: `${sourceId}.txt`,
          body: normalizedText,
          kind: "source-text",
          contentType: "text/plain"
        })
      : undefined;
    const source: SourceRecord = {
      id: sourceId,
      objectiveId: input.objective.id,
      branchId: input.branch?.id,
      kind: input.defaultKind,
      title,
      locator: input.locator,
      canonicalLocator,
      summary: input.summaryHint?.trim() || normalizedText.slice(0, 240) || title,
      bodyArtifactRef: materialized.artifactRef,
      textArtifactRef,
      contentHash: sha256(materialized.body),
      metadata: {
        contentType: materialized.contentType,
        sizeBytes: materialized.body.byteLength
      },
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.upsertProjection(input.workspacePath, "source", source);

    const chunks = chunkText(normalizedText);
    chunks.forEach((chunkTextValue, index) => {
      const chunk: SourceChunkRecord = {
        id: createId("chunk"),
        sourceId: source.id,
        objectiveId: source.objectiveId,
        branchId: source.branchId,
        chunkIndex: index,
        text: chunkTextValue,
        hash: sha256(chunkTextValue),
        createdAt: now,
        updatedAt: now
      };
      this.deps.store.upsertProjection(input.workspacePath, "source_chunk", chunk);
    });

    return source;
  }

  private async fetchRemote(workspacePath: string, locator: string, kind: SourceKind) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(locator, {
        signal: controller.signal,
        headers: {
          "user-agent": "Lithium/4.0"
        }
      });
      if (!response.ok || !response.body) {
        return null;
      }

      const contentType = response.headers.get("content-type") ?? inferContentTypeFromLocator(locator);
      const bytes = await readLimitedBody(response, DEFAULT_FETCH_LIMIT_BYTES);
      const directory = buildProjectPaths(workspacePath).sourceBodiesDir;
      const fileName = `${createId("body")}${extensionFor(locator, contentType, kind)}`;
      const artifactRef = await this.deps.artifactStore.writeBufferArtifact({
        directory,
        fileName,
        body: bytes,
        kind: "source-body",
        contentType
      });
      return {
        body: bytes,
        contentType,
        artifactRef
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async captureLocal(workspacePath: string, sourcePath: string, kind: SourceKind) {
    const absolutePath = path.resolve(sourcePath);
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      throw new Error(`Source input not found: ${sourcePath}`);
    }
    if (fileStat.size > DEFAULT_FETCH_LIMIT_BYTES) {
      throw new Error(`Source input exceeds ${DEFAULT_FETCH_LIMIT_BYTES} bytes: ${sourcePath}`);
    }

    const paths = buildProjectPaths(workspacePath);
    const extension = path.extname(absolutePath) || ".bin";
    const targetDir = kind === "attachment" ? paths.attachmentsDir : paths.sourceBodiesDir;
    const targetPath = path.join(targetDir, `${createId("local")}${extension}`);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(absolutePath, targetPath);
    const body = await readFile(targetPath);
    return {
      body,
      contentType: inferContentTypeFromLocator(absolutePath),
      artifactRef: {
        id: createId("art"),
        kind: kind === "attachment" ? "attachment" : "source-body",
        path: targetPath,
        hash: sha256(body),
        sizeBytes: body.byteLength,
        contentType: inferContentTypeFromLocator(absolutePath),
        createdAt: nowIso()
      } satisfies ArtifactRef
    };
  }
}

async function readLimitedBody(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(`Fetched source exceeded ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function canonicalizeLocator(locator: string) {
  if (!isHttpLocator(locator)) {
    return path.resolve(locator);
  }

  const url = new URL(locator);
  url.hash = "";
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  return url.toString();
}

function inferSourceKind(locator: string): SourceKind {
  if (!isHttpLocator(locator)) {
    return "attachment";
  }
  if (/github\.com\/[^/]+\/[^/]+/i.test(locator)) {
    return "repo";
  }
  if (/arxiv\.org|doi\.org|openreview\.net/i.test(locator)) {
    return "paper";
  }
  return "web";
}

function isHttpLocator(locator: string) {
  return /^https?:\/\//i.test(locator);
}

function inferContentTypeFromLocator(locator: string) {
  const lower = locator.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "text/html";
  }
  if (lower.endsWith(".json")) {
    return "application/json";
  }
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".log")) {
    return "text/plain";
  }
  return "application/octet-stream";
}

function extensionFor(locator: string, contentType: string, kind: SourceKind) {
  const direct = path.extname(locator);
  if (direct) {
    return direct;
  }
  if (contentType.includes("html")) {
    return ".html";
  }
  if (contentType.includes("json")) {
    return ".json";
  }
  if (contentType.includes("pdf")) {
    return ".pdf";
  }
  return kind === "repo" ? ".html" : ".bin";
}

function guessTitle(locator: string, text: string) {
  const firstLine = text.split("\n").map((entry) => entry.trim()).find(Boolean);
  if (firstLine && firstLine.length <= 120) {
    return firstLine;
  }
  if (isHttpLocator(locator)) {
    const url = new URL(locator);
    return url.pathname.split("/").filter(Boolean).pop() || url.hostname;
  }
  return path.basename(locator);
}

function extractTextByMime(body: Uint8Array, contentType: string, locator: string) {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() || inferContentTypeFromLocator(locator);
  switch (normalized) {
    case "text/plain":
    case "text/markdown":
    case "application/json":
      return Buffer.from(body).toString("utf8");
    case "text/html":
      return htmlToText(Buffer.from(body).toString("utf8"));
    case "application/pdf":
      return pdfToText(Buffer.from(body));
    default:
      return Buffer.from(body).toString("utf8");
  }
}

function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function pdfToText(buffer: Buffer) {
  const latin = buffer.toString("latin1");
  const matches = latin.match(/\(([^()]{1,200})\)/g) ?? [];
  const extracted = matches
    .map((entry) => entry.slice(1, -1))
    .join(" ")
    .replace(/\\[nrt]/g, " ")
    .replace(/\\\d{3}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return extracted || latin.replace(/[^\x20-\x7E\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function chunkText(text: string) {
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + DEFAULT_CHUNK_SIZE);
    const slice = text.slice(start, end).trim();
    if (slice) {
      chunks.push(slice);
    }
    if (end >= text.length) {
      break;
    }
    start = Math.max(start + 1, end - DEFAULT_CHUNK_OVERLAP);
  }
  return chunks;
}

function tokenize(query: string) {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2);
}

function scoreChunk(text: string, terms: string[]) {
  if (terms.length === 0) {
    return 0;
  }
  const normalized = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) {
      score += 1;
      const count = normalized.split(term).length - 1;
      score += Math.min(count, 4) * 0.25;
    }
  }
  return score;
}
