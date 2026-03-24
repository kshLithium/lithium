import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import type {
  AppSettings,
  AutomationCheckpointApprovalRequest,
  AutomationInterruptRequest,
  AutomationSessionControlRequest,
  AutomationSessionCreateRequest,
  ChatProgressInspection,
  ChatRequest,
  MobileWebRuntimeStatus,
  ProjectSnapshot,
  RuntimeAppState,
  ThreadCreateRequest,
  ThreadSelectionRequest
} from "../../shared/types";
import { buildChatItems } from "../../renderer/app-utils";

const MOBILE_COOKIE_NAME = "lithium_mobile_token";
const DEFAULT_HOST = process.env.LITHIUM_MOBILE_HOST?.trim() || "0.0.0.0";
const DEFAULT_PORT = Number.parseInt(process.env.LITHIUM_MOBILE_PORT || "8787", 10) || 8787;

type MobileThread = {
  id: string;
  title: string;
  lastActivityAt?: string;
  unreadCount?: number;
};

type MobileMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  status?: "sending" | "streaming" | "done" | "error";
};

type MobileResearchStatus = "idle" | "running" | "paused" | "blocked" | "failed" | "completed";

type MobileAutoresearchSession = {
  id: string;
  objective: string;
  status: MobileResearchStatus;
  currentStep?: string;
  lastUpdate?: string;
  nextActions: string[];
  threadId?: string;
  startedAt?: string;
  updatedAt?: string;
};

type MobileBootstrap = {
  appName: string;
  connected: boolean;
  serverTime: string;
  selectedWorkspacePath: string;
  selectedThreadId: string | null;
  threads: MobileThread[];
  messages: MobileMessage[];
  autoresearch: MobileAutoresearchSession | null;
  chatProgress: ChatProgressInspection | null;
};

export type MobileWebBridge = {
  getAppState: () => Promise<RuntimeAppState>;
  getAppSettings: () => Promise<AppSettings>;
  getSnapshot: (workspacePath?: string) => Promise<ProjectSnapshot>;
  createThread: (request?: ThreadCreateRequest) => Promise<ProjectSnapshot>;
  selectThread: (request: ThreadSelectionRequest) => Promise<ProjectSnapshot>;
  sendChatMessage: (
    request: ChatRequest,
    options?: {
      strategistSessionReady?: boolean;
    }
  ) => Promise<ProjectSnapshot>;
  inspectChatProgress: (request?: { workspacePath?: string }) => Promise<ChatProgressInspection | null>;
  createAutomationSession: (request: AutomationSessionCreateRequest) => Promise<ProjectSnapshot>;
  startAutomationSession: (request: AutomationSessionControlRequest) => Promise<ProjectSnapshot>;
  pauseAutomationSession: (request: AutomationSessionControlRequest) => Promise<ProjectSnapshot>;
  resumeAutomationSession: (request: AutomationSessionControlRequest) => Promise<ProjectSnapshot>;
  interruptAutomationSession: (request: AutomationInterruptRequest) => Promise<ProjectSnapshot>;
  approveAutomationCheckpoint: (request: AutomationCheckpointApprovalRequest) => Promise<ProjectSnapshot>;
};

type MobileWebServerDependencies = {
  appName: string;
  bridge: MobileWebBridge;
  staticRoot: string;
  host?: string;
  port?: number;
  log?: (message: string) => void;
};

type RequestContext = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
};

const INITIAL_STATUS: MobileWebRuntimeStatus = {
  state: "starting",
  host: DEFAULT_HOST,
  port: null,
  authToken: "",
  localUrl: "",
  networkUrl: "",
  staticReady: false,
  lastError: null
};

export class MobileWebServer {
  private readonly appName: string;
  private readonly bridge: MobileWebBridge;
  private readonly staticRoot: string;
  private readonly host: string;
  private readonly preferredPort: number;
  private readonly log: (message: string) => void;
  private readonly authToken: string;
  private server: Server | null = null;
  private status: MobileWebRuntimeStatus = INITIAL_STATUS;

  constructor(dependencies: MobileWebServerDependencies) {
    this.appName = dependencies.appName;
    this.bridge = dependencies.bridge;
    this.staticRoot = dependencies.staticRoot;
    this.host = dependencies.host?.trim() || DEFAULT_HOST;
    this.preferredPort = dependencies.port ?? DEFAULT_PORT;
    this.log = dependencies.log ?? (() => undefined);
    this.authToken = randomBytes(18).toString("hex");
    this.status = {
      ...INITIAL_STATUS,
      host: this.host,
      authToken: this.authToken
    };
  }

  getStatus(): MobileWebRuntimeStatus {
    return { ...this.status };
  }

  async start() {
    if (this.server) {
      return;
    }

    this.status = {
      ...this.status,
      state: "starting",
      lastError: null,
      staticReady: await this.hasStaticClient()
    };

    const server = createServer((request, response) => {
      void this.handleRequest({ request, response, url: toRequestUrl(request) }).catch((error) => {
        this.respondJson(
          response,
          500,
          {
            error: error instanceof Error ? error.message : String(error)
          },
          {
            cache: false
          }
        );
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.preferredPort, this.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.status = {
        ...this.status,
        state: "error",
        lastError: error instanceof Error ? error.message : String(error)
      };
      throw error;
    }

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    const urls = resolveAccessUrls(port, this.authToken);

    this.server = server;
    this.status = {
      ...this.status,
      state: "running",
      port,
      localUrl: urls.localUrl,
      networkUrl: urls.networkUrl
    };

    this.log(`[mobile] listening on ${urls.localUrl}${urls.networkUrl ? ` (${urls.networkUrl})` : ""}`);
  }

  async stop() {
    if (!this.server) {
      return;
    }

    const activeServer = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.status = {
      ...this.status,
      state: "disabled",
      lastError: null
    };
  }

  private async handleRequest(context: RequestContext) {
    if (context.url.pathname.startsWith("/api/mobile")) {
      await this.handleApiRequest(context);
      return;
    }

    if (!this.authorize(context)) {
      this.respondHtml(context.response, 401, renderAuthGate(this.status));
      return;
    }

    await this.handleStaticRequest(context);
  }

  private async handleApiRequest(context: RequestContext) {
    if (!this.authorize(context)) {
      this.respondJson(
        context.response,
        401,
        {
          error: "Mobile access token is missing or invalid."
        },
        {
          cache: false
        }
      );
      return;
    }

    const { pathname } = context.url;

    if (pathname === "/api/mobile/status" && context.request.method === "GET") {
      this.respondJson(context.response, 200, this.status, { cache: false });
      return;
    }

    if (pathname === "/api/mobile/bootstrap" && context.request.method === "GET") {
      this.respondJson(
        context.response,
        200,
        await this.buildBootstrap(readWorkspacePathParam(context.url)),
        { cache: false }
      );
      return;
    }

    if (pathname === "/api/mobile/threads" && context.request.method === "GET") {
      const snapshot = await this.bridge.getSnapshot(readWorkspacePathParam(context.url));
      this.respondJson(context.response, 200, mapThreads(snapshot), { cache: false });
      return;
    }

    if (pathname === "/api/mobile/threads" && context.request.method === "POST") {
      const body = await readJsonBody<{ title?: string; workspacePath?: string }>(context.request);
      const snapshot = await this.bridge.createThread({
        title: typeof body.title === "string" ? body.title : undefined,
        workspacePath: typeof body.workspacePath === "string" ? body.workspacePath : undefined
      });
      this.respondJson(context.response, 200, await this.buildBootstrap(snapshot.project?.workspacePath), {
        cache: false
      });
      return;
    }

    if (pathname === "/api/mobile/threads/select" && context.request.method === "POST") {
      const body = await readJsonBody<{ threadId?: string; workspacePath?: string }>(context.request);
      const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";

      if (!threadId) {
        throw new Error("threadId is required.");
      }

      const snapshot = await this.bridge.selectThread({
        threadId,
        workspacePath: typeof body.workspacePath === "string" ? body.workspacePath : undefined
      });
      this.respondJson(context.response, 200, await this.buildBootstrap(snapshot.project?.workspacePath), {
        cache: false
      });
      return;
    }

    if (pathname.match(/^\/api\/mobile\/threads\/[^/]+\/messages$/) && context.request.method === "GET") {
      const threadId = decodeURIComponent(pathname.split("/")[4] || "").trim();

      if (!threadId) {
        throw new Error("threadId is required.");
      }

      const snapshot = await this.bridge.selectThread({
        threadId,
        workspacePath: readWorkspacePathParam(context.url)
      });
      this.respondJson(context.response, 200, mapMessages(snapshot), { cache: false });
      return;
    }

    if (pathname === "/api/mobile/chat" && context.request.method === "POST") {
      const body = await readJsonBody<{ prompt?: string; threadId?: string; workspacePath?: string }>(
        context.request
      );
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

      if (!prompt) {
        throw new Error("prompt is required.");
      }

      const settings = await this.bridge.getAppSettings();
      const snapshot = await this.bridge.sendChatMessage(
        {
          prompt,
          threadId: typeof body.threadId === "string" ? body.threadId : undefined,
          workspacePath: typeof body.workspacePath === "string" ? body.workspacePath : undefined
        },
        {
          strategistSessionReady: settings.strategistSessionReady
        }
      );
      this.respondJson(context.response, 200, mapMessages(snapshot), { cache: false });
      return;
    }

    if (pathname === "/api/mobile/chat-progress" && context.request.method === "GET") {
      const inspection = await this.bridge.inspectChatProgress({
        workspacePath: readWorkspacePathParam(context.url)
      });
      this.respondJson(context.response, 200, inspection, { cache: false });
      return;
    }

    if (pathname === "/api/mobile/autoresearch" && context.request.method === "GET") {
      const snapshot = await this.bridge.getSnapshot(readWorkspacePathParam(context.url));
      this.respondJson(context.response, 200, mapAutoresearch(snapshot), { cache: false });
      return;
    }

    if (pathname === "/api/mobile/autoresearch/start" && context.request.method === "POST") {
      const body = await readJsonBody<{ objective?: string; threadId?: string; workspacePath?: string }>(
        context.request
      );
      const objective = typeof body.objective === "string" ? body.objective.trim() : "";

      if (!objective) {
        throw new Error("objective is required.");
      }

      const createdSnapshot = await this.bridge.createAutomationSession({
        objective,
        threadId: typeof body.threadId === "string" ? body.threadId : undefined,
        workspacePath: typeof body.workspacePath === "string" ? body.workspacePath : undefined,
        mode: "continuous",
        maxSteps: 64,
        maxRuntimeMinutes: 24 * 60,
        maxRetries: 8,
        paperWriteEnabled: false
      });
      const sessionId = createdSnapshot.latestAutomationSession?.id;

      if (!sessionId) {
        throw new Error("Automation session could not be created.");
      }

      const snapshot = await this.bridge.startAutomationSession({
        sessionId,
        workspacePath: createdSnapshot.project?.workspacePath || body.workspacePath
      });
      this.respondJson(context.response, 200, await this.buildBootstrap(snapshot.project?.workspacePath), {
        cache: false
      });
      return;
    }

    if (pathname === "/api/mobile/autoresearch/pause" && context.request.method === "POST") {
      const body = await readJsonBody<{ sessionId?: string; workspacePath?: string }>(context.request);
      const snapshot = await this.bridge.pauseAutomationSession({
        sessionId: requireSessionId(body.sessionId),
        workspacePath: typeof body.workspacePath === "string" ? body.workspacePath : undefined
      });
      this.respondJson(context.response, 200, await this.buildBootstrap(snapshot.project?.workspacePath), {
        cache: false
      });
      return;
    }

    if (pathname === "/api/mobile/autoresearch/resume" && context.request.method === "POST") {
      const body = await readJsonBody<{ sessionId?: string; workspacePath?: string }>(context.request);
      const snapshot = await this.resumeAutoresearch({
        sessionId: requireSessionId(body.sessionId),
        workspacePath: typeof body.workspacePath === "string" ? body.workspacePath : undefined
      });
      this.respondJson(context.response, 200, await this.buildBootstrap(snapshot.project?.workspacePath), {
        cache: false
      });
      return;
    }

    if (pathname === "/api/mobile/autoresearch/interrupt" && context.request.method === "POST") {
      const body = await readJsonBody<{ sessionId?: string; workspacePath?: string }>(context.request);
      const snapshot = await this.bridge.interruptAutomationSession({
        sessionId: requireSessionId(body.sessionId),
        workspacePath: typeof body.workspacePath === "string" ? body.workspacePath : undefined,
        instruction: "Stop automation and wait for further user direction.",
        stopNow: true
      });
      this.respondJson(context.response, 200, await this.buildBootstrap(snapshot.project?.workspacePath), {
        cache: false
      });
      return;
    }

    if (pathname === "/api/mobile/autoresearch/refresh" && context.request.method === "POST") {
      const body = await readJsonBody<{ workspacePath?: string }>(context.request);
      this.respondJson(
        context.response,
        200,
        await this.buildBootstrap(typeof body.workspacePath === "string" ? body.workspacePath : undefined),
        {
          cache: false
        }
      );
      return;
    }

    this.respondJson(
      context.response,
      404,
      {
        error: "Mobile endpoint not found."
      },
      {
        cache: false
      }
    );
  }

  private async resumeAutoresearch(request: AutomationSessionControlRequest) {
    const snapshot = await this.bridge.getSnapshot(request.workspacePath);
    const session =
      (snapshot.automationSessions ?? []).find((entry) => entry.id === request.sessionId) ?? null;
    const checkpoint =
      (snapshot.automationCheckpoints ?? []).find(
        (entry) => entry.id === session?.latestCheckpointId && entry.status === "pending"
      ) ?? null;

    if (checkpoint) {
      return await this.bridge.approveAutomationCheckpoint({
        sessionId: request.sessionId,
        checkpointId: checkpoint.id,
        workspacePath: request.workspacePath
      });
    }

    return await this.bridge.resumeAutomationSession(request);
  }

  private authorize(context: RequestContext) {
    const queryToken = context.url.searchParams.get("token")?.trim() || "";
    const headerToken = readHeaderToken(context.request);
    const cookieToken = readCookieToken(context.request);

    if (queryToken === this.authToken) {
      this.setAuthCookie(context.response);
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

  private async handleStaticRequest(context: RequestContext) {
    const requestedPath = normalizeStaticPath(context.url.pathname);
    const resolvedPath = path.join(this.staticRoot, requestedPath);

    if (!(await isSafeStaticPath(this.staticRoot, resolvedPath))) {
      this.respondJson(
        context.response,
        404,
        {
          error: "Not found."
        },
        {
          cache: false
        }
      );
      return;
    }

    const filePath =
      requestedPath === "" || requestedPath === "index.html"
        ? path.join(this.staticRoot, "index.html")
        : resolvedPath;
    const fallbackToIndex = requestedPath === "" || !path.extname(requestedPath);

    try {
      const body = await readFile(filePath);
      this.respondBinary(context.response, 200, body, contentTypeForPath(filePath));
    } catch {
      if (fallbackToIndex) {
        try {
          const indexPath = path.join(this.staticRoot, "index.html");
          const body = await readFile(indexPath);
          this.respondBinary(context.response, 200, body, "text/html; charset=utf-8");
          return;
        } catch {
          this.respondHtml(context.response, 503, renderMissingClient(this.status));
          return;
        }
      }

      this.respondJson(
        context.response,
        404,
        {
          error: "Static file not found."
        },
        {
          cache: false
        }
      );
    }
  }

  private async buildBootstrap(workspacePath?: string): Promise<MobileBootstrap> {
    const [appState, snapshot, chatProgress] = await Promise.all([
      this.bridge.getAppState(),
      this.bridge.getSnapshot(workspacePath),
      this.bridge.inspectChatProgress({ workspacePath })
    ]);

    const resolvedWorkspacePath =
      snapshot.project?.workspacePath || appState.selectedWorkspacePath || workspacePath || "";

    return {
      appName: this.appName,
      connected: Boolean(resolvedWorkspacePath),
      serverTime: new Date().toISOString(),
      selectedWorkspacePath: resolvedWorkspacePath,
      selectedThreadId: snapshot.activeThreadId,
      threads: mapThreads(snapshot),
      messages: mapMessages(snapshot),
      autoresearch: mapAutoresearch(snapshot),
      chatProgress
    };
  }

  private respondJson(
    response: ServerResponse,
    statusCode: number,
    payload: unknown,
    options: {
      cache?: boolean;
    } = {}
  ) {
    const body = JSON.stringify(payload, null, 2);
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": options.cache === false ? "no-store" : "private, max-age=0, must-revalidate"
    });
    response.end(body);
  }

  private respondHtml(response: ServerResponse, statusCode: number, body: string) {
    response.writeHead(statusCode, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(body);
  }

  private respondBinary(
    response: ServerResponse,
    statusCode: number,
    body: Buffer,
    contentType: string
  ) {
    response.writeHead(statusCode, {
      "content-type": contentType,
      "cache-control": "private, max-age=0, must-revalidate"
    });
    response.end(body);
  }

  private async hasStaticClient() {
    try {
      await stat(path.join(this.staticRoot, "index.html"));
      return true;
    } catch {
      return false;
    }
  }
}

function mapThreads(snapshot: ProjectSnapshot): MobileThread[] {
  return snapshot.threads.map((thread) => ({
    id: thread.id,
    title: thread.title,
    lastActivityAt: thread.updatedAt,
    unreadCount: 0
  }));
}

function mapMessages(snapshot: ProjectSnapshot): MobileMessage[] {
  return buildChatItems(snapshot, []).map((item) => ({
    id: item.id,
    role: item.role === "system" ? "system" : item.role,
    content: item.body,
    createdAt: item.timestamp,
    status: item.pending ? "streaming" : "done"
  }));
}

function mapAutoresearch(snapshot: ProjectSnapshot): MobileAutoresearchSession | null {
  const activeThreadId = snapshot.activeThreadId ?? null;
  const sessions = (snapshot.automationSessions ?? [])
    .filter((session) => !activeThreadId || session.threadId === activeThreadId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const session = sessions[0] ?? snapshot.latestAutomationSession ?? null;

  if (!session) {
    return null;
  }

  const checkpoint =
    (snapshot.automationCheckpoints ?? [])
      .filter((entry) => entry.sessionId === session.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const latestStep =
    (snapshot.automationSteps ?? [])
      .filter((entry) => entry.sessionId === session.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;

  let status: MobileResearchStatus = session.status === "running" ? "running" : "idle";

  if (session.status === "idle" && checkpoint?.status === "pending") {
    status = isBlockedCheckpoint(checkpoint, session) ? "blocked" : "paused";
  } else if (
    session.status === "idle" &&
    (latestStep?.status === "failed" || /failed|issue|blocked/i.test(session.stopReason ?? ""))
  ) {
    status = "failed";
  } else if (session.status === "idle" && session.endedAt) {
    status = "completed";
  }

  return {
    id: session.id,
    objective: session.displayObjective?.trim() || session.objective,
    status,
    currentStep: humanizeAutoresearchStatusCopy(session.currentStepSummary),
    lastUpdate:
      humanizeAutoresearchStatusCopy(
        session.status === "running" ? session.currentStepSummary : checkpoint?.summary || session.currentStepSummary
      ),
    nextActions: session.status === "running" ? [] : checkpoint?.nextActions ?? [],
    threadId: session.threadId,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt
  };
}

function humanizeAutoresearchStatusCopy(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (/plan the next bounded research step/i.test(trimmed)) {
    return "다음 연구 단계를 작게 쪼개서 정리하고 있습니다.";
  }

  if (/let codex choose and execute the next bounded step/i.test(trimmed)) {
    return "다음으로 검증할 실험이나 구현 단계를 고르고 있습니다.";
  }

  if (/automation started\. planning the next bounded step/i.test(trimmed)) {
    return "자동 연구를 시작했고, 바로 다음 단계를 정리하고 있습니다.";
  }

  if (/automation resumed/i.test(trimmed)) {
    return "이전 상태에서 자동 연구를 다시 이어가고 있습니다.";
  }

  if (/continuing the current step\. the latest instruction will be applied next/i.test(trimmed)) {
    return "현재 단계는 마저 끝내고, 방금 보낸 지시는 다음 단계부터 반영합니다.";
  }

  if (/^recovering after\b/i.test(trimmed)) {
    return "직전 단계 이후 복구 경로를 진행하고 있습니다.";
  }

  if (/^continuing after\b/i.test(trimmed)) {
    return "방금 끝난 단계에 이어 다음 작업을 진행하고 있습니다.";
  }

  return trimmed;
}

function isBlockedCheckpoint(
  checkpoint: NonNullable<ProjectSnapshot["automationCheckpoints"]>[number],
  session: NonNullable<ProjectSnapshot["automationSessions"]>[number]
) {
  const haystack = [
    checkpoint.title,
    checkpoint.summary,
    ...checkpoint.risks,
    ...checkpoint.nextActions,
    session.stopReason ?? ""
  ]
    .join("\n")
    .toLowerCase();

  return /automation blocked|chatgpt session expired|chrome window closed before oracle finished|saved chatgpt session expired/.test(
    haystack
  );
}

function requireSessionId(value: string | undefined) {
  const sessionId = value?.trim() || "";

  if (!sessionId) {
    throw new Error("sessionId is required.");
  }

  return sessionId;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (!raw) {
    return {} as T;
  }

  return JSON.parse(raw) as T;
}

function toRequestUrl(request: IncomingMessage) {
  return new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
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

function readWorkspacePathParam(url: URL) {
  const value = url.searchParams.get("workspacePath")?.trim();
  return value || undefined;
}

function normalizeStaticPath(pathname: string) {
  return pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
}

async function isSafeStaticPath(root: string, filePath: string) {
  const normalizedRoot = path.resolve(root);
  const normalizedFile = path.resolve(filePath);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}${path.sep}`);
}

function resolveAccessUrls(port: number | null, authToken: string) {
  if (!port) {
    return {
      localUrl: "",
      networkUrl: ""
    };
  }

  const localUrl = `http://127.0.0.1:${port}/?token=${authToken}`;
  const interfaces = networkInterfaces();
  let networkUrl = "";

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }

      networkUrl = `http://${entry.address}:${port}/?token=${authToken}`;
      break;
    }

    if (networkUrl) {
      break;
    }
  }

  return {
    localUrl,
    networkUrl
  };
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

function renderAuthGate(status: MobileWebRuntimeStatus) {
  const hint = status.networkUrl || status.localUrl || "http://127.0.0.1:8787/?token=...";

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
      <p>Open the mobile URL that includes the access token from the desktop app or terminal log.</p>
      <code>${escapeHtml(hint)}</code>
    </main>
  </body>
</html>`;
}

function renderMissingClient(status: MobileWebRuntimeStatus) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Lithium Mobile</title>
  </head>
  <body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#081220;color:#eef5ff;font-family:'IBM Plex Sans','Helvetica Neue',sans-serif;">
    <main style="width:min(92vw,540px);padding:24px;border-radius:24px;background:rgba(10,19,34,.92);border:1px solid rgba(157,181,216,.18);">
      <h1 style="margin:0 0 12px;font-size:28px;">Mobile client missing</h1>
      <p style="margin:0 0 12px;line-height:1.6;color:rgba(230,239,255,.76);">Build the mobile client with <code>npm run build:mobile</code>, then reload this page.</p>
      <p style="margin:0;color:rgba(230,239,255,.76);">Current URL: <code>${escapeHtml(status.networkUrl || status.localUrl)}</code></p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
