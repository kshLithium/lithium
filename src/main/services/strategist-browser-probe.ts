import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  OracleModel,
  OracleThinkingTime,
  StrategistBrowserProbeAppObservation,
  StrategistBrowserProbeLaunch,
  StrategistBrowserProbeReport,
  StrategistBrowserProbeSample
} from "../../shared/types";
import { detectChromePath } from "./chrome-detection";
import { ORACLE_BROWSER_PROFILE_PATH } from "./oracle-browser-profile";
import { resolveOracleLaunchOptions } from "./oracle-runner";

const SAMPLE_INTERVAL_MS = 200;

type ProbeMonitorInput = {
  workspacePath: string;
  prompt: string;
  model: OracleModel;
  reasoningIntensity: OracleThinkingTime;
  strategistSessionReady: boolean;
};

type OracleChromeProcess = {
  pid: number;
  command: string;
  isRoot: boolean;
};

type PsEntry = {
  pid: number;
  command: string;
};

export async function startStrategistBrowserProbeMonitor(input: ProbeMonitorInput) {
  const launch = toProbeLaunch(input.strategistSessionReady);
  const chromePath = launch.engine === "browser" ? (await detectChromePath()) ?? null : null;
  const startedAt = new Date().toISOString();
  const samples: StrategistBrowserProbeSample[] = [];
  let stopped = false;

  const loop = (async () => {
    while (!stopped) {
      samples.push(await sampleStrategistBrowserState(chromePath));

      if (stopped) {
        break;
      }

      await sleep(SAMPLE_INTERVAL_MS);
    }
  })();

  return {
    async stop(options: { error?: string } = {}): Promise<StrategistBrowserProbeReport> {
      stopped = true;
      await loop;

      const finalSample = await sampleStrategistBrowserState(chromePath);
      const shouldAppendFinalSample =
        samples.length === 0 ||
        finalSample.rootPids.length > 0 ||
        finalSample.applications.length > 0 ||
        finalSample.sawHeadlessFlag;

      if (shouldAppendFinalSample) {
        samples.push(finalSample);
      }

      const endedAt = new Date().toISOString();
      const summary = summarizeProbeSamples(samples);
      const reportPath = buildProbeReportPath(input.workspacePath, startedAt, input.model, input.reasoningIntensity);
      const report: StrategistBrowserProbeReport = {
        workspacePath: input.workspacePath,
        prompt: input.prompt,
        model: input.model,
        reasoningIntensity: input.reasoningIntensity,
        strategistSessionReady: input.strategistSessionReady,
        launch,
        chromePath,
        startedAt,
        endedAt,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        sampleCount: samples.length,
        observedBrowserProcess: summary.observedBrowserProcess,
        observedHeadlessProcess: summary.observedHeadlessProcess,
        observedVisibleWindow: summary.observedVisibleWindow,
        observedFrontmostWindow: summary.observedFrontmostWindow,
        reportPath,
        error: options.error,
        samples
      };

      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
      return report;
    }
  };
}

export function collectOracleChromeProcesses(
  psOutput: string,
  input: {
    chromePath: string | null;
    profilePath: string;
  }
) {
  const profileFlag = `--user-data-dir=${input.profilePath}`;
  const chromeLabel = input.chromePath ? path.basename(input.chromePath).replace(/\s+/g, " ") : null;

  return parsePsOutput(psOutput)
    .filter((entry) => {
      if (!entry.command.includes(profileFlag)) {
        return false;
      }

      if (!chromeLabel) {
        return /chrome|chromium/i.test(entry.command);
      }

      return (
        entry.command.includes(chromeLabel) ||
        entry.command.includes("Google Chrome for Testing Helper") ||
        entry.command.includes("Google Chrome Helper") ||
        entry.command.includes("Chromium Helper")
      );
    })
    .map((entry) => ({
      ...entry,
      isRoot: !entry.command.includes("--type=")
    })) satisfies OracleChromeProcess[];
}

export function parseMacAppProcessOutput(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [pidText, name, visibleText, frontmostText, windowCountText] = line.split("|");
      const pid = Number.parseInt(pidText ?? "", 10);
      const windowCount = Number.parseInt(windowCountText ?? "", 10);

      if (!Number.isFinite(pid) || !name) {
        return [];
      }

      return [
        {
          pid,
          name,
          visible: visibleText === "true",
          frontmost: frontmostText === "true",
          windowCount: Number.isFinite(windowCount) ? windowCount : 0
        }
      ] satisfies StrategistBrowserProbeAppObservation[];
    });
}

export function summarizeProbeSamples(samples: StrategistBrowserProbeSample[]) {
  return {
    observedBrowserProcess: samples.some((sample) => sample.rootPids.length > 0),
    observedHeadlessProcess: samples.some((sample) => sample.sawHeadlessFlag),
    observedVisibleWindow: samples.some((sample) => sample.applications.some((app) => app.visible)),
    observedFrontmostWindow: samples.some((sample) => sample.applications.some((app) => app.frontmost))
  };
}

async function sampleStrategistBrowserState(chromePath: string | null): Promise<StrategistBrowserProbeSample> {
  const timestamp = new Date().toISOString();

  if (!chromePath) {
    return {
      timestamp,
      rootPids: [],
      rootCommands: [],
      sawHeadlessFlag: false,
      applications: []
    };
  }

  try {
    const psOutput = await execFileText("ps", ["axww", "-o", "pid=,command="]);
    const processes = collectOracleChromeProcesses(psOutput, {
      chromePath,
      profilePath: ORACLE_BROWSER_PROFILE_PATH
    });
    const rootProcesses = processes.filter((process) => process.isRoot);
    const applications = await inspectMacApplicationProcesses(rootProcesses.map((process) => process.pid));

    return {
      timestamp,
      rootPids: rootProcesses.map((process) => process.pid),
      rootCommands: rootProcesses.map((process) => process.command),
      sawHeadlessFlag: processes.some((process) => /--headless(?:=|$)/.test(process.command)),
      applications
    };
  } catch {
    return {
      timestamp,
      rootPids: [],
      rootCommands: [],
      sawHeadlessFlag: false,
      applications: []
    };
  }
}

async function inspectMacApplicationProcesses(pids: number[]) {
  if (process.platform !== "darwin" || pids.length === 0) {
    return [];
  }

  const uniquePids = Array.from(new Set(pids.filter((pid) => Number.isFinite(pid))));

  if (uniquePids.length === 0) {
    return [];
  }

  const script = [
    `set targetPids to {${uniquePids.join(", ")}}`,
    'tell application "System Events"',
    "set outputRows to {}",
    "repeat with targetPid in targetPids",
    "try",
    "set proc to first application process whose unix id is targetPid",
    'set end of outputRows to (unix id of proc as text) & "|" & (name of proc as text) & "|" & (visible of proc as text) & "|" & (frontmost of proc as text) & "|" & ((count of windows of proc) as text)',
    "end try",
    "end repeat",
    "set AppleScript's text item delimiters to linefeed",
    "return outputRows as text",
    "end tell"
  ];

  try {
    const output = await execFileText(
      "osascript",
      script.flatMap((line) => ["-e", line])
    );
    return parseMacAppProcessOutput(output);
  } catch {
    return [];
  }
}

function parsePsOutput(psOutput: string): PsEntry[] {
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

      if (!Number.isFinite(pid)) {
        return [];
      }

      return [
        {
          pid,
          command: match[2]
        }
      ] satisfies PsEntry[];
    });
}

function toProbeLaunch(strategistSessionReady: boolean): StrategistBrowserProbeLaunch {
  return resolveOracleLaunchOptions(process.env, {
    strategistSessionReady
  });
}

function buildProbeReportPath(
  workspacePath: string,
  startedAt: string,
  model: OracleModel,
  reasoningIntensity: OracleThinkingTime
) {
  const stamp = startedAt.replaceAll(":", "-").replaceAll(".", "-");
  return path.join(
    workspacePath,
    ".lithium",
    "diagnostics",
    `strategist-browser-probe-${stamp}-${model}-${reasoningIntensity}.json`
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
