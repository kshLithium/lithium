import { readFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { CommandSpec, OracleModel, OracleThinkingTime } from "../../shared/types";
import { pathExists, readTextFileIfExists, statIfExists } from "./fs-utils";
import {
  ORACLE_BROWSER_COOKIE_DB_PATH,
  ORACLE_BROWSER_INLINE_COOKIES_PATH,
  ORACLE_BROWSER_PROFILE_PATH
} from "./oracle-browser-profile";
import { detectChromePath } from "./chrome-detection";
import { startCommand, type CommandResult } from "./process-runner";
import { describeIncompletePlannerOutput } from "./protocol";

type OracleRunOptions = {
  workspacePath: string;
  prompt: string;
  model: OracleModel;
  browserThinkingTime: OracleThinkingTime;
  files: string[];
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  slug: string;
  oracleSessionReady?: boolean;
};

let browserThinkingTimeSupportPromise: Promise<boolean> | null = null;
const packagedResourcesPath =
  typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
    ? (process as NodeJS.Process & { resourcesPath: string }).resourcesPath
    : "";

export type OracleLaunchOptions = {
  browserVisible: boolean;
  browserHeadless: boolean;
  keepBrowser: boolean;
  manualLogin: boolean;
  oracleSessionReady: boolean;
  chatgptUrl?: string;
};

export type OracleRunResult = {
  command: CommandSpec;
  chromePath?: string;
  sessionId?: string;
  sessionLogPath?: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputText: string;
};

export type OracleStartedSession = {
  command: CommandSpec;
  chromePath?: string;
  sessionId: string;
  sessionLogPath?: string;
  startedAt: string;
  pid: number | null;
  terminate: (signal?: NodeJS.Signals) => void;
  result: Promise<OracleRunResult>;
  slug: string;
  model: OracleModel;
  files: string[];
  outputPath: string;
  stdoutPath: string;
  stderrPath: string;
};

type InteractiveRecoveryMode = "cookies" | "fresh-browser" | "fresh-chat" | null;

export class OracleRunner {
  async startConsult(options: OracleRunOptions): Promise<OracleStartedSession> {
    const sessionId = normalizeOracleSessionId(options.slug);
    const initialLaunch = resolveOracleLaunchOptions(process.env, {
      oracleSessionReady: options.oracleSessionReady
    });
    const allowSessionUrlReuse = shouldReuseSavedChatgptSessionUrl(process.env);
    const shouldPreemptReusableBrowser = initialLaunch.manualLogin && initialLaunch.oracleSessionReady;
    const reusableSessionUrl =
      initialLaunch.oracleSessionReady && allowSessionUrlReuse && !initialLaunch.chatgptUrl
        ? await resolveReusableChatgptSessionUrl(sessionId)
        : undefined;
    const launch =
      reusableSessionUrl && !initialLaunch.chatgptUrl
        ? {
            ...initialLaunch,
            chatgptUrl: reusableSessionUrl
          }
        : initialLaunch;
    const browserThinkingTime = (await supportsOracleBrowserThinkingTime())
      ? options.browserThinkingTime
      : undefined;
    const chromePath = await detectChromePath();

    if (shouldPreemptReusableBrowser) {
      await this.resetInteractiveReuseState(chromePath);
    }

    const oracleCommand = await resolveLocalOracleCommand();
    const inlineCookiesPath =
      await pathExists(ORACLE_BROWSER_INLINE_COOKIES_PATH)
        ? ORACLE_BROWSER_INLINE_COOKIES_PATH
        : undefined;
    const commandEnv = launch.manualLogin
      ? {
          ORACLE_BROWSER_PROFILE_DIR: ORACLE_BROWSER_PROFILE_PATH
        }
      : undefined;
    const command = this.buildCommand({
      workspacePath: options.workspacePath,
      prompt: this.normalizePrompt(options.prompt),
      model: options.model,
      browserThinkingTime,
      outputPath: options.outputPath,
      slug: options.slug,
      chromePath,
      oracleCommand,
      inlineCookiesPath,
      launch,
      files: options.files
    });
    const session = await startCommand({
      spec: command,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      env: commandEnv
    });

    void session.result.finally(async () => {
      await this.cleanupLingeringBrowser(chromePath, launch).catch(() => undefined);
    });

    return {
      command,
      chromePath,
      sessionId,
      sessionLogPath: await resolveOracleSessionLogPath(sessionId),
      startedAt: session.startedAt,
      pid: session.pid,
      terminate: (signal) => {
        session.terminate(signal);
        void this.terminateSession(options.slug).catch(() => undefined);
      },
      result: session.result.then(async (result) => {
        const initialOutput =
          (await readTextFileIfExists(options.outputPath)).trim() ||
          [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
        const outputIssue = describeIncompletePlannerOutput(initialOutput);
        if (result.exitCode === 0 && initialOutput && !outputIssue) {
          return {
            command,
            chromePath,
            sessionId,
            sessionLogPath: await resolveOracleSessionLogPath(sessionId),
            outputText: initialOutput,
            ...result
          };
        }
        const recovered = await this.consult(options).catch(async () => ({
          command,
          chromePath,
          sessionId,
          sessionLogPath: await resolveOracleSessionLogPath(sessionId),
          outputText: initialOutput,
          ...result
        }));
        return recovered;
      }),
      slug: options.slug,
      model: options.model,
      files: options.files,
      outputPath: options.outputPath,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath
    };
  }

  async consult(options: OracleRunOptions): Promise<OracleRunResult> {
    const sessionId = normalizeOracleSessionId(options.slug);
    const initialLaunch = resolveOracleLaunchOptions(process.env, {
      oracleSessionReady: options.oracleSessionReady
    });
    const allowSessionUrlReuse = shouldReuseSavedChatgptSessionUrl(process.env);
    const shouldPreemptReusableBrowser = initialLaunch.manualLogin && initialLaunch.oracleSessionReady;
    const reusableSessionUrl =
      initialLaunch.oracleSessionReady && allowSessionUrlReuse && !initialLaunch.chatgptUrl
        ? await resolveReusableChatgptSessionUrl(sessionId)
        : undefined;
    const launch =
      reusableSessionUrl && !initialLaunch.chatgptUrl
        ? {
            ...initialLaunch,
            chatgptUrl: reusableSessionUrl
          }
        : initialLaunch;
    const browserThinkingTime = (await supportsOracleBrowserThinkingTime())
      ? options.browserThinkingTime
      : undefined;
    const chromePath = await detectChromePath();

    if (shouldPreemptReusableBrowser) {
      await this.resetInteractiveReuseState(chromePath);
    }

    const oracleCommand = await resolveLocalOracleCommand();
    const inlineCookiesPath =
      await pathExists(ORACLE_BROWSER_INLINE_COOKIES_PATH)
        ? ORACLE_BROWSER_INLINE_COOKIES_PATH
        : undefined;
    const commandEnv = launch.manualLogin
      ? {
          ORACLE_BROWSER_PROFILE_DIR: ORACLE_BROWSER_PROFILE_PATH
        }
      : undefined;
    const primaryCommand = this.buildCommand({
      workspacePath: options.workspacePath,
      prompt: this.normalizePrompt(options.prompt),
      model: options.model,
      browserThinkingTime,
      outputPath: options.outputPath,
      slug: options.slug,
      chromePath,
      oracleCommand,
      inlineCookiesPath,
      launch,
      files: options.files
    });

    const primaryAttempt = await this.runWithRetries(primaryCommand, options, commandEnv);

    const primaryOutputIssue = describeIncompletePlannerOutput(primaryAttempt.outputText);

    if (primaryAttempt.result.exitCode === 0 && primaryAttempt.outputText.trim() && !primaryOutputIssue) {
      await this.cleanupLingeringBrowser(chromePath, launch);
      return {
        command: primaryCommand,
        chromePath,
        sessionId,
        sessionLogPath: await resolveOracleSessionLogPath(sessionId),
        outputText: primaryAttempt.outputText,
        ...primaryAttempt.result
      };
    }

    const primaryReason =
      primaryOutputIssue ??
      this.buildFailureReason(
        primaryAttempt.result,
        primaryAttempt.outputText,
        primaryAttempt.sessionError
      );

    const recoveryMode = classifyInteractiveSessionRecovery(primaryReason, launch);

    if (recoveryMode && shouldAutoRecoverInteractiveSession(launch, process.env)) {
      if (recoveryMode === "fresh-browser" || recoveryMode === "fresh-chat") {
        await this.resetInteractiveReuseState(chromePath);
      }

      const recoveryInitialLaunch = resolveOracleLaunchOptions(process.env, {
        oracleSessionReady: recoveryMode === "cookies" ? false : launch.oracleSessionReady
      });
      const recoveryLaunch =
        recoveryMode !== "fresh-chat" && reusableSessionUrl && !recoveryInitialLaunch.chatgptUrl
          ? {
              ...recoveryInitialLaunch,
              chatgptUrl: reusableSessionUrl
            }
          : recoveryInitialLaunch;
      const recoveryCommand = this.buildCommand({
        workspacePath: options.workspacePath,
        prompt: this.normalizePrompt(options.prompt),
        model: options.model,
        browserThinkingTime,
        outputPath: options.outputPath,
        slug: options.slug,
        chromePath,
        oracleCommand,
        inlineCookiesPath,
        launch: recoveryLaunch,
        files: options.files
      });
      const recoveryAttempt = await this.runWithRetries(recoveryCommand, options);
      const recoveryOutputIssue = describeIncompletePlannerOutput(recoveryAttempt.outputText);

      if (
        recoveryAttempt.result.exitCode === 0 &&
        recoveryAttempt.outputText.trim() &&
        !recoveryOutputIssue
      ) {
        await this.cleanupLingeringBrowser(chromePath, recoveryLaunch);
        return {
          command: recoveryCommand,
          chromePath,
          sessionId,
          sessionLogPath: await resolveOracleSessionLogPath(sessionId),
          outputText: recoveryAttempt.outputText,
          ...recoveryAttempt.result
        };
      }

      const recoveryReason =
        recoveryOutputIssue ??
        this.buildFailureReason(
          recoveryAttempt.result,
          recoveryAttempt.outputText,
          recoveryAttempt.sessionError
        );
      throw new Error(this.appendBrowserVisibilityHint(recoveryReason, recoveryLaunch));
    }

    throw new Error(this.appendBrowserVisibilityHint(primaryReason, launch));
  }

  private normalizePrompt(prompt: string) {
    return prompt.trim();
  }

  private buildCommand(input: {
    workspacePath: string;
    prompt: string;
    model: OracleModel;
    browserThinkingTime?: OracleThinkingTime;
    outputPath: string;
    slug: string;
    chromePath?: string;
    oracleCommand?: string;
    inlineCookiesPath?: string;
    launch: OracleLaunchOptions;
    files: string[];
  }) {
    const args = input.oracleCommand
      ? ["--engine", "browser", "--model", input.model]
      : ["-y", "@steipete/oracle", "--engine", "browser", "--model", input.model];

    args.push(
      "--browser-model-strategy",
      "select",
      "--browser-auto-reattach-delay",
      "5s",
      "--browser-auto-reattach-interval",
      "3s"
    );

    if (input.files.length > 0) {
      args.push("--browser-attachments", "always");
    }

    if (input.browserThinkingTime) {
      args.push("--browser-thinking-time", input.browserThinkingTime);
    }

    if (input.launch.manualLogin) {
      args.push("--browser-manual-login");
    }

    if (input.launch.browserHeadless) {
      args.push("--browser-headless");
    } else if (!input.launch.browserVisible) {
      args.push("--browser-hide-window");
    }

    if (input.launch.keepBrowser) {
      args.push("--browser-keep-browser");
    }

    if (input.launch.chatgptUrl) {
      args.push("--chatgpt-url", input.launch.chatgptUrl);
    }

    if (!input.launch.manualLogin) {
      if (input.inlineCookiesPath) {
        args.push("--browser-inline-cookies-file", input.inlineCookiesPath);
      } else {
        args.push("--browser-cookie-path", ORACLE_BROWSER_COOKIE_DB_PATH);
      }
    }

    if (input.chromePath) {
      args.push("--browser-chrome-path", input.chromePath);
    }

    args.push(
      "--force",
      "--write-output",
      input.outputPath,
      "--slug",
      input.slug,
      "--prompt",
      input.prompt,
      ...input.files.flatMap((file) => ["--file", file])
    );

    return {
      command: input.oracleCommand ?? "npx",
      args,
      cwd: input.workspacePath
    } satisfies CommandSpec;
  }

  private async readMaybe(filePath: string) {
    return await readTextFileIfExists(filePath);
  }

  private async runWithRetries(
    command: CommandSpec,
    options: OracleRunOptions,
    env?: NodeJS.ProcessEnv
  ) {
    let lastResult: CommandResult | null = null;
    let outputText = "";
    let sessionError = "";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const execution = await this.runOracleCommand(command, options, env);
      const result = execution.result;
      sessionError = execution.sessionError;
      lastResult = result;
      outputText = await this.readMaybe(options.outputPath);

      if (result.exitCode === 0 && outputText.trim()) {
        return {
          result,
          outputText,
          sessionError
        };
      }

      if (attempt < 2) {
        await sleep(3_000);
      }
    }

    return {
      result:
        lastResult ??
        ({
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          exitCode: null,
          timedOut: false,
          stdout: "",
          stderr: ""
        } satisfies CommandResult),
      outputText,
      sessionError
    };
  }

  private async runOracleCommand(
    command: CommandSpec,
    options: OracleRunOptions,
    env?: NodeJS.ProcessEnv
  ) {
    const session = await startCommand({
      spec: command,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      env
    });
    const sessionId = normalizeOracleSessionId(options.slug);
    let finished = false;
    let sessionError = "";
    const resultPromise = session.result.then((result) => {
      finished = true;
      return result;
    });

    while (!finished) {
      const earlySessionError = await readOracleSessionError(sessionId);

      if (earlySessionError) {
        sessionError = earlySessionError;
        session.terminate("SIGTERM");
        break;
      }

      await sleep(750);
    }

    return {
      result: await resultPromise,
      sessionError
    };
  }

  private buildFailureReason(
    result: CommandResult,
    outputText: string,
    sessionError = ""
  ) {
    if (result.exitCode !== 0) {
      return sessionError || result.stderr.trim() || result.stdout.trim() || "Oracle planner run failed.";
    }

    if (outputText.trim()) {
      return outputText.trim();
    }

    return sessionError || "Oracle planner run completed without producing output.";
  }

  private appendBrowserVisibilityHint(reason: string, launch: OracleLaunchOptions) {
    if (launch.browserVisible) {
      if (launch.oracleSessionReady) {
        return `${reason}\nIf the saved ChatGPT session expired, reset oracle sign-in from Settings and try again.`;
      }
      return reason;
    }

    return `${reason}\nSet LITHIUM_ORACLE_VISIBLE=1 if you need to watch the browser login or troubleshoot the run.`;
  }

  private async cleanupLingeringBrowser(
    chromePath: string | undefined,
    launch: OracleLaunchOptions
  ) {
    if (!chromePath || !shouldCleanupOracleBrowserAfterSuccess(launch, process.env)) {
      return;
    }

    const running = await this.listOracleBrowserPids(chromePath);

    if (running.length === 0) {
      return;
    }

    for (const pid of running) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Ignore processes that already exited or are not signalable.
      }
    }

    await sleep(750);

    const stubborn = await this.listOracleBrowserPids(chromePath);

    for (const pid of stubborn) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore races with already-terminated processes.
      }
    }
  }

  private async resetInteractiveReuseState(chromePath: string | undefined) {
    if (chromePath) {
      const running = await this.listOracleBrowserPids(chromePath);

      for (const pid of running) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Ignore already-exited processes.
        }
      }

      if (running.length > 0) {
        await sleep(750);
      }

      for (const pid of await this.listOracleBrowserPids(chromePath)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Ignore already-exited processes.
        }
      }
    }

    const stalePaths = [
      path.join(ORACLE_BROWSER_PROFILE_PATH, "DevToolsActivePort"),
      path.join(ORACLE_BROWSER_PROFILE_PATH, "Default", "DevToolsActivePort"),
      path.join(ORACLE_BROWSER_PROFILE_PATH, "chrome.pid")
    ];

    await Promise.all(
      stalePaths.map(async (targetPath) => {
        try {
          await rm(targetPath, { force: true });
        } catch {
          // Ignore missing or locked files; this is best-effort cleanup.
        }
      })
    );

    await clearOracleBrowserSessionRestoreState();
  }

  async terminateSession(slug: string) {
    const psOutput = await execFileText("ps", ["axww", "-o", "pid=,command="]).catch(() => "");

    if (!psOutput.trim()) {
      return;
    }

    const targets = psOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);

        if (!match) {
          return null;
        }

        return {
          pid: Number(match[1]),
          command: match[2]
        };
      })
      .filter((entry): entry is { pid: number; command: string } => Boolean(entry))
      .filter(
        (entry) =>
          entry.command.includes("/oracle") &&
          entry.command.includes("--slug") &&
          entry.command.includes(slug)
      );

    for (const target of targets) {
      try {
        process.kill(target.pid, "SIGTERM");
      } catch {
        // Ignore already-dead processes.
      }
    }

    if (!targets.length) {
      return;
    }

    await sleep(750);

    for (const target of targets) {
      try {
        process.kill(target.pid, "SIGKILL");
      } catch {
        // Ignore already-dead processes.
      }
    }
  }

  private async listOracleBrowserPids(chromePath: string) {
    try {
      const psOutput = await execFileText("ps", ["axww", "-o", "pid=,command="]);
      return findOracleBrowserPids(psOutput, {
        chromePath,
        profilePath: ORACLE_BROWSER_PROFILE_PATH
      });
    } catch {
      return [];
    }
  }
}

async function resolveLocalOracleCommand() {
  for (const candidate of buildLocalOracleBinCandidates()) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function buildLocalOracleBinCandidates(input?: {
  cwd?: string;
  moduleDir?: string;
  argvEntry?: string;
  resourcesPath?: string;
}) {
  const candidateRoots = [
    input?.cwd ?? process.cwd(),
    input?.argvEntry ? path.dirname(input.argvEntry) : process.argv[1] ? path.dirname(process.argv[1]) : "",
    input?.moduleDir ?? __dirname,
    input?.resourcesPath
      ? path.join(input.resourcesPath, "app.asar.unpacked")
      : packagedResourcesPath
        ? path.join(packagedResourcesPath, "app.asar.unpacked")
        : "",
    input?.resourcesPath ?? packagedResourcesPath
  ].filter(Boolean);

  const candidates = new Set<string>();

  for (const root of candidateRoots) {
    for (let depth = 0; depth <= 3; depth += 1) {
      const prefixes = new Array(depth).fill("..");
      candidates.add(path.resolve(root, ...prefixes, "node_modules", ".bin", "oracle"));
    }
  }

  return [...candidates];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeOracleSessionId(rawSlug: string) {
  const words = (rawSlug.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .slice(0, 5)
    .map((word) => word.slice(0, 10));

  if (!words.length) {
    return "session";
  }

  return words.join("-");
}

export async function resolveOracleSessionLogPath(sessionId: string) {
  const candidates = await listOracleSessionArtifactCandidates(sessionId, "output.log");
  return candidates[0]?.artifactPath;
}

export async function readOracleSessionError(sessionId: string) {
  const metaPath = await resolveOracleSessionMetaPath(sessionId);

  if (!metaPath) {
    return "";
  }

  try {
    const raw = await readFile(metaPath, "utf8");
    const meta = JSON.parse(raw) as {
      status?: string;
      errorMessage?: string;
      error?: { message?: string };
    };

    if (meta.status !== "error") {
      return "";
    }

    return meta.errorMessage?.trim() || meta.error?.message?.trim() || "Oracle browser session failed.";
  } catch {
    return "";
  }
}

async function resolveOracleSessionMetaPath(sessionId: string) {
  const candidates = await listOracleSessionMetaCandidates(sessionId);
  return candidates[0]?.metaPath;
}

async function listOracleSessionMetaCandidates(sessionId: string) {
  const candidates = await listOracleSessionArtifactCandidates(sessionId, "meta.json");
  return candidates.map((entry) => ({
    metaPath: entry.artifactPath,
    modifiedAt: entry.modifiedAt
  }));
}

async function resolveReusableChatgptSessionUrl(sessionId: string) {
  const candidates = await listOracleSessionMetaCandidates(sessionId);

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate.metaPath, "utf8");
      const reusableSessionUrl = extractReusableChatgptSessionUrl(raw);

      if (reusableSessionUrl) {
        return reusableSessionUrl;
      }
    } catch {
      // Ignore malformed or stale metadata while scanning older reusable sessions.
    }
  }

  return undefined;
}

async function listOracleSessionArtifactCandidates(sessionId: string, fileName: string) {
  const sessionsDir = path.join(resolveOracleHomeDir(), "sessions");
  const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name === sessionId || entry.name.startsWith(`${sessionId}-`))
      .map(async (entry) => {
        const artifactPath = path.join(sessionsDir, entry.name, fileName);
        const metadata = await statIfExists(artifactPath);

        if (!metadata) {
          return null;
        }

        return {
          artifactPath,
          modifiedAt: metadata.mtimeMs
        };
      })
  );

  return candidates
    .filter((entry): entry is { artifactPath: string; modifiedAt: number } => Boolean(entry))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function resolveOracleHomeDir() {
  return process.env.ORACLE_HOME_DIR?.trim() || path.join(os.homedir(), ".oracle");
}

export async function clearOracleBrowserSessionRestoreState(profilePath = ORACLE_BROWSER_PROFILE_PATH) {
  const directTargets = [
    path.join(profilePath, "Default", "Current Session"),
    path.join(profilePath, "Default", "Current Tabs"),
    path.join(profilePath, "Default", "Last Session"),
    path.join(profilePath, "Default", "Last Tabs")
  ];

  await Promise.all(
    directTargets.map(async (targetPath) => {
      try {
        await rm(targetPath, { force: true });
      } catch {
        // Ignore missing session restore files.
      }
    })
  );

  const sessionsDir = path.join(profilePath, "Default", "Sessions");
  const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^(Session|Tabs)_/i.test(entry.name))
      .map(async (entry) => {
        try {
          await rm(path.join(sessionsDir, entry.name), { force: true });
        } catch {
          // Ignore races with Chrome already deleting these files.
        }
      })
  );
}

function execFileText(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stdout);
    });
  });
}

async function supportsOracleBrowserThinkingTime() {
  if (!browserThinkingTimeSupportPromise) {
    browserThinkingTimeSupportPromise = execFileText("npx", ["-y", "@steipete/oracle", "--help"])
      .then((stdout) => stdout.includes("--browser-thinking-time"))
      .catch(() => false);
  }

  return browserThinkingTimeSupportPromise;
}

export function shouldRetryInteractiveSessionRecovery(
  reason: string,
  launch: OracleLaunchOptions
) {
  return classifyInteractiveSessionRecovery(reason, launch) !== null;
}

export function shouldCleanupOracleBrowserAfterSuccess(
  launch: OracleLaunchOptions,
  env: NodeJS.ProcessEnv = process.env
) {
  return (
    launch.manualLogin &&
    launch.keepBrowser &&
    !toBoolean(env.LITHIUM_ORACLE_KEEP_BROWSER)
  );
}

export function shouldAutoRecoverInteractiveSession(
  launch: OracleLaunchOptions,
  env: NodeJS.ProcessEnv = process.env
) {
  if (!launch.oracleSessionReady) {
    return false;
  }

  const configured = env.LITHIUM_ORACLE_AUTO_RECOVER?.trim().toLowerCase();

  if (configured === "0" || configured === "false") {
    return false;
  }

  return true;
}

export function findOracleBrowserPids(
  psOutput: string,
  input: {
    chromePath: string;
    profilePath: string;
  }
) {
  const expectedUserDataDir = `--user-data-dir=${input.profilePath}`;

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

      if (!Number.isFinite(pid)) {
        return [];
      }

      if (!command.includes(expectedUserDataDir)) {
        return [];
      }

      if (!command.includes(input.chromePath)) {
        return [];
      }

      if (command.includes("--type=")) {
        return [];
      }

      return [pid];
    });
}

export function resolveOracleLaunchOptions(
  env: NodeJS.ProcessEnv = process.env,
  input: {
    oracleSessionReady?: boolean;
  } = {}
): OracleLaunchOptions {
  const oracleSessionReady = Boolean(input.oracleSessionReady);
  const forcedVisible = toBoolean(env.LITHIUM_ORACLE_VISIBLE);
  const forcedHeadless = toBoolean(env.LITHIUM_ORACLE_HEADLESS);
  const browserVisible = forcedVisible || !oracleSessionReady;
  const manualLogin = true;
  const browserHeadless = oracleSessionReady && forcedHeadless;

  return {
    browserVisible,
    browserHeadless,
    keepBrowser:
      browserVisible && (toBoolean(env.LITHIUM_ORACLE_KEEP_BROWSER) || !oracleSessionReady),
    manualLogin,
    oracleSessionReady,
    chatgptUrl: env.LITHIUM_ORACLE_CHATGPT_URL?.trim() || undefined
  };
}

export function shouldReuseSavedChatgptSessionUrl(env: NodeJS.ProcessEnv = process.env) {
  return toBoolean(env.LITHIUM_ORACLE_REUSE_CHATGPT_URL);
}

function toBoolean(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true";
}

export function classifyInteractiveSessionRecovery(
  reason: string,
  launch: OracleLaunchOptions
): InteractiveRecoveryMode {
  if (!launch.oracleSessionReady) {
    return null;
  }

  if (
    /no (?:chatgpt )?cookies were applied|log in to chatgpt in chrome|provide inline cookies|cannot proceed in browser mode/i.test(
      reason
    )
  ) {
    return "cookies";
  }

  if (
    /connect econnrefused|prompt textarea did not appear before timeout|prompt-not-in-composer|prompt did not appear before timeout|send may have failed|chrome window closed before oracle finished|chrome disconnected before completion/i.test(
      reason
    )
  ) {
    return "fresh-browser";
  }

  if (/output looked truncated or non-final/i.test(reason)) {
    return "fresh-chat";
  }

  return null;
}

export function extractReusableChatgptSessionUrl(rawMeta: string) {
  try {
    const meta = JSON.parse(rawMeta) as {
      browser?: {
        runtime?: Record<string, string | undefined>;
      };
    };
    const runtime = meta.browser?.runtime;
    const tabUrl = runtime?.tabUrl?.trim();

    if (tabUrl && /^https:\/\/chatgpt\.com\/c\/[^/?#]+/i.test(tabUrl)) {
      return tabUrl;
    }

    const sessionUrlId = runtime?.[["convers", "ationId"].join("")]?.trim();

    if (sessionUrlId) {
      return `https://chatgpt.com/c/${sessionUrlId}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
