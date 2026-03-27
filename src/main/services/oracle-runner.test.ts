import { access, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearOracleBrowserSessionRestoreState,
  classifyInteractiveSessionRecovery,
  extractReusableChatgptConversationUrl,
  findOracleBrowserPids,
  normalizeOracleSessionId,
  OracleRunner,
  readOracleSessionError,
  resolveOracleLaunchOptions,
  resolveOracleSessionLogPath,
  shouldReuseSavedChatgptConversation,
  shouldAutoRecoverInteractiveSession,
  shouldCleanupOracleBrowserAfterSuccess,
  shouldRetryInteractiveSessionRecovery
} from "./oracle-runner";

const ORACLE_PROFILE_PATH = "/tmp/lithium-fixtures/oracle/browser-profile";
const TESTING_CHROME_PATH =
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const LOCAL_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_CHROME_PROFILE = "/tmp/lithium-fixtures/google-chrome-default";

describe("OracleRunner", () => {
  it("opens the first browser run visibly so the user can sign in once", () => {
    expect(resolveOracleLaunchOptions({}, { strategistSessionReady: false })).toEqual({
      browserVisible: true,
      browserHeadless: false,
      keepBrowser: true,
      manualLogin: true,
      strategistSessionReady: false,
      chatgptUrl: undefined
    });
  });

  it("runs later browser calls headlessly once the strategist session is ready", () => {
    expect(resolveOracleLaunchOptions({}, { strategistSessionReady: true })).toEqual({
      browserVisible: false,
      browserHeadless: false,
      keepBrowser: false,
      manualLogin: true,
      strategistSessionReady: true,
      chatgptUrl: undefined
    });
  });

  it("keeps saved ChatGPT conversation reuse disabled unless explicitly requested", () => {
    expect(shouldReuseSavedChatgptConversation({})).toBe(false);
    expect(
      shouldReuseSavedChatgptConversation({
        LITHIUM_ORACLE_REUSE_CHATGPT_URL: "1"
      })
    ).toBe(true);
  });

  it("extracts a reusable conversation URL from session metadata", () => {
    expect(
      extractReusableChatgptConversationUrl(
        JSON.stringify({
          browser: {
            runtime: {
              tabUrl: "https://chatgpt.com/c/abc123"
            }
          }
        })
      )
    ).toBe("https://chatgpt.com/c/abc123");

    expect(
      extractReusableChatgptConversationUrl(
        JSON.stringify({
          browser: {
            runtime: {
              conversationId: "xyz789"
            }
          }
        })
      )
    ).toBe("https://chatgpt.com/c/xyz789");

    expect(
      extractReusableChatgptConversationUrl(
        JSON.stringify({
          browser: {
            runtime: {
              tabUrl: "https://chatgpt.com/"
            }
          }
        })
      )
    ).toBeUndefined();
  });

  it("prefers the newest suffixed oracle session log over a stale base session", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "lithium-oracle-home-"));
    const sessionRoot = path.join(oracleHome, "sessions");

    try {
      await mkdir(path.join(sessionRoot, "ors-strat-demo-th001"), { recursive: true });
      await writeFile(
        path.join(sessionRoot, "ors-strat-demo-th001", "output.log"),
        "stale",
        "utf8"
      );
      await mkdir(path.join(sessionRoot, "ors-strat-demo-th001-2"), { recursive: true });
      await writeFile(
        path.join(sessionRoot, "ors-strat-demo-th001-2", "output.log"),
        "fresh",
        "utf8"
      );

      const previous = process.env.ORACLE_HOME_DIR;
      process.env.ORACLE_HOME_DIR = oracleHome;
      try {
        await expect(resolveOracleSessionLogPath("ors-strat-demo-th001")).resolves.toBe(
          path.join(sessionRoot, "ors-strat-demo-th001-2", "output.log")
        );
      } finally {
        if (previous === undefined) {
          delete process.env.ORACLE_HOME_DIR;
        } else {
          process.env.ORACLE_HOME_DIR = previous;
        }
      }
    } finally {
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  it("ignores stale base-session errors when a newer suffixed session is still running", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "lithium-oracle-home-"));
    const sessionRoot = path.join(oracleHome, "sessions");

    try {
      await mkdir(path.join(sessionRoot, "ors-strat-demo-th001"), { recursive: true });
      await writeFile(
        path.join(sessionRoot, "ors-strat-demo-th001", "meta.json"),
        JSON.stringify({
          status: "error",
          errorMessage: "Chrome window closed before oracle finished. Please keep it open until completion."
        }),
        "utf8"
      );
      await mkdir(path.join(sessionRoot, "ors-strat-demo-th001-3"), { recursive: true });
      await writeFile(
        path.join(sessionRoot, "ors-strat-demo-th001-3", "meta.json"),
        JSON.stringify({
          status: "running"
        }),
        "utf8"
      );

      const previous = process.env.ORACLE_HOME_DIR;
      process.env.ORACLE_HOME_DIR = oracleHome;
      try {
        await expect(readOracleSessionError("ors-strat-demo-th001")).resolves.toBe("");
      } finally {
        if (previous === undefined) {
          delete process.env.ORACLE_HOME_DIR;
        } else {
          process.env.ORACLE_HOME_DIR = previous;
        }
      }
    } finally {
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  it("supports forcing true headless reuse only when explicitly requested", () => {
    expect(
      resolveOracleLaunchOptions(
        {
          LITHIUM_ORACLE_HEADLESS: "1"
        },
        { strategistSessionReady: true }
      )
    ).toEqual({
      browserVisible: false,
      browserHeadless: true,
      keepBrowser: false,
      manualLogin: true,
      strategistSessionReady: true,
      chatgptUrl: undefined
    });
  });

  it("clears Chrome session-restore artifacts without touching the rest of the profile", async () => {
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "lithium-oracle-profile-"));
    const defaultDir = path.join(profileRoot, "Default");
    const sessionsDir = path.join(defaultDir, "Sessions");

    try {
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(path.join(defaultDir, "Current Session"), "current", "utf8");
      await writeFile(path.join(defaultDir, "Last Tabs"), "tabs", "utf8");
      await writeFile(path.join(sessionsDir, "Session_123"), "session", "utf8");
      await writeFile(path.join(sessionsDir, "Tabs_123"), "tabs", "utf8");
      await writeFile(path.join(defaultDir, "Cookies"), "keep-me", "utf8");

      await clearOracleBrowserSessionRestoreState(profileRoot);

      await expect(access(path.join(defaultDir, "Current Session"))).rejects.toBeTruthy();
      await expect(access(path.join(defaultDir, "Last Tabs"))).rejects.toBeTruthy();
      await expect(access(path.join(sessionsDir, "Session_123"))).rejects.toBeTruthy();
      await expect(access(path.join(sessionsDir, "Tabs_123"))).rejects.toBeTruthy();
      await expect(readFile(path.join(defaultDir, "Cookies"), "utf8")).resolves.toBe("keep-me");
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  });

  it("builds a hidden-window browser command for later reused sessions", () => {
    const runner = new OracleRunner();
    const command = (runner as any).buildCommand({
      workspacePath: "/tmp/research",
      prompt: "Plan the next experiment.",
      model: "gpt-5.4-pro",
      browserThinkingTime: "extended",
      outputPath: "/tmp/out.txt",
      slug: "lithium-strategist-d001",
      chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      inlineCookiesPath: "/tmp/lithium-inline-cookies.json",
      launch: {
        browserVisible: false,
        browserHeadless: false,
        keepBrowser: false,
        manualLogin: true,
        strategistSessionReady: true,
        chatgptUrl: "https://chatgpt.com/g/example/project"
      },
      files: ["/tmp/context.md"]
    });

    expect(command.args).toContain("--browser-manual-login");
    expect(command.args).not.toContain("--browser-headless");
    expect(command.args).toContain("--browser-hide-window");
    expect(command.args).not.toContain("--browser-keep-browser");
    expect(command.args).toContain("--browser-attachments");
    expect(command.args).toContain("always");
    expect(command.args).not.toContain("--browser-inline-files");
    expect(command.args).toContain("--browser-model-strategy");
    expect(command.args).toContain("select");
    expect(command.args).toContain("--browser-thinking-time");
    expect(command.args).toContain("extended");
    expect(command.args).toContain("--chatgpt-url");
    expect(command.args).not.toContain("--browser-cookie-path");
    expect(command.args).not.toContain("--browser-inline-cookies-file");
    expect(command.args).toContain("--browser-chrome-path");
  });

  it("can still build a truly headless browser command when explicitly forced", () => {
    const runner = new OracleRunner();
    const command = (runner as any).buildCommand({
      workspacePath: "/tmp/research",
      prompt: "Plan the next experiment.",
      model: "gpt-5.4-pro",
      browserThinkingTime: "extended",
      outputPath: "/tmp/out.txt",
      slug: "lithium-strategist-d001",
      chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      inlineCookiesPath: "/tmp/lithium-inline-cookies.json",
      launch: {
        browserVisible: false,
        browserHeadless: true,
        keepBrowser: false,
        manualLogin: true,
        strategistSessionReady: true,
        chatgptUrl: undefined
      },
      files: ["/tmp/context.md"]
    });

    expect(command.args).toContain("--browser-headless");
    expect(command.args).not.toContain("--browser-hide-window");
    expect(command.args).toContain("--browser-manual-login");
    expect(command.args).toContain("--browser-thinking-time");
    expect(command.args).toContain("extended");
    expect(command.args).not.toContain("--browser-cookie-path");
    expect(command.args).not.toContain("--browser-inline-cookies-file");
  });

  it("builds a visible first-run browser command with manual login", () => {
    const runner = new OracleRunner();
    const command = (runner as any).buildCommand({
      workspacePath: "/tmp/research",
      prompt: "Plan the next experiment.",
      model: "gpt-5.4-pro",
      browserThinkingTime: "extended",
      outputPath: "/tmp/out.txt",
      slug: "lithium-strategist-d001",
      chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      inlineCookiesPath: undefined,
      launch: {
        browserVisible: true,
        browserHeadless: false,
        keepBrowser: true,
        manualLogin: true,
        strategistSessionReady: false,
        chatgptUrl: undefined
      },
      files: ["/tmp/context.md"]
    });

    expect(command.args).toContain("--browser-manual-login");
    expect(command.args).not.toContain("--browser-hide-window");
    expect(command.args).not.toContain("--browser-inline-cookies-file");
    expect(command.args).not.toContain("--browser-cookie-path");
    expect(command.args).toContain("--browser-keep-browser");
    expect(command.args).toContain("--browser-attachments");
    expect(command.args).toContain("always");
    expect(command.args).not.toContain("--browser-inline-files");
  });

  it("uses the local oracle binary directly for browser runs when one is available", () => {
    const runner = new OracleRunner();
    const command = (runner as any).buildCommand({
      workspacePath: "/tmp/research",
      prompt: "Plan the next experiment.",
      model: "gpt-5.4-pro",
      browserThinkingTime: "extended",
      outputPath: "/tmp/out.txt",
      slug: "lithium-strategist-d001",
      oracleCommand: "/tmp/node_modules/.bin/oracle",
      launch: {
        browserVisible: true,
        browserHeadless: false,
        keepBrowser: true,
        manualLogin: true,
        strategistSessionReady: false,
        chatgptUrl: undefined
      },
      files: ["/tmp/context.md"]
    });

    expect(command.command).toBe("/tmp/node_modules/.bin/oracle");
    expect(command.args.slice(0, 4)).toEqual(["--engine", "browser", "--model", "gpt-5.4-pro"]);
    expect(command.args).not.toContain("@steipete/oracle");
    expect(command.args).not.toContain("-y");
  });

  it("keeps strategist prompts close to the original user request", () => {
    const runner = new OracleRunner();
    const prompt = (runner as any).normalizePrompt("Summarize the latest experiment changes.");

    expect(prompt).toBe("Summarize the latest experiment changes.");
    expect(prompt).not.toContain("LITHIUM_HANDOFF");
    expect(prompt).not.toContain("RUNTIME_CONTEXT:");
  });

  it("retries with interactive recovery when a reused browser session has no cookies", () => {
    expect(
      shouldRetryInteractiveSessionRecovery(
        "No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode.",
        {
          browserVisible: false,
          browserHeadless: false,
          keepBrowser: false,
          manualLogin: true,
          strategistSessionReady: true,
          chatgptUrl: undefined
        }
      )
    ).toBe(true);

    expect(
      shouldRetryInteractiveSessionRecovery(
        "No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode.",
        {
          browserVisible: true,
          browserHeadless: false,
          keepBrowser: true,
          manualLogin: true,
          strategistSessionReady: false,
          chatgptUrl: undefined
        }
      )
    ).toBe(false);
  });

  it("classifies stale strategist browser failures for fresh headless recovery", () => {
    expect(
      classifyInteractiveSessionRecovery("connect ECONNREFUSED 127.0.0.1:55510", {
        browserVisible: false,
        browserHeadless: true,
        keepBrowser: false,
        manualLogin: true,
        strategistSessionReady: true,
        chatgptUrl: undefined
      })
    ).toBe("fresh-browser");

    expect(
      classifyInteractiveSessionRecovery("Prompt textarea did not appear before timeout", {
        browserVisible: false,
        browserHeadless: true,
        keepBrowser: false,
        manualLogin: true,
        strategistSessionReady: true,
        chatgptUrl: undefined
      })
    ).toBe("fresh-browser");
  });

  it("classifies truncated strategist outputs for a fresh chat recovery", () => {
    expect(
      classifyInteractiveSessionRecovery("Oracle strategist output looked truncated or non-final: I’m", {
        browserVisible: false,
        browserHeadless: true,
        keepBrowser: false,
        manualLogin: true,
        strategistSessionReady: true,
        chatgptUrl: "https://chatgpt.com/c/example"
      })
    ).toBe("fresh-chat");
  });

  it("cleans up the first manual-login browser after success unless keep-browser is explicitly requested", () => {
    expect(
      shouldCleanupOracleBrowserAfterSuccess(
        {
          browserVisible: true,
          browserHeadless: false,
          keepBrowser: true,
          manualLogin: true,
          strategistSessionReady: false,
          chatgptUrl: undefined
        },
        {}
      )
    ).toBe(true);

    expect(
      shouldCleanupOracleBrowserAfterSuccess(
        {
          browserVisible: true,
          browserHeadless: false,
          keepBrowser: true,
          manualLogin: true,
          strategistSessionReady: false,
          chatgptUrl: undefined
        },
        {
          LITHIUM_ORACLE_KEEP_BROWSER: "1"
        }
      )
    ).toBe(false);

    expect(
      shouldCleanupOracleBrowserAfterSuccess(
        {
          browserVisible: false,
          browserHeadless: false,
          keepBrowser: false,
          manualLogin: true,
          strategistSessionReady: true,
          chatgptUrl: undefined
        },
        {}
      )
    ).toBe(false);
  });

  it("finds only Oracle browser main processes using the dedicated profile", () => {
    const psOutput = [
      `410 ${TESTING_CHROME_PATH} --user-data-dir=${ORACLE_PROFILE_PATH} --remote-debugging-pipe about:blank`,
      `411 ${TESTING_CHROME_PATH} --type=gpu-process --user-data-dir=${ORACLE_PROFILE_PATH}`,
      `612 ${LOCAL_CHROME_PATH} --user-data-dir=${DEFAULT_CHROME_PROFILE}`,
      `720 ${LOCAL_CHROME_PATH} --user-data-dir=${ORACLE_PROFILE_PATH} --remote-debugging-pipe about:blank`
    ].join("\n");

    expect(
      findOracleBrowserPids(psOutput, {
        chromePath: TESTING_CHROME_PATH,
        profilePath: ORACLE_PROFILE_PATH
      })
    ).toEqual([410]);

    expect(
      findOracleBrowserPids(psOutput, {
        chromePath: LOCAL_CHROME_PATH,
        profilePath: ORACLE_PROFILE_PATH
      })
    ).toEqual([720]);
  });

  it("auto-recovers strategist browser reuse by default unless explicitly disabled", () => {
    const launch = {
      browserVisible: false,
      browserHeadless: false,
      keepBrowser: false,
      manualLogin: true,
      strategistSessionReady: true,
      chatgptUrl: undefined
    };

    expect(shouldAutoRecoverInteractiveSession(launch, {})).toBe(true);
    expect(
      shouldAutoRecoverInteractiveSession(launch, {
        LITHIUM_ORACLE_AUTO_RECOVER: "0"
      })
    ).toBe(false);
  });

  it("preserves thread-specific strategist slugs when normalizing session ids", () => {
    expect(normalizeOracleSessionId("ors-strat-autopilotpro-a872a49b-th003")).toBe(
      "ors-strat-autopilotp-a872a49b-th003"
    );
  });
});
