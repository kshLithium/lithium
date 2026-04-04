import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { chromium, type Browser } from "playwright-core";
import { detectChromePath } from "./chrome-detection";
import {
  ORACLE_BROWSER_INLINE_COOKIES_PATH,
  ORACLE_BROWSER_PROFILE_PATH
} from "./oracle-browser-profile";

const CHATGPT_LOGIN_URL = "https://chatgpt.com/auth/login";
const CHATGPT_HOME_URL = "https://chatgpt.com/";
const AUTH_POLL_INTERVAL_MS = 1_000;
const REQUIRED_STABLE_POLLS = 2;
const SESSION_URLS = ["https://chatgpt.com", "https://auth.openai.com", "https://openai.com"];
const FIRST_PARTY_AUTH_COOKIE_NAMES = ["oai-client-auth-info"];

type ChatgptAuthOptions = {
  timeoutMs?: number | null;
};

type ChatgptCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "None" | "Strict";
};

export class ChatgptAuthRunner {
  async signIn(options: ChatgptAuthOptions = {}) {
    const chromePath = await detectChromePath();

    if (!chromePath) {
      throw new Error("Chrome or Chromium is required before ChatGPT Pro sign-in can start.");
    }

    await this.resetProfile(chromePath);
    await mkdir(ORACLE_BROWSER_PROFILE_PATH, { recursive: true });

    const port = await findAvailablePort();
    const loginProcess = spawn(chromePath, buildChatgptLoginArgs({
      port,
      profilePath: ORACLE_BROWSER_PROFILE_PATH
    }), {
      stdio: "ignore"
    });

    let browser: Browser | null = null;

    try {
      browser = await connectToChrome(port, loginProcess, options.timeoutMs);
      const cookies = await waitForReusableChatgptSession(
        browser,
        loginProcess,
        options.timeoutMs
      );
      await exportInlineCookies(cookies);
    } finally {
      if (browser) {
        await browser.close().catch(() => undefined);
      }

      await terminateChrome(loginProcess);
    }
  }

  async prepareReusableSession(options: ChatgptAuthOptions = {}) {
    if (await hasReusableInlineCookiesFile()) {
      return;
    }

    const chromePath = await detectChromePath();

    if (!chromePath) {
      throw new Error("Chrome or Chromium is required before ChatGPT Pro planner runs can start.");
    }

    if (!(await exists(ORACLE_BROWSER_PROFILE_PATH))) {
      throw new Error(
        "No saved ChatGPT Pro session was found. Open Settings and sign in to ChatGPT Pro first."
      );
    }

    const port = await findAvailablePort();
    const probeProcess = spawn(chromePath, buildChatgptProbeArgs({
      port,
      profilePath: ORACLE_BROWSER_PROFILE_PATH,
      url: CHATGPT_HOME_URL
    }), {
      stdio: "ignore"
    });

    let browser: Browser | null = null;

    try {
      browser = await connectToChrome(port, probeProcess, options.timeoutMs);
      const cookies = await waitForReusableChatgptSession(
        browser,
        probeProcess,
        options.timeoutMs
      );
      await exportInlineCookies(cookies);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Lithium could not reuse the saved ChatGPT Pro session. ${reason} Run :signin again and log in once more.`
      );
    } finally {
      if (browser) {
        await browser.close().catch(() => undefined);
      }

      await terminateChrome(probeProcess);
    }
  }

  private async resetProfile(chromePath: string) {
    await terminateLingeringOracleChrome(chromePath);
    await removeOracleProfile();
    await rm(ORACLE_BROWSER_INLINE_COOKIES_PATH, { force: true });
  }
}

export function buildChatgptLoginArgs(input: { port: number; profilePath: string }) {
  return [
    `--user-data-dir=${input.profilePath}`,
    `--remote-debugging-port=${input.port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "--password-store=basic",
    "--use-mock-keychain",
    CHATGPT_LOGIN_URL
  ];
}

export function buildChatgptProbeArgs(input: { port: number; profilePath: string; url: string }) {
  return [
    `--user-data-dir=${input.profilePath}`,
    `--remote-debugging-port=${input.port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--headless=new",
    "--disable-gpu",
    input.url
  ];
}

export function hasChatgptSessionCookies(
  cookies: Array<{
    name: string;
    domain: string;
  }>
) {
  return cookies.some(
    (cookie) =>
      /(^|\.)chatgpt\.com$/.test(cookie.domain) &&
      cookie.name.startsWith("__Secure-next-auth.session-token")
  );
}

export function hasChatgptAuthMetadata(
  cookies: Array<{
    name: string;
    domain: string;
  }>
) {
  return hasChatgptFirstPartyAuthMetadata(cookies) || hasChatgptOpenAiAuthMetadata(cookies);
}

export function hasChatgptFirstPartyAuthMetadata(
  cookies: Array<{
    name: string;
    domain: string;
  }>
) {
  return cookies.some(
    (cookie) =>
      /(^|\.)chatgpt\.com$/.test(cookie.domain) &&
      FIRST_PARTY_AUTH_COOKIE_NAMES.includes(cookie.name)
  );
}

export function hasChatgptOpenAiAuthMetadata(
  cookies: Array<{
    name: string;
    domain: string;
  }>
) {
  return cookies.some(
    (cookie) =>
      /(^|\.)auth\.openai\.com$/.test(cookie.domain) ? /^oai-client-auth-(info|session)$/.test(cookie.name) : false
  );
}

export function hasReusableChatgptSession(
  cookies: Array<{
    name: string;
    domain: string;
  }>
) {
  return hasChatgptSessionCookies(cookies) && hasChatgptFirstPartyAuthMetadata(cookies);
}

async function waitForReusableChatgptSession(
  browser: Browser,
  process: ChildProcess,
  timeoutMs?: number | null
) {
  const deadline =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Date.now() + timeoutMs
      : null;
  let stablePolls = 0;
  let lastCookies: ChatgptCookie[] = [];
  let homeHydrationRequested = false;

  while (deadline === null || Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error("ChatGPT sign-in window was closed before login finished.");
    }

    const cookies = await collectChatgptCookies(browser);
    lastCookies = cookies;

    if (hasReusableChatgptSession(cookies)) {
      stablePolls += 1;

      if (stablePolls >= REQUIRED_STABLE_POLLS) {
        return cookies;
      }
    } else {
      stablePolls = 0;

      if (
        !homeHydrationRequested &&
        hasChatgptSessionCookies(cookies) &&
        hasChatgptOpenAiAuthMetadata(cookies)
      ) {
        homeHydrationRequested = true;
        await hydrateChatgptHomeSession(browser);
      }
    }

    await sleep(AUTH_POLL_INTERVAL_MS);
  }

  if (hasChatgptSessionCookies(lastCookies) && !hasChatgptFirstPartyAuthMetadata(lastCookies)) {
    throw new Error(
      "ChatGPT login looks partially complete, but the reusable ChatGPT session cookie never appeared on chatgpt.com."
    );
  }

  throw new Error("Timed out waiting for ChatGPT Pro sign-in to complete.");
}

async function collectChatgptCookies(browser: Browser): Promise<ChatgptCookie[]> {
  const batches = await Promise.all(browser.contexts().map((context) => context.cookies(SESSION_URLS)));
  const merged = new Map<string, ChatgptCookie>();

  for (const cookie of batches.flat()) {
    if (!/chatgpt\.com|openai\.com/.test(cookie.domain)) {
      continue;
    }

    const key = `${cookie.domain}:${cookie.path ?? "/"}:${cookie.name}`;

    if (!merged.has(key)) {
      merged.set(key, cookie);
    }
  }

  return Array.from(merged.values());
}

async function hydrateChatgptHomeSession(browser: Browser) {
  const [context] = browser.contexts();

  if (!context) {
    return;
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(CHATGPT_HOME_URL, {
    waitUntil: "domcontentloaded"
  }).catch(() => undefined);
}

async function exportInlineCookies(cookies: ChatgptCookie[]) {
  const filtered = cookies
    .filter((cookie) => /chatgpt\.com|openai\.com/.test(cookie.domain))
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? "/",
      expires: cookie.expires,
      secure: cookie.secure ?? true,
      httpOnly: cookie.httpOnly ?? false,
      sameSite: cookie.sameSite
    }));

  if (!hasReusableChatgptSession(filtered)) {
    throw new Error("Lithium did not capture a reusable ChatGPT session after sign-in.");
  }

  await mkdir(path.dirname(ORACLE_BROWSER_INLINE_COOKIES_PATH), { recursive: true });
  await writeFile(ORACLE_BROWSER_INLINE_COOKIES_PATH, JSON.stringify(filtered, null, 2), "utf8");
}

async function connectToChrome(port: number, process: ChildProcess, timeoutMs?: number | null) {
  const deadline =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Date.now() + timeoutMs
      : null;
  let lastError: unknown = null;

  while (deadline === null || Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error("ChatGPT sign-in window closed before Lithium could attach to it.");
    }

    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Lithium could not attach to the ChatGPT sign-in browser.");
}

async function terminateLingeringOracleChrome(chromePath: string) {
  const psOutput = await readProcessTable();
  const pids = listOracleChromePids(psOutput, {
    chromePath,
    profilePath: ORACLE_BROWSER_PROFILE_PATH
  });

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore races with already exited processes.
    }
  }

  await sleep(500);

  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore already-gone processes.
    }
  }

  await sleep(500);
}

function readProcessTable() {
  return new Promise<string>((resolve, reject) => {
    const ps = spawn("ps", ["axww", "-o", "pid=,command="], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    let output = "";

    ps.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    ps.on("error", reject);
    ps.on("close", (code) => {
      if (code === 0) {
        resolve(output);
        return;
      }

      reject(new Error("Could not inspect existing Chrome processes."));
    });
  });
}

async function terminateChrome(process: ChildProcess) {
  if (process.exitCode !== null) {
    return;
  }

  process.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch {
        // Ignore already-exited processes.
      }
      resolve();
    }, 2_000);

    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function findAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local debugging port.")));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function listOracleChromePids(
  psOutput: string,
  input: {
    chromePath: string;
    profilePath: string;
  }
) {
  const chromeLabel = path.basename(input.chromePath).replace(/\s+/g, " ");
  const profileFlag = `--user-data-dir=${input.profilePath}`;

  return psOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);

      if (!match) {
        return [];
      }

      const pid = Number.parseInt(match[1], 10);
      const command = match[2];

      if (!Number.isFinite(pid) || !command.includes(profileFlag)) {
        return [];
      }

      if (
        !command.includes(chromeLabel) &&
        !command.includes("Google Chrome for Testing Helper") &&
        !command.includes("Google Chrome Helper")
      ) {
        return [];
      }

      return [pid];
    });
}

async function removeOracleProfile() {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await rm(ORACLE_BROWSER_PROFILE_PATH, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 200
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(300 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Could not clear the Lithium browser profile.");
}

async function exists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hasReusableInlineCookiesFile() {
  try {
    const raw = JSON.parse(await readFile(ORACLE_BROWSER_INLINE_COOKIES_PATH, "utf8"));

    if (!Array.isArray(raw)) {
      return false;
    }

    return hasReusableChatgptSession(
      raw.filter((cookie): cookie is { name: string; domain: string } => {
        return (
          Boolean(cookie) &&
          typeof cookie === "object" &&
          typeof (cookie as { name?: unknown }).name === "string" &&
          typeof (cookie as { domain?: unknown }).domain === "string"
        );
      })
    );
  } catch {
    return false;
  }
}
