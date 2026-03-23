import { describe, expect, it } from "vitest";
import {
  collectOracleChromeProcesses,
  parseMacAppProcessOutput,
  summarizeProbeSamples
} from "./strategist-browser-probe";

const ORACLE_PROFILE_PATH = "/tmp/lithium-fixtures/oracle/browser-profile";
const LOCAL_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_CHROME_PROFILE = "/tmp/lithium-fixtures/google-chrome-default";

describe("Strategist browser probe helpers", () => {
  it("collects Oracle Chrome root and helper processes for the dedicated profile", () => {
    const psOutput = [
      `39094 ${LOCAL_CHROME_PATH} --user-data-dir=${ORACLE_PROFILE_PATH} --remote-debugging-pipe about:blank`,
      `39104 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/145.0.7632.6/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process --user-data-dir=${ORACLE_PROFILE_PATH}`,
      `40200 ${LOCAL_CHROME_PATH} --user-data-dir=${DEFAULT_CHROME_PROFILE}`
    ].join("\n");

    expect(
      collectOracleChromeProcesses(psOutput, {
        chromePath: LOCAL_CHROME_PATH,
        profilePath: ORACLE_PROFILE_PATH
      })
    ).toEqual([
      {
        pid: 39094,
        command: `${LOCAL_CHROME_PATH} --user-data-dir=${ORACLE_PROFILE_PATH} --remote-debugging-pipe about:blank`,
        isRoot: true
      },
      {
        pid: 39104,
        command:
          `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/145.0.7632.6/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process --user-data-dir=${ORACLE_PROFILE_PATH}`,
        isRoot: false
      }
    ]);
  });

  it("parses mac application process rows from osascript output", () => {
    expect(
      parseMacAppProcessOutput([
        "39094|Google Chrome|false|false|0",
        "39095|Google Chrome for Testing|true|true|1"
      ].join("\n"))
    ).toEqual([
      {
        pid: 39094,
        name: "Google Chrome",
        visible: false,
        frontmost: false,
        windowCount: 0
      },
      {
        pid: 39095,
        name: "Google Chrome for Testing",
        visible: true,
        frontmost: true,
        windowCount: 1
      }
    ]);
  });

  it("summarizes whether the probe ever saw visible, frontmost, or headless browser activity", () => {
    expect(
      summarizeProbeSamples([
        {
          timestamp: "2026-03-20T00:00:00.000Z",
          rootPids: [],
          rootCommands: [],
          sawHeadlessFlag: false,
          applications: []
        },
        {
          timestamp: "2026-03-20T00:00:01.000Z",
          rootPids: [39094],
          rootCommands: ["chrome --headless=new"],
          sawHeadlessFlag: true,
          applications: [
            {
              pid: 39094,
              name: "Google Chrome",
              visible: true,
              frontmost: false,
              windowCount: 1
            }
          ]
        }
      ])
    ).toEqual({
      observedBrowserProcess: true,
      observedHeadlessProcess: true,
      observedVisibleWindow: true,
      observedFrontmostWindow: false
    });
  });
});
