import { stat } from "node:fs/promises";
import { AppService } from "../src/main/services/app-service";
import { ORACLE_BROWSER_INLINE_COOKIES_PATH } from "../src/main/services/oracle-browser-profile";

type ProbeModel = "gpt-5.4" | "gpt-5.4-pro";
type ProbeThinking = "heavy" | "extended";

const args = parseArgs(process.argv.slice(2));
const workspacePath = args.workspace ?? process.cwd();
const model = (args.model as ProbeModel | undefined) ?? "gpt-5.4";
const reasoningIntensity = normalizeThinking(
  model,
  (args.reasoning as ProbeThinking | undefined) ?? undefined
);
const strategistSessionReady =
  args["session-ready"] === "0" || args["session-ready"] === "false"
    ? false
    : args["session-ready"] === "1" || args["session-ready"] === "true"
    ? true
    : await hasInlineCookiesFile();
const prompt =
  args.prompt ??
  "Reply with one short sentence confirming that the strategist browser visibility probe is live.";

const app = new AppService(workspacePath);
const response = await app.runStrategistBrowserProbe({
  workspacePath,
  prompt,
  model,
  reasoningIntensity
}, {
  strategistSessionReady
});

console.log(`workspace: ${response.probe.workspacePath}`);
console.log(`model: ${response.probe.model}`);
console.log(`thinking: ${response.probe.reasoningIntensity}`);
console.log(`session_ready: ${strategistSessionReady ? "yes" : "no"}`);
console.log(
  `launch: ${response.probe.launch.engine} / ${response.probe.launch.browserHeadless ? "headless" : response.probe.launch.browserVisible ? "visible" : "hidden"}`
);
console.log(`visible_window: ${response.probe.observedVisibleWindow ? "yes" : "no"}`);
console.log(`frontmost_window: ${response.probe.observedFrontmostWindow ? "yes" : "no"}`);
console.log(`headless_process: ${response.probe.observedHeadlessProcess ? "yes" : "no"}`);
console.log(`samples: ${response.probe.sampleCount}`);
console.log(`report: ${response.probe.reportPath}`);

if (response.error) {
  console.error(`error: ${response.error}`);
  process.exitCode = 1;
} else if (response.snapshot.latestDecision) {
  console.log(`summary: ${response.snapshot.latestDecision.summary}`);
}

function parseArgs(rawArgs: string[]) {
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

  return parsed;
}

function normalizeThinking(model: ProbeModel, value?: ProbeThinking): ProbeThinking {
  if (model === "gpt-5.4-pro") {
    return value === "extended" ? value : "extended";
  }

  return value === "extended" ? value : "heavy";
}

async function hasInlineCookiesFile() {
  try {
    await stat(ORACLE_BROWSER_INLINE_COOKIES_PATH);
    return true;
  } catch {
    return false;
  }
}
