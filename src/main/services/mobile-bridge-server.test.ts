import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_APP_SETTINGS, type ProjectSnapshot, type RuntimeAppState } from "../../shared/types";
import { MobileBridgeServer, isSafeStaticPath } from "./mobile-bridge-server";

const tempDirs: string[] = [];
const activeServers: MobileBridgeServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.stop()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("mobile-bridge-server", () => {
  it("requires a valid token before serving the mobile UI or API", async () => {
    const staticRoot = await createStaticRoot();
    const workspacePath = "/tmp/lithium-mobile";
    const server = new MobileBridgeServer({
      staticRoot,
      port: 0,
      getAppState: async () => createRuntimeState(workspacePath),
      getProjectSnapshot: async () => createSnapshot(),
      createThread: async () => createSnapshot(),
      selectThread: async () => createSnapshot(),
      sendChatMessage: async () => createSnapshot(),
      createAutomationSession: async () => createSnapshot(),
      startAutomationSession: async () => createSnapshot(),
      pauseAutomationSession: async () => createSnapshot(),
      resumeAutomationSession: async () => createSnapshot(),
      interruptAutomationSession: async () => createSnapshot(),
      inspectChatProgress: async () => null
    });
    activeServers.push(server);

    await server.start();
    const port = getServerPort(server);
    const authToken = (server as any).authToken as string;

    const unauthorizedApi = await requestText(port, "/api/mobile/bootstrap");
    expect(unauthorizedApi.statusCode).toBe(401);
    expect(unauthorizedApi.body).toContain("Missing or invalid mobile access token");

    const authorizedPage = await requestText(port, `/?token=${authToken}`);
    const cookieHeader = authorizedPage.headers["set-cookie"]?.[0];

    expect(authorizedPage.statusCode).toBe(200);
    expect(cookieHeader).toContain("lithium_mobile_token=");

    const authorizedApi = await requestText(port, "/api/mobile/bootstrap", {
      cookie: cookieHeader?.split(";", 1)[0] || ""
    });
    expect(authorizedApi.statusCode).toBe(200);
    expect(JSON.parse(authorizedApi.body)).toEqual(
      expect.objectContaining({
        selectedWorkspacePath: workspacePath
      })
    );
  });

  it("rejects sibling directories that only share the static root prefix", () => {
    const staticRoot = "/tmp/lithium/dist-mobile";
    const siblingPath = path.resolve(staticRoot, "../dist-mobile-backup/index.html");

    expect(isSafeStaticPath(staticRoot, path.join(staticRoot, "index.html"))).toBe(true);
    expect(isSafeStaticPath(staticRoot, siblingPath)).toBe(false);
  });
});

async function createStaticRoot() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-mobile-bridge-"));
  tempDirs.push(tempDir);
  await writeFile(path.join(tempDir, "index.html"), "<!doctype html><title>Lithium Mobile</title>", "utf8");
  return tempDir;
}

function createRuntimeState(selectedWorkspacePath: string): RuntimeAppState {
  return {
    platform: "darwin",
    electronVersion: "40.8.2",
    chromeVersion: "144.0.0.0",
    nodeVersion: "24.0.0",
    cwd: selectedWorkspacePath,
    selectedWorkspacePath,
    selectedWorkspaceLabel: "Lithium Mobile",
    selectedWorkspaceKind: "local",
    selectedWorkspaceRemoteHost: null,
    selectedWorkspaceRemotePath: null,
    oracleReady: true,
    codexReady: true,
    oracleChromePath: null,
    discordBotStatus: {
      state: "disabled",
      botTag: "",
      botUserId: "",
      lastError: null,
      workspacePath: ""
    },
    settings: DEFAULT_APP_SETTINGS
  };
}

function createSnapshot(): ProjectSnapshot {
  return {
    project: null,
    memory: null,
    threads: [],
    activeThreadId: null,
    activeThread: null,
    attachments: [],
    activeThreadAttachments: [],
    decisions: [],
    tasks: [],
    runs: [],
    latestDecision: null,
    latestTask: null,
    latestRun: null,
    terminalSessions: [],
    latestTerminalSession: null,
    manuscript: null,
    logs: []
  };
}

function getServerPort(server: MobileBridgeServer) {
  const activeServer = (server as any).server as { address: () => AddressInfo | string | null };
  const address = activeServer.address();

  if (!address || typeof address === "string") {
    throw new Error("Mobile bridge server did not expose a TCP address.");
  }

  return address.port;
}

async function requestText(port: number, requestPath: string, headers: Record<string, string> = {}) {
  return await new Promise<{
    statusCode: number;
    headers: Record<string, string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
        headers
      },
      (response) => {
        let body = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: {
              "set-cookie": response.headers["set-cookie"]
            },
            body
          });
        });
      }
    );

    request.on("error", reject);
    request.end();
  });
}
