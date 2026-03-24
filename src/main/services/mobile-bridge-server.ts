import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AppSettings,
  AutomationCheckpointRecord,
  AutomationSessionControlRequest,
  AutomationSessionCreateRequest,
  AutomationSessionRecord,
  ChatProgressInspection,
  ChatRequest,
  ProjectSnapshot,
  RuntimeAppState,
  ThreadCreateRequest,
  ThreadSelectionRequest
} from "../../shared/types";
import type {
  MobileAutoresearchControlRequest,
  MobileAutoresearchSession,
  MobileAutoresearchStartRequest,
  MobileBootstrap,
  MobileChatRequest,
  MobileMessage,
  MobileResearchStatus,
  MobileThread,
  MobileThreadCreateRequest,
  MobileThreadSelectRequest
} from "../../shared/mobile-types";
import { buildChatItems, formatLiveProgressBody, resolveAutomationCheckpointTone } from "../../renderer/app-utils";

const JSON_BODY_LIMIT_BYTES = 256_000;
const PRIVATE_IPV4_PREFIXES = ["10.", "192.168.", "127."];
const INDEX_FILE_NAME = "index.html";

type MobileBridgeDependencies = {
  staticRoot: string;
  port: number;
  getAppState: () => Promise<RuntimeAppState>;
  getProjectSnapshot: (workspacePath?: string) => Promise<ProjectSnapshot>;
  createThread: (request?: ThreadCreateRequest) => Promise<ProjectSnapshot>;
  selectThread: (request: ThreadSelectionRequest) => Promise<ProjectSnapshot>;
  sendChatMessage: (request: ChatRequest) => Promise<ProjectSnapshot>;
  createAutomationSession: (request: AutomationSessionCreateRequest) => Promise<ProjectSnapshot>;
  startAutomationSession: (request: AutomationSessionControlRequest) => Promise<ProjectSnapshot>;
  pauseAutomationSession: (request: AutomationSessionControlRequest) => Promise<ProjectSnapshot>;
  resumeAutomationSession: (request: AutomationSessionControlRequest) => Promise<ProjectSnapshot>;
  interruptAutomationSession: (request: {
    workspacePath?: string;
    sessionId: string;
    instruction: string;
    stopNow?: boolean;
  }) => Promise<ProjectSnapshot>;
  inspectChatProgress: (request?: { workspacePath?: string }) => Promise<ChatProgressInspection | null>;
  log?: (message: string) => void;
};

export class MobileBridgeServer {
  private readonly staticRoot: string;
  private readonly port: number;
  private readonly log: (message: string) => void;
  private readonly dependencies: Omit<MobileBridgeDependencies, "staticRoot" | "port" | "log">;
  private server: Server | null = null;

  constructor(dependencies: MobileBridgeDependencies) {
    this.staticRoot = dependencies.staticRoot;
    this.port = dependencies.port;
    this.log = dependencies.log ?? (() => undefined);
    this.dependencies = {
      getAppState: dependencies.getAppState,
      getProjectSnapshot: dependencies.getProjectSnapshot,
      createThread: dependencies.createThread,
      selectThread: dependencies.selectThread,
      sendChatMessage: dependencies.sendChatMessage,
      createAutomationSession: dependencies.createAutomationSession,
      startAutomationSession: dependencies.startAutomationSession,
      pauseAutomationSession: dependencies.pauseAutomationSession,
      resumeAutomationSession: dependencies.resumeAutomationSession,
      interruptAutomationSession: dependencies.interruptAutomationSession,
      inspectChatProgress: dependencies.inspectChatProgress
    };
  }

  async start() {
    if (this.server) {
      return;
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.server = server;
    const urls = resolvePrivateNetworkUrls(this.port);
    this.log(`[mobile] listening on ${urls.join(", ")}`);
  }

  async stop() {
    const activeServer = this.server;
    this.server = null;

    if (!activeServer) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    }).catch(() => undefined);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    try {
      if (!isPrivateClientAddress(request.socket.remoteAddress)) {
        this.sendJson(response, 403, {
          error: "Mobile bridge only accepts localhost or private-network clients."
        });
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (url.pathname.startsWith("/api/mobile")) {
        await this.handleApiRequest(request, response, url);
        return;
      }

      await this.serveStaticAsset(response, url.pathname);
    } catch (error) {
      this.log(
        `[mobile] request failed: ${error instanceof Error ? error.message : String(error)}`
      );
      this.sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleApiRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    const method = request.method ?? "GET";
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/api/mobile/bootstrap") {
      this.sendJson(response, 200, await this.buildBootstrap());
      return;
    }

    if (method === "GET" && pathname === "/api/mobile/threads") {
      const snapshot = await this.getCurrentSnapshot();
      this.sendJson(response, 200, buildMobileThreads(snapshot));
      return;
    }

    if (method === "POST" && pathname === "/api/mobile/threads") {
      const body = await this.readJsonBody<MobileThreadCreateRequest>(request);
      const snapshot = await this.dependencies.createThread({
        title: body.title?.trim() || undefined
      });
      this.sendJson(response, 200, await this.buildBootstrap(snapshot));
      return;
    }

    if (method === "POST" && pathname === "/api/mobile/threads/select") {
      const body = await this.readJsonBody<MobileThreadSelectRequest>(request);
      const snapshot = await this.dependencies.selectThread({
        threadId: body.threadId
      });
      this.sendJson(response, 200, await this.buildBootstrap(snapshot));
      return;
    }

    if (method === "POST" && pathname === "/api/mobile/chat") {
      const body = await this.readJsonBody<MobileChatRequest>(request);
      const snapshot = await this.dependencies.sendChatMessage({
        threadId: body.threadId,
        prompt: body.prompt
      });
      this.sendJson(response, 200, await this.buildMobileMessages(snapshot, body.threadId));
      return;
    }

    if (method === "GET" && pathname.startsWith("/api/mobile/threads/") && pathname.endsWith("/messages")) {
      const threadId = decodeURIComponent(
        pathname.slice("/api/mobile/threads/".length, -"/messages".length)
      );
      const snapshot = await this.getCurrentSnapshot();
      this.sendJson(response, 200, await this.buildMobileMessages(snapshot, threadId));
      return;
    }

    if (method === "GET" && pathname === "/api/mobile/autoresearch") {
      const snapshot = await this.getCurrentSnapshot();
      this.sendJson(response, 200, buildMobileAutoresearch(snapshot));
      return;
    }

    if (method === "POST" && pathname === "/api/mobile/autoresearch/start") {
      const body = await this.readJsonBody<MobileAutoresearchStartRequest>(request);
      const created = await this.dependencies.createAutomationSession({
        threadId: body.threadId,
        objective: body.objective,
        mode: "continuous",
        maxSteps: 64,
        maxRuntimeMinutes: 24 * 60,
        maxRetries: 8,
        paperWriteEnabled: false
      });
      const sessionId = created.latestAutomationSession?.id;

      if (!sessionId) {
        throw new Error("Autoresearch session could not be created.");
      }

      const snapshot = await this.dependencies.startAutomationSession({
        sessionId
      });
      this.sendJson(response, 200, await this.buildBootstrap(snapshot));
      return;
    }

    if (method === "POST" && pathname === "/api/mobile/autoresearch/pause") {
      const body = await this.readJsonBody<MobileAutoresearchControlRequest>(request);
      const snapshot = await this.dependencies.pauseAutomationSession({
        sessionId: body.sessionId
      });
      this.sendJson(response, 200, await this.buildBootstrap(snapshot));
      return;
    }

    if (method === "POST" && pathname === "/api/mobile/autoresearch/resume") {
      const body = await this.readJsonBody<MobileAutoresearchControlRequest>(request);
      const snapshot = await this.dependencies.resumeAutomationSession({
        sessionId: body.sessionId
      });
      this.sendJson(response, 200, await this.buildBootstrap(snapshot));
      return;
    }

    if (method === "POST" && pathname === "/api/mobile/autoresearch/interrupt") {
      const body = await this.readJsonBody<MobileAutoresearchControlRequest>(request);
      const snapshot = await this.dependencies.interruptAutomationSession({
        sessionId: body.sessionId,
        instruction: "Stop automation and wait for further user direction.",
        stopNow: true
      });
      this.sendJson(response, 200, await this.buildBootstrap(snapshot));
      return;
    }

    if (method === "POST" && pathname === "/api/mobile/autoresearch/refresh") {
      this.sendJson(response, 200, await this.buildBootstrap());
      return;
    }

    this.sendJson(response, 404, {
      error: `Unknown mobile bridge route: ${method} ${pathname}`
    });
  }

  private async buildBootstrap(snapshotOverride?: ProjectSnapshot): Promise<MobileBootstrap> {
    const appState = await this.dependencies.getAppState();
    const snapshot =
      snapshotOverride ?? (await this.dependencies.getProjectSnapshot(appState.selectedWorkspacePath || undefined));
    const selectedThreadId = snapshot.activeThreadId ?? snapshot.threads[0]?.id ?? null;

    return {
      appName: "Lithium Mobile",
      connected: true,
      serverTime: new Date().toISOString(),
      selectedWorkspacePath: appState.selectedWorkspacePath,
      selectedThreadId,
      threads: buildMobileThreads(snapshot),
      messages: await this.buildMobileMessages(snapshot, selectedThreadId),
      autoresearch: buildMobileAutoresearch(snapshot)
    };
  }

  private async buildMobileMessages(
    snapshot: ProjectSnapshot,
    threadId: string | null | undefined
  ): Promise<MobileMessage[]> {
    if (!threadId) {
      return [];
    }

    const filteredSnapshot: ProjectSnapshot = {
      ...snapshot,
      activeThreadId: threadId
    };
    const items = buildChatItems(filteredSnapshot, []);
    const messages = items.map<MobileMessage>((item) => ({
      id: item.id,
      role: item.role === "system" ? "assistant" : item.role,
      content: item.body,
      createdAt: item.timestamp,
      status: item.pending ? "streaming" : "done"
    }));
    const chatProgress = await this.dependencies.inspectChatProgress({
      workspacePath: snapshot.project?.workspacePath
    });
    const progressBody = formatLiveProgressBody(chatProgress);
    const lastMessage = messages.at(-1)?.content.trim();

    if (chatProgress?.active && progressBody && progressBody.trim() !== lastMessage) {
      messages.push({
        id: `progress:${chatProgress.updatedAt}`,
        role: "assistant",
        content: progressBody,
        createdAt: chatProgress.updatedAt,
        status: "streaming"
      });
    }

    return messages;
  }

  private async getCurrentSnapshot() {
    const appState = await this.dependencies.getAppState();
    return await this.dependencies.getProjectSnapshot(appState.selectedWorkspacePath || undefined);
  }

  private async readJsonBody<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;

      if (totalBytes > JSON_BODY_LIMIT_BYTES) {
        throw new Error("Request body is too large.");
      }

      chunks.push(buffer);
    }

    const raw = Buffer.concat(chunks).toString("utf8").trim();

    if (!raw) {
      return {} as T;
    }

    return JSON.parse(raw) as T;
  }

  private async serveStaticAsset(response: ServerResponse, pathname: string) {
    const hasAssetExtension = Boolean(path.extname(pathname));
    const relativePath =
      pathname === "/" || !hasAssetExtension
        ? INDEX_FILE_NAME
        : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(this.staticRoot, relativePath);

    if (!filePath.startsWith(path.resolve(this.staticRoot))) {
      this.sendText(response, 403, "Forbidden");
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": contentTypeForPath(filePath),
        "cache-control": hasAssetExtension ? "public, max-age=3600" : "no-cache"
      });
      response.end(body);
      return;
    } catch {
      if (hasAssetExtension) {
        this.sendText(response, 404, "Not found");
        return;
      }
    }

    this.sendText(
      response,
      503,
      "Lithium mobile UI is not built yet. Run `npm run build:mobile` first."
    );
  }

  private sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify(payload));
  }

  private sendText(response: ServerResponse, statusCode: number, body: string) {
    response.writeHead(statusCode, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(body);
  }
}

function buildMobileThreads(snapshot: ProjectSnapshot): MobileThread[] {
  return [...snapshot.threads]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      lastActivityAt: thread.updatedAt,
      unreadCount: 0
    }));
}

function buildMobileAutoresearch(snapshot: ProjectSnapshot): MobileAutoresearchSession | null {
  const activeThreadId = snapshot.activeThreadId ?? snapshot.threads[0]?.id ?? null;
  const session =
    snapshot.latestAutomationSession && snapshot.latestAutomationSession.threadId === activeThreadId
      ? snapshot.latestAutomationSession
      : null;
  const checkpoint =
    snapshot.latestAutomationCheckpoint && snapshot.latestAutomationCheckpoint.threadId === activeThreadId
      ? snapshot.latestAutomationCheckpoint
      : null;

  if (!session) {
    return null;
  }

  return {
    id: session.id,
    objective: session.objective,
    status: deriveMobileAutoresearchStatus(session, checkpoint),
    currentStep: checkpoint?.summary?.trim() || session.currentStepSummary,
    lastUpdate: checkpoint?.updatedAt || session.updatedAt,
    nextActions: checkpoint?.nextActions ?? [],
    threadId: session.threadId,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt
  };
}

function deriveMobileAutoresearchStatus(
  session: AutomationSessionRecord,
  checkpoint: AutomationCheckpointRecord | null
): MobileResearchStatus {
  const checkpointPending = Boolean(
    checkpoint &&
      session.latestCheckpointId === checkpoint.id &&
      checkpoint.status === "pending"
  );

  if (session.status === "running") {
    return "running";
  }

  if (checkpointPending && checkpoint) {
    const tone = resolveAutomationCheckpointTone(checkpoint, session);

    if (tone === "blocked") {
      return "blocked";
    }

    if (tone === "failed") {
      return "failed";
    }

    return "paused";
  }

  if (session.endedAt && /completed|finished|done/i.test(session.currentStepSummary)) {
    return "completed";
  }

  return "idle";
}

function contentTypeForPath(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function resolvePrivateNetworkUrls(port: number) {
  const urls = new Set<string>([`http://127.0.0.1:${port}`]);
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4" || !isPrivateClientAddress(entry.address)) {
        continue;
      }

      urls.add(`http://${entry.address}:${port}`);
    }
  }

  return [...urls];
}

function isPrivateClientAddress(value: string | undefined | null) {
  if (!value) {
    return false;
  }

  const normalized = normalizeRemoteAddress(value);

  if (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }

  if (normalized.startsWith("fe80:")) {
    return true;
  }

  if (PRIVATE_IPV4_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }

  const parts = normalized.split(".");

  if (parts.length === 4 && parts[0] === "172") {
    const second = Number(parts[1]);
    return Number.isFinite(second) && second >= 16 && second <= 31;
  }

  return false;
}

function normalizeRemoteAddress(value: string) {
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}
