import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppService } from "../src/main/services/app-service.ts";
import { ORACLE_BROWSER_INLINE_COOKIES_PATH } from "../src/main/services/oracle-browser-profile";
import { createInProcessLithiumApi } from "../src/testing/in-process-lithium-api.ts";
import { LithiumAppDriver } from "../src/testing/lithium-app-driver.ts";
import { DEFAULT_APP_SETTINGS } from "../src/shared/types.ts";

type ParsedArgs = {
  workspace: string;
  prompt: string;
  mode: "automation" | "chat";
  steps: number;
  runtimeMinutes: number;
  retries: number;
  timeoutSeconds: number;
  pollMs: number;
  strategistSessionReady: boolean;
  oracleVisible: boolean;
};

const args = await parseArgs(process.argv.slice(2));

if (args.oracleVisible) {
  process.env.LITHIUM_ORACLE_VISIBLE = "1";
}

const workspacePath = path.resolve(args.workspace);
const appService = new AppService(workspacePath);
const api = createInProcessLithiumApi({
  appService,
  settings: {
    ...DEFAULT_APP_SETTINGS,
    strategistSessionReady: args.strategistSessionReady
  }
});
const driver = new LithiumAppDriver(api);

await driver.initProject(workspacePath);

const report = {
  workspacePath,
  mode: args.mode,
  prompt: args.prompt,
  startedAt: new Date().toISOString(),
  strategistSessionReady: args.strategistSessionReady,
  oracleVisible: args.oracleVisible,
  events: [] as Array<Record<string, unknown>>
};
const reportStartedAtMs = Date.parse(report.startedAt);

const seenPromptLogOffsets = new Set<string>();
let lastDecisionId = "";
let lastRunId = "";
let lastAutomationStatus = "";
let lastBuilderProgress = "";
let lastChatProgress = "";
let activeSessionId = "";

if (args.mode === "chat") {
  const snapshot = await driver.sendChat(args.prompt);
  report.events.push({
    type: "chat.sent",
    activeThreadId: snapshot.activeThreadId,
    latestDecisionId: snapshot.latestDecision?.id ?? null,
    latestRunId: snapshot.latestRun?.id ?? null
  });
} else {
  const createdSnapshot = await api.createAutomationSession({
    workspacePath,
    objective: args.prompt,
    mode: "continuous",
    maxSteps: args.steps,
    maxRuntimeMinutes: args.runtimeMinutes,
    maxRetries: args.retries,
    paperWriteEnabled: false
  });
  const sessionId = createdSnapshot.latestAutomationSession?.id;

  if (!sessionId) {
    throw new Error("Automation session could not be created.");
  }
  activeSessionId = sessionId;

  report.events.push({
    type: "automation.created",
    sessionId
  });

  await api.startAutomationSession({
    workspacePath,
    sessionId
  });

  report.events.push({
    type: "automation.started",
    sessionId
  });
}

const deadline = Date.now() + args.timeoutSeconds * 1000;

while (Date.now() < deadline) {
  const snapshot = await driver.refresh();
  const automation = snapshot.latestAutomationSession ?? null;

  if (automation && automation.status !== lastAutomationStatus) {
    lastAutomationStatus = automation.status;
    report.events.push({
      type: "automation.status",
      status: automation.status,
      usedSteps: automation.budget.usedSteps,
      usedRetries: automation.budget.usedRetries,
      summary: automation.currentStepSummary
    });
    printEvent(`automation ${automation.status} · steps ${automation.budget.usedSteps}/${automation.budget.maxSteps}`);
  }

  if (snapshot.latestDecision?.id && snapshot.latestDecision.id !== lastDecisionId) {
    lastDecisionId = snapshot.latestDecision.id;
    report.events.push({
      type: "decision",
      id: snapshot.latestDecision.id,
      summary: snapshot.latestDecision.summary,
      rationale: snapshot.latestDecision.rationale,
      rawOutputPath: snapshot.latestDecision.outputPath
    });
    printEvent(`decision ${snapshot.latestDecision.id}: ${snapshot.latestDecision.summary}`);
  }

  if (snapshot.latestRun?.id && snapshot.latestRun.id !== lastRunId) {
    lastRunId = snapshot.latestRun.id;
    report.events.push({
      type: "run",
      id: snapshot.latestRun.id,
      status: snapshot.latestRun.status,
      prompt: snapshot.latestRun.prompt,
      displayPrompt: snapshot.latestRun.displayPrompt ?? null
    });
    printEvent(`run ${snapshot.latestRun.id}: ${snapshot.latestRun.status}`);
  }

  const chatProgress = await api.inspectChatProgress({
    workspacePath
  });

  if (chatProgress?.progressSummary && chatProgress.progressSummary !== lastChatProgress) {
    lastChatProgress = chatProgress.progressSummary;
    report.events.push({
      type: "chat-progress",
      lane: chatProgress.lane,
      summary: chatProgress.progressSummary,
      details: chatProgress.progressDetails
    });
    printEvent(`chat ${chatProgress.lane}: ${chatProgress.progressSummary}`);
  }

  if (snapshot.latestRun?.id && snapshot.latestRun.status === "running") {
    const inspection = await api.inspectBuilderRun({
      workspacePath,
      runId: snapshot.latestRun.id
    });
    const progressSignature = [
      inspection?.progressSummary ?? "",
      ...(inspection?.progressDetails ?? [])
    ].join(" | ");

    if (progressSignature && progressSignature !== lastBuilderProgress) {
      lastBuilderProgress = progressSignature;
      report.events.push({
        type: "builder-progress",
        runId: snapshot.latestRun.id,
        summary: inspection?.progressSummary ?? "",
        details: inspection?.progressDetails ?? []
      });
      printEvent(`builder ${snapshot.latestRun.id}: ${inspection?.progressSummary ?? "running"}`);
    }
  }

  const promptLogPath = path.join(workspacePath, ".lithium", "prompt-log.jsonl");
  const promptEntries = await readPromptLogEntries(promptLogPath);

  for (const entry of promptEntries) {
    const entryTimestampMs =
      typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;

    if (!Number.isFinite(entryTimestampMs) || entryTimestampMs < reportStartedAtMs) {
      continue;
    }

    const key = `${entry.ts ?? ""}:${entry.kind ?? ""}:${entry.threadId ?? ""}:${entry.runId ?? ""}:${entry.prompt ?? ""}`;

    if (seenPromptLogOffsets.has(key)) {
      continue;
    }

    seenPromptLogOffsets.add(key);
    report.events.push({
      type: "prompt-log",
      entry
    });

    if (typeof entry.kind === "string") {
      printEvent(
        `log ${entry.kind}: ${truncate(
          typeof entry.prompt === "string"
            ? entry.prompt
            : typeof entry.summary === "string"
            ? entry.summary
            : typeof entry.finalMessage === "string"
            ? entry.finalMessage
            : JSON.stringify(entry),
          120
        )}`
      );
    }
  }

  if (!automation || ["awaiting-checkpoint", "paused", "failed", "stopped"].includes(automation.status)) {
    break;
  }

  await sleep(args.pollMs);
}

const finalSnapshot = await driver.refresh();

if (
  activeSessionId &&
  finalSnapshot.latestAutomationSession?.id === activeSessionId &&
  finalSnapshot.latestAutomationSession.status === "running"
) {
  await api.interruptAutomationSession({
    workspacePath,
    sessionId: activeSessionId,
    instruction: "Stop automation and wait for further user direction.",
    stopNow: true
  });
  report.events.push({
    type: "automation.stopped-after-timeout",
    sessionId: activeSessionId
  });
}

const settledSnapshot = await driver.refresh();
report.events.push({
  type: "final-state",
  automationStatus: settledSnapshot.latestAutomationSession?.status ?? null,
  latestDecisionId: settledSnapshot.latestDecision?.id ?? null,
  latestRunId: settledSnapshot.latestRun?.id ?? null,
  latestRunStatus: settledSnapshot.latestRun?.status ?? null
});
report["endedAt"] = new Date().toISOString();

const reportDir = path.join(workspacePath, ".lithium", "probes");
await mkdir(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `${timestampSlug()}.live-probe.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

console.log(`\nreport: ${reportPath}`);

function printEvent(message: string) {
  console.log(`[probe] ${message}`);
}

async function parseArgs(rawArgs: string[]): Promise<ParsedArgs> {
  const parsed: Record<string, string> = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = rawArgs[index + 1];

    if (!value || value.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }

    parsed[key] = value;
    index += 1;
  }

  const workspace = parsed.workspace?.trim() || process.env.LITHIUM_WORKSPACE?.trim() || process.cwd();
  const prompt = parsed.prompt?.trim();

  if (!prompt) {
    throw new Error("Missing --prompt");
  }

  const sessionReadyArg = parsed["session-ready"];
  const strategistSessionReady =
    sessionReadyArg === "1" || sessionReadyArg === "true"
      ? true
      : sessionReadyArg === "0" || sessionReadyArg === "false"
      ? false
      : await hasInlineCookiesFile();

  return {
    workspace,
    prompt,
    mode: parsed.mode === "chat" ? "chat" : "automation",
    steps: clampInteger(parsed.steps, 3, 1, 128),
    runtimeMinutes: clampInteger(parsed["runtime-minutes"], 30, 1, 24 * 60),
    retries: clampInteger(parsed.retries, 4, 0, 64),
    timeoutSeconds: clampInteger(parsed["timeout-seconds"], 180, 10, 24 * 60 * 60),
    pollMs: clampInteger(parsed["poll-ms"], 1500, 200, 30_000),
    strategistSessionReady,
    oracleVisible: parsed.visible === "1" || parsed.visible === "true"
  };
}

async function hasInlineCookiesFile() {
  try {
    await stat(ORACLE_BROWSER_INLINE_COOKIES_PATH);
    return true;
  } catch {
    return false;
  }
}

async function readPromptLogEntries(promptLogPath: string) {
  try {
    const raw = await readFile(promptLogPath, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return {
            kind: "invalid",
            prompt: line
          };
        }
      });
  } catch {
    return [];
  }
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function truncate(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function timestampSlug() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    process.pid
  ].join("");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
