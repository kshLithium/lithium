import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
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
const MOBILE_COOKIE_NAME = "lithium_mobile_token";
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
  private readonly authToken: string;
  private readonly dependencies: Omit<MobileBridgeDependencies, "staticRoot" | "port" | "log">;
  private server: Server | null = null;
  private boundPort: number | null = null;

  constructor(dependencies: MobileBridgeDependencies) {
    this.staticRoot = dependencies.staticRoot;
    this.port = dependencies.port;
    this.log = dependencies.log ?? (() => undefined);
    this.authToken = randomBytes(18).toString("hex");
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
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : this.port;
    const urls = resolvePrivateNetworkUrls(this.boundPort, this.authToken);
    this.log(`[mobile] listening on ${urls.join(", ")}`);
  }

  async stop() {
    const activeServer = this.server;
    this.server = null;
    this.boundPort = null;

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
        if (!this.authorize(request, response, url)) {
          this.sendJson(response, 401, {
            error: "Missing or invalid mobile access token."
          });
          return;
        }

        await this.handleApiRequest(request, response, url);
        return;
      }

      if (!this.authorize(request, response, url)) {
        this.sendHtml(response, 401, renderAuthGate(this.boundPort ?? this.port));
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

  private authorize(request: IncomingMessage, response: ServerResponse, url: URL) {
    const queryToken = url.searchParams.get("token")?.trim() || "";
    const headerToken = readHeaderToken(request);
    const cookieToken = readCookieToken(request);

    if (queryToken === this.authToken) {
      this.setAuthCookie(response);
      return true;
    }

    return headerToken === this.authToken || cookieToken === this.authToken;
  }

  private setAuthCookie(response: ServerResponse) {
    response.setHeader(
      "Set-Cookie",
      `${MOBILE_COOKIE_NAME}=${this.authToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
    );
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
    const requestedPath =
      pathname === "/" || !hasAssetExtension
        ? INDEX_FILE_NAME
        : normalizeStaticPath(pathname);
    const filePath = path.resolve(this.staticRoot, requestedPath);

    if (!isSafeStaticPath(this.staticRoot, filePath)) {
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

  private sendHtml(response: ServerResponse, statusCode: number, body: string) {
    response.writeHead(statusCode, {
      "content-type": "text/html; charset=utf-8",
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

function resolvePrivateNetworkUrls(port: number, authToken?: string) {
  const suffix = authToken ? `/?token=${authToken}` : "";
  const urls = new Set<string>([`http://127.0.0.1:${port}${suffix}`]);
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4" || !isPrivateClientAddress(entry.address)) {
        continue;
      }

      urls.add(`http://${entry.address}:${port}${suffix}`);
    }
  }

  return [...urls];
}

function readHeaderToken(request: IncomingMessage) {
  const value = request.headers["x-lithium-mobile-token"];
  return typeof value === "string" ? value.trim() : "";
}

function readCookieToken(request: IncomingMessage) {
  const cookieHeader = request.headers.cookie || "";
  const cookies = cookieHeader.split(";").map((entry) => entry.trim());
  const tokenEntry = cookies.find((entry) => entry.startsWith(`${MOBILE_COOKIE_NAME}=`));

  if (!tokenEntry) {
    return "";
  }

  return tokenEntry.slice(MOBILE_COOKIE_NAME.length + 1).trim();
}

function normalizeStaticPath(pathname: string) {
  return pathname.replace(/^\/+/, "");
}

export function isSafeStaticPath(root: string, filePath: string) {
  const normalizedRoot = path.resolve(root);
  const normalizedFile = path.resolve(filePath);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}${path.sep}`);
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

function renderAuthGate(port: number) {
  const hint = resolvePrivateNetworkUrls(port)
    .map((entry) => `${entry}?token=...`)
    .join(" or ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Lithium Mobile</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: linear-gradient(180deg, #06101d, #0a1626);
        color: #eef5ff;
        font-family: "IBM Plex Sans", "Helvetica Neue", sans-serif;
      }
      main {
        width: min(92vw, 540px);
        padding: 24px;
        border-radius: 24px;
        background: rgba(10, 19, 34, 0.92);
        border: 1px solid rgba(157, 181, 216, 0.18);
      }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { margin: 0 0 12px; line-height: 1.6; color: rgba(230, 239, 255, 0.76); }
      code {
        display: block;
        margin-top: 16px;
        padding: 14px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.04);
        word-break: break-all;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Lithium Mobile</h1>
      <p>Open the exact mobile URL from the desktop log so the access token can be stored for this browser session.</p>
      <code>${escapeHtml(hint)}</code>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
