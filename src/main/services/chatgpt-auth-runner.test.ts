import { describe, expect, it } from "vitest";
import {
  buildChatgptProbeArgs,
  buildChatgptLoginArgs,
  hasChatgptAuthMetadata,
  hasChatgptFirstPartyAuthMetadata,
  hasReusableChatgptSession,
  hasChatgptSessionCookies,
  listOracleChromePids
} from "./chatgpt-auth-runner";

const ORACLE_PROFILE_PATH = "/tmp/lithium-fixtures/oracle/browser-profile";
const PLAYWRIGHT_CHROME_PATH =
  "/tmp/lithium-fixtures/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const CHROME_PROFILE_PATH = "/tmp/lithium-fixtures/google-chrome-default";

describe("ChatgptAuthRunner helpers", () => {
  it("builds a dedicated login launch command without any model prompt", () => {
    expect(
      buildChatgptLoginArgs({
        port: 9222,
        profilePath: ORACLE_PROFILE_PATH
      })
    ).toEqual([
      `--user-data-dir=${ORACLE_PROFILE_PATH}`,
      "--remote-debugging-port=9222",
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "--password-store=basic",
      "--use-mock-keychain",
      "https://chatgpt.com/auth/login"
    ]);
  });

  it("builds a headless probe command for rehydrating the saved strategist session", () => {
    expect(
      buildChatgptProbeArgs({
        port: 9223,
        profilePath: ORACLE_PROFILE_PATH,
        url: "https://chatgpt.com/"
      })
    ).toEqual([
      `--user-data-dir=${ORACLE_PROFILE_PATH}`,
      "--remote-debugging-port=9223",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
      "--headless=new",
      "--disable-gpu",
      "https://chatgpt.com/"
    ]);
  });

  it("recognizes real ChatGPT session cookies but ignores pre-login noise", () => {
    expect(
      hasChatgptSessionCookies([
        { domain: "chatgpt.com", name: "__Host-next-auth.csrf-token" },
        { domain: "chatgpt.com", name: "__Secure-next-auth.callback-url" },
        { domain: ".auth.openai.com", name: "oai-client-auth-info" }
      ])
    ).toBe(false);

    expect(
      hasChatgptSessionCookies([
        { domain: ".chatgpt.com", name: "__Secure-next-auth.session-token" }
      ])
    ).toBe(true);

    expect(
      hasChatgptSessionCookies([
        { domain: "chatgpt.com", name: "__Secure-next-auth.session-token.0" }
      ])
    ).toBe(true);

    expect(
      hasChatgptSessionCookies([
        { domain: "chatgpt.com", name: "oai-client-auth-info" }
      ])
    ).toBe(false);

    expect(
      hasChatgptSessionCookies([
        { domain: ".auth.openai.com", name: "oai-client-auth-info" }
      ])
    ).toBe(false);
  });

  it("requires both session cookies and auth metadata before treating the strategist session as reusable", () => {
    const partial = [
      { domain: ".chatgpt.com", name: "__Secure-next-auth.session-token.0" },
      { domain: ".chatgpt.com", name: "__Secure-next-auth.session-token.1" }
    ];

    expect(hasChatgptAuthMetadata(partial)).toBe(false);
    expect(hasReusableChatgptSession(partial)).toBe(false);

    const complete = [
      ...partial,
      { domain: ".auth.openai.com", name: "oai-client-auth-session" },
      { domain: "chatgpt.com", name: "oai-client-auth-info" }
    ];

    expect(hasChatgptFirstPartyAuthMetadata(complete)).toBe(true);
    expect(hasChatgptAuthMetadata(complete)).toBe(true);
    expect(hasReusableChatgptSession(complete)).toBe(true);
  });

  it("finds all Chrome processes using the dedicated Oracle profile", () => {
    const psOutput = [
      `39094 ${PLAYWRIGHT_CHROME_PATH} --user-data-dir=${ORACLE_PROFILE_PATH} --remote-debugging-port=50826 https://chatgpt.com/auth/login`,
      "39104 /tmp/lithium-fixtures/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/145.0.7632.6/Helpers/Google Chrome for Testing Helper.app/Contents/MacOS/Google Chrome for Testing Helper --type=gpu-process --user-data-dir=/tmp/lithium-fixtures/oracle/browser-profile",
      "39108 /tmp/lithium-fixtures/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/145.0.7632.6/Helpers/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer) --type=renderer --user-data-dir=/tmp/lithium-fixtures/oracle/browser-profile",
      `40200 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${CHROME_PROFILE_PATH}`
    ].join("\n");

    expect(
      listOracleChromePids(psOutput, {
        chromePath: PLAYWRIGHT_CHROME_PATH,
        profilePath: ORACLE_PROFILE_PATH
      })
    ).toEqual([39094, 39104, 39108]);
  });
});
