import { execFile } from "node:child_process";
import { mkdtemp, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  BranchRecord,
  DiscoveredSourceSpec,
  ObjectiveRecord,
  SourceChunkRecord,
  SourceKind,
  SourceLinkReason,
  SourceRecord
} from "../../shared/types";
import { buildProjectPaths } from "../services/workspace-layout";
import { ArtifactStore } from "./artifact-store";
import { type ProjectionMutation, ResearchStore } from "./store";
import { createId, normalizeWhitespace, nowIso, sha256 } from "./utils";

const execFileAsync = promisify(execFile);
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_FETCH_LIMIT_BYTES = 2_500_000;
const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 180;
const REPO_SCAN_IGNORES = new Set([
  ".git",
  ".lithium",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "build",
  "coverage"
] as const);
const REPO_TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".swift",
  ".sh",
  ".sql",
  ".ipynb"
] as const);

type MaterializedSource = {
  body: Uint8Array;
  contentType: string;
  artifactRef: SourceRecord["bodyArtifactRef"];
  text: string;
  summary: string;
  title?: string;
};

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
        defaultKind: inferSourceKind(entry),
        reason: "manual"
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
        summaryHint: discovered.summary,
        reason: "discover"
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
    const projection = this.deps.store.getProjection(input.workspacePath);
    const eligibleSourceIds = new Set(
      projection.sourceLinks
        .filter((entry) => entry.objectiveId === input.objectiveId)
        .filter((entry) => entry.scope === "objective" || (!!input.branchId && entry.branchId === input.branchId))
        .map((entry) => entry.sourceId)
    );
    const chunks = projection.sourceChunks.filter(
      (entry) => entry.objectiveId === input.objectiveId && eligibleSourceIds.has(entry.sourceId)
    );
    const scored = scoreChunksBm25(chunks, input.query);
    return scored.slice(0, input.limit ?? 6).map((entry) => entry.chunk);
  }

  listLinkedSourceIds(workspacePath: string, objectiveId: string, branchId?: string) {
    const projection = this.deps.store.getProjection(workspacePath);
    return Array.from(
      new Set(
        projection.sourceLinks
          .filter((entry) => entry.objectiveId === objectiveId)
          .filter((entry) => entry.scope === "objective" || (!!branchId && entry.branchId === branchId))
          .map((entry) => entry.sourceId)
      )
    );
  }

  private async ingestOne(input: {
    workspacePath: string;
    objective: ObjectiveRecord;
    branch?: BranchRecord;
    locator: string;
    defaultKind: SourceKind;
    titleHint?: string;
    summaryHint?: string;
    reason: SourceLinkReason;
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
      await this.ensureSourceLink({
        workspacePath: input.workspacePath,
        objective: input.objective,
        branch: input.branch,
        source: existing,
        reason: input.reason === "manual" ? "reuse" : input.reason
      });
      return existing;
    }

    const materialized = await this.materializeSource(input.workspacePath, input.locator, input.defaultKind);
    if (!materialized) {
      return null;
    }

    const normalizedText = normalizeWhitespace(materialized.text);
    const now = nowIso();
    const sourceId = createId("src");
    const title = input.titleHint?.trim() || materialized.title || guessTitle(input.locator, normalizedText);
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
      kind: input.defaultKind,
      title,
      locator: input.locator,
      canonicalLocator,
      summary: input.summaryHint?.trim() || materialized.summary || normalizedText.slice(0, 240) || title,
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

    const mutations: ProjectionMutation[] = [
      {
        type: "upsert",
        kind: "source",
        value: source
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "source.ingested",
          objectiveId: source.objectiveId,
          branchId: input.branch?.id,
          payload: {
            sourceId: source.id,
            locator: source.locator,
            kind: source.kind
          }
        })
      }
    ];

    chunkText(normalizedText).forEach((chunkTextValue, index) => {
      const chunk: SourceChunkRecord = {
        id: createId("chunk"),
        sourceId: source.id,
        objectiveId: source.objectiveId,
        chunkIndex: index,
        text: chunkTextValue,
        hash: sha256(chunkTextValue),
        createdAt: now,
        updatedAt: now
      };
      mutations.push({
        type: "upsert",
        kind: "source_chunk",
        value: chunk
      });
    });

    const link = this.createSourceLink({
      objective: input.objective,
      branch: input.branch,
      source,
      reason: input.reason
    });
    mutations.push(
      {
        type: "upsert",
        kind: "source_link",
        value: link
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "source.linked",
          objectiveId: source.objectiveId,
          branchId: input.branch?.id,
          payload: {
            sourceId: source.id,
            linkId: link.id,
            scope: link.scope,
            reason: link.reason
          }
        })
      }
    );

    this.deps.store.applyMutations(input.workspacePath, mutations);
    return source;
  }

  private async ensureSourceLink(input: {
    workspacePath: string;
    objective: ObjectiveRecord;
    branch?: BranchRecord;
    source: SourceRecord;
    reason: SourceLinkReason;
  }) {
    const existingLink = this.deps.store
      .listProjections(input.workspacePath, "source_link")
      .find(
        (entry) =>
          entry.objectiveId === input.objective.id &&
          entry.sourceId === input.source.id &&
          entry.branchId === input.branch?.id &&
          entry.scope === (input.branch ? "branch" : "objective")
      );
    if (existingLink) {
      return existingLink;
    }

    const link = this.createSourceLink({
      objective: input.objective,
      branch: input.branch,
      source: input.source,
      reason: input.reason
    });
    this.deps.store.applyMutations(input.workspacePath, [
      {
        type: "upsert",
        kind: "source_link",
        value: link
      },
      {
        type: "event",
        value: this.deps.store.createEvent({
          type: "source.linked",
          objectiveId: input.source.objectiveId,
          branchId: input.branch?.id,
          payload: {
            sourceId: input.source.id,
            linkId: link.id,
            scope: link.scope,
            reason: link.reason
          }
        })
      }
    ]);
    return link;
  }

  private createSourceLink(input: {
    objective: ObjectiveRecord;
    branch?: BranchRecord;
    source: SourceRecord;
    reason: SourceLinkReason;
  }) {
    const now = nowIso();
    return {
      id: createId("slink"),
      objectiveId: input.objective.id,
      sourceId: input.source.id,
      branchId: input.branch?.id,
      scope: input.branch ? "branch" : "objective",
      reason: input.reason,
      createdAt: now,
      updatedAt: now
    } as const;
  }

  private async materializeSource(workspacePath: string, locator: string, kind: SourceKind): Promise<MaterializedSource | null> {
    if (!isHttpLocator(locator)) {
      return await this.captureLocal(workspacePath, locator, kind);
    }
    switch (kind) {
      case "repo":
        return await this.captureRemoteRepo(workspacePath, locator);
      case "paper":
        return await this.fetchRemotePaper(workspacePath, locator);
      default:
        return await this.fetchRemoteWeb(workspacePath, locator, kind);
    }
  }

  private async fetchRemoteWeb(workspacePath: string, locator: string, kind: SourceKind): Promise<MaterializedSource | null> {
    const response = await fetchRemote(locator);
    if (!response) {
      return null;
    }

    const contentType = response.contentType;
    const directory = buildProjectPaths(workspacePath).sourceBodiesDir;
    const fileName = `${createId("body")}${extensionFor(locator, contentType, kind)}`;
    const artifactRef = await this.deps.artifactStore.writeBufferArtifact({
      directory,
      fileName,
      body: response.body,
      kind: "source-body",
      contentType
    });

    const html = Buffer.from(response.body).toString("utf8");
    const text = extractTextByMime(response.body, contentType, locator);
    return {
      body: response.body,
      contentType,
      artifactRef,
      text,
      title: extractHtmlTitle(html) || undefined,
      summary: text.slice(0, 240)
    };
  }

  private async fetchRemotePaper(workspacePath: string, locator: string): Promise<MaterializedSource | null> {
    const response = await fetchRemote(locator);
    if (!response) {
      return null;
    }

    const contentType = response.contentType;
    const directory = buildProjectPaths(workspacePath).sourceBodiesDir;
    const fileName = `${createId("paper")}${extensionFor(locator, contentType, "paper")}`;
    const artifactRef = await this.deps.artifactStore.writeBufferArtifact({
      directory,
      fileName,
      body: response.body,
      kind: "source-body",
      contentType
    });

    const text = await extractPaperText(fileName.endsWith(".pdf") ? path.join(directory, fileName) : undefined, response.body, locator);
    return {
      body: response.body,
      contentType,
      artifactRef,
      text,
      summary: text.slice(0, 240)
    };
  }

  private async captureRemoteRepo(workspacePath: string, locator: string): Promise<MaterializedSource | null> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-v5-repo-"));
    try {
      await execFileAsync("git", ["clone", "--depth", "1", "--single-branch", locator, tempDir], {
        maxBuffer: 20 * 1024 * 1024
      });
      const files = await collectRepositoryText(tempDir);
      const text = files.map((entry) => `FILE ${entry.relativePath}\n${entry.body}`).join("\n\n");
      const buffer = Buffer.from(text, "utf8");
      const directory = buildProjectPaths(workspacePath).sourceBodiesDir;
      const fileName = `${createId("repo")}.txt`;
      const artifactRef = await this.deps.artifactStore.writeBufferArtifact({
        directory,
        fileName,
        body: buffer,
        kind: "source-body",
        contentType: "text/plain"
      });

      return {
        body: buffer,
        contentType: "text/plain",
        artifactRef,
        text,
        title: guessRepoTitle(locator),
        summary: `Repository ingest captured ${files.length} files from ${locator}.`
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async captureLocal(workspacePath: string, sourcePath: string, kind: SourceKind): Promise<MaterializedSource> {
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
    const contentType = inferContentTypeFromLocator(absolutePath);
    return {
      body,
      contentType,
      artifactRef: {
        id: createId("art"),
        kind: kind === "attachment" ? "attachment" : "source-body",
        path: targetPath,
        hash: sha256(body),
        sizeBytes: body.byteLength,
        contentType,
        createdAt: nowIso()
      },
      text: extractTextByMime(body, contentType, absolutePath),
      summary: path.basename(absolutePath)
    };
  }
}

async function fetchRemote(locator: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(locator, {
      signal: controller.signal,
      headers: {
        "user-agent": "Lithium/5.0"
      }
    });
    if (!response.ok || !response.body) {
      return null;
    }
    const contentType = response.headers.get("content-type") ?? inferContentTypeFromLocator(locator);
    const body = await readLimitedBody(response, DEFAULT_FETCH_LIMIT_BYTES);
    return {
      body,
      contentType
    };
  } finally {
    clearTimeout(timeout);
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

async function collectRepositoryText(repoRoot: string) {
  const collected: Array<{ relativePath: string; body: string }> = [];
  let totalBytes = 0;
  const queue = [repoRoot];
  while (queue.length > 0 && totalBytes < DEFAULT_FETCH_LIMIT_BYTES) {
    const current = queue.shift()!;
    const entries = await readdir(current, {
      withFileTypes: true
    }).catch(() => []);
    for (const entry of entries) {
      if (REPO_SCAN_IGNORES.has(entry.name as never)) {
        continue;
      }
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!REPO_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase() as never) && entry.name !== "README") {
        continue;
      }
      const fileStat = await stat(absolutePath).catch(() => null);
      if (!fileStat || fileStat.size > 250_000) {
        continue;
      }
      const body = await readFile(absolutePath, "utf8").catch(() => "");
      if (!body.trim()) {
        continue;
      }
      totalBytes += Buffer.byteLength(body, "utf8");
      collected.push({
        relativePath: path.relative(repoRoot, absolutePath).replaceAll(path.sep, "/"),
        body: body.slice(0, 30_000)
      });
      if (totalBytes >= DEFAULT_FETCH_LIMIT_BYTES) {
        break;
      }
    }
  }
  return collected.slice(0, 64);
}

async function extractPaperText(filePath: string | undefined, body: Uint8Array, locator: string) {
  if (filePath) {
    try {
      const tempTextPath = `${filePath}.txt`;
      await execFileAsync("pdftotext", ["-layout", filePath, tempTextPath], {
        timeout: 20_000,
        maxBuffer: 20 * 1024 * 1024
      });
      const text = await readFile(tempTextPath, "utf8").catch(() => "");
      await rm(tempTextPath, { force: true }).catch(() => undefined);
      if (text.trim()) {
        return text;
      }
    } catch {
      // Fallback below.
    }
  }
  return pdfToText(Buffer.from(body), locator);
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
  if (/github\.com\/[^/]+\/[^/]+/i.test(locator) || /\.git$/i.test(locator)) {
    return "repo";
  }
  if (/arxiv\.org|doi\.org|openreview\.net/i.test(locator) || /\.pdf(?:$|\?)/i.test(locator)) {
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
  const direct = path.extname(locator.split("?")[0] ?? locator);
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
  return kind === "repo" ? ".txt" : ".bin";
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

function guessRepoTitle(locator: string) {
  try {
    const url = new URL(locator);
    return url.pathname.split("/").filter(Boolean).slice(-2).join("/") || url.hostname;
  } catch {
    return locator;
  }
}

function extractTextByMime(body: Uint8Array, contentType: string, locator: string) {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() || inferContentTypeFromLocator(locator);
  switch (normalized) {
    case "text/plain":
    case "text/markdown":
    case "application/json":
      return Buffer.from(body).toString("utf8");
    case "text/html":
      return htmlToStructuredText(Buffer.from(body).toString("utf8"));
    case "application/pdf":
      return pdfToText(Buffer.from(body), locator);
    default:
      return Buffer.from(body).toString("utf8");
  }
}

function extractHtmlTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? normalizeWhitespace(match[1]) : "";
}

function htmlToStructuredText(html: string) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/?(article|section|main|header|footer|aside|nav|div|p|li|ul|ol|table|tr|td|th|h[1-6]|blockquote|pre|code|br)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function pdfToText(buffer: Buffer, locator: string) {
  const latin = buffer.toString("latin1");
  const matches = latin.match(/\(([^()]{1,240})\)/g) ?? [];
  const extracted = matches
    .map((entry) => entry.slice(1, -1))
    .join(" ")
    .replace(/\\[nrt]/g, " ")
    .replace(/\\\d{3}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (extracted.length > 120) {
    return extracted;
  }
  const fallback = latin.replace(/[^\x20-\x7E\n]+/g, " ").replace(/\s+/g, " ").trim();
  return fallback || locator;
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

function scoreChunksBm25(chunks: SourceChunkRecord[], query: string) {
  if (chunks.length === 0) {
    return [];
  }
  const queryTerms = tokenizeBm25(query);
  if (queryTerms.length === 0) {
    return [];
  }
  const documents = chunks.map((chunk) => {
    const terms = tokenizeBm25(chunk.text);
    const frequencies = new Map<string, number>();
    for (const term of terms) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    return {
      chunk,
      length: Math.max(terms.length, 1),
      frequencies
    };
  });
  const averageLength = documents.reduce((total, entry) => total + entry.length, 0) / documents.length;
  const documentFrequency = new Map<string, number>();
  for (const entry of documents) {
    for (const term of new Set(entry.frequencies.keys())) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  return documents
    .map((entry) => ({
      chunk: entry.chunk,
      score: bm25Score(entry.length, averageLength, queryTerms, entry.frequencies, documentFrequency, documents.length)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.chunkIndex - right.chunk.chunkIndex);
}

function bm25Score(
  length: number,
  averageLength: number,
  queryTerms: string[],
  frequencies: Map<string, number>,
  documentFrequency: Map<string, number>,
  totalDocuments: number
) {
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const term of queryTerms) {
    const tf = frequencies.get(term) ?? 0;
    if (tf === 0) {
      continue;
    }
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (totalDocuments - df + 0.5) / (df + 0.5));
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (length / Math.max(averageLength, 1)));
    score += idf * (numerator / denominator);
  }
  return score;
}

function tokenizeBm25(text: string) {
  const normalized = text.toLowerCase();
  const latinTerms = normalized
    .split(/[^a-z0-9_]+/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2);
  const cjkTerms = createCjkBigrams(normalized);
  return [...latinTerms, ...cjkTerms];
}

function createCjkBigrams(text: string) {
  const compact = text.replace(/\s+/g, "");
  const chars = Array.from(compact).filter((char) => /[\u3040-\u30ff\u3400-\u9fff\u3131-\u318e\uac00-\ud7a3]/i.test(char));
  const grams: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    grams.push(`${chars[index]}${chars[index + 1]}`);
  }
  return grams;
}
