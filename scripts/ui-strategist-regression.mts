import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type Page } from "playwright-core";
import CDP from "chrome-remote-interface";

type PromptLogEntry = {
  kind?: string;
  prompt?: string;
  displayPrompt?: string;
  oracleSessionSlug?: string;
  threadId?: string;
};

type ProbeResult = {
  workspacePath: string;
  threadId: string | null;
  firstSlug: string | null;
  secondSlug: string | null;
  pendingPreviewSamples: string[];
  oraclePreviewSamples: string[];
  firstChatPromptVisible: boolean;
  secondChatPromptVisible: boolean | null;
  secondRequestFound: boolean;
  secondResponseFound: boolean;
  conversationUrl: string | null;
  firstConversationUrl: string | null;
  secondConversationUrl: string | null;
  reusedConversation: boolean | null;
};

const strategistResponseTimeoutMs = Number.parseInt(
  process.env.LITHIUM_UI_PROBE_RESPONSE_TIMEOUT_MS ?? "600000",
  10
);

async function main() {
  const workspacePath = await createWorkspace();
  const appName = `Lithium UI Probe ${Date.now()}`;
  const artifactDir = path.join(workspacePath, ".probe-artifacts");
  await mkdir(artifactDir, { recursive: true });
  const electronApp = await electron.launch({
    args: [path.join(process.cwd(), "dist-electron/index.cjs")],
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173",
      LITHIUM_APP_NAME: appName,
      LITHIUM_WORKSPACE: workspacePath
    }
  });

  try {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("textarea.composer-input", { timeout: 30_000 });
    console.log(`[probe] launched app ${appName}`);

    await page.evaluate(async (targetWorkspacePath) => {
      await window.lithium.updateAppSettings({
        strategistSessionReady: true,
        onboardingDismissed: true
      });
      await window.lithium.initProject(targetWorkspacePath);
    }, workspacePath);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("textarea.composer-input", { timeout: 30_000 });
    await page.waitForTimeout(800);
    const bootState = await page.evaluate(async (targetWorkspacePath) => {
      const appState = await window.lithium.getAppState();
      const snapshot = await window.lithium.getProjectSnapshot(targetWorkspacePath);
      return {
        selectedWorkspacePath: appState.selectedWorkspacePath,
        threadCount: snapshot.threads.length,
        activeThreadId: snapshot.activeThreadId,
        latestAutomationStatus: snapshot.latestAutomationSession?.status ?? "idle"
      };
    }, workspacePath);
    console.log("[probe] boot state", bootState);
    console.log(`[probe] initialized workspace ${workspacePath}`);

    const firstPrompt =
      process.env.LITHIUM_UI_PROBE_FIRST_PROMPT?.trim() ||
      process.env.LITHIUM_UI_PROBE_PROMPT?.trim() ||
      "/research 현재 저장소를 기준으로 README를 보고, 다음 연구 질문 1개만 짧게 제안해줘.";
    const secondPrompt =
      process.env.LITHIUM_UI_PROBE_SECOND_PROMPT?.trim() ||
      process.env.LITHIUM_UI_PROBE_FOLLOWUP?.trim() ||
      "/research 방금 이어서, 같은 저장소 맥락으로 연구 질문 1개만 더 제안해줘.";

    await sendPrompt(page, firstPrompt);
    console.log("[probe] sent first prompt via UI");
    const pendingPreviewSamples = await collectPendingPreview(page, 120_000);
    console.log("[probe] pending preview samples", pendingPreviewSamples);
    const firstChatPromptVisible = await waitForPromptLogPrompt(workspacePath, firstPrompt, 120_000);
    console.log("[probe] first strategist request logged", firstChatPromptVisible);
    const firstLoggedSlug = await waitForLatestStrategistSlug(workspacePath, 120_000);
    const firstSlug = firstLoggedSlug ? await resolveLatestOracleSessionSlug(firstLoggedSlug) : null;
    const threadId = await readLatestThreadId(workspacePath);
    const firstChatState = firstSlug ? await inspectChatGptConversation(firstSlug, firstPrompt).catch(() => null) : null;
    console.log("[probe] first strategist session", { firstSlug, threadId, firstChatState });
    const firstResponseLogged = await waitForStrategistResponse(workspacePath, strategistResponseTimeoutMs);
    console.log("[probe] first strategist response logged", firstResponseLogged);
    const firstMeta = firstSlug ? await readSessionMeta(firstSlug) : null;
    const oraclePreviewSamples = firstSlug ? await collectOraclePreviewSamples(firstSlug) : [];

    if (!firstResponseLogged) {
      throw new Error("first strategist response did not finish within probe timeout");
    }

    await sendPrompt(page, secondPrompt);
    console.log("[probe] sent second prompt via UI");

    const secondRequest = await waitForSecondStrategistRequest(workspacePath, firstPrompt, secondPrompt, 180_000);
    const secondSlug = secondRequest?.oracleSessionSlug
      ? await resolveLatestOracleSessionSlug(secondRequest.oracleSessionSlug)
      : null;
    const secondChatState = secondSlug ? await inspectChatGptConversation(secondSlug, secondPrompt).catch(() => null) : null;
    const secondResponseFound = await waitForStrategistResponseForPrompt(
      workspacePath,
      secondPrompt,
      strategistResponseTimeoutMs
    );
    const secondMeta = secondSlug ? await readSessionMeta(secondSlug) : null;
    console.log("[probe] second strategist session", { secondRequest, secondChatState });

    const result: ProbeResult = {
      workspacePath,
      threadId,
      firstSlug,
      secondSlug,
      pendingPreviewSamples,
      oraclePreviewSamples,
      firstChatPromptVisible: firstChatState?.promptVisible ?? false,
      secondChatPromptVisible: secondChatState?.promptVisible ?? null,
      secondRequestFound: Boolean(secondRequest),
      secondResponseFound,
      conversationUrl:
        secondChatState?.url ??
        secondMeta?.configUrl ??
        secondMeta?.runtime?.tabUrl ??
        firstChatState?.url ??
        firstMeta?.configUrl ??
        firstMeta?.runtime?.tabUrl ??
        null,
      firstConversationUrl: firstMeta?.runtime?.tabUrl ?? firstMeta?.configUrl ?? firstChatState?.url ?? null,
      secondConversationUrl: secondMeta?.runtime?.tabUrl ?? secondMeta?.configUrl ?? secondChatState?.url ?? null,
      reusedConversation:
        (firstMeta?.runtime?.tabUrl ?? firstMeta?.configUrl) &&
        (secondMeta?.runtime?.tabUrl ?? secondMeta?.configUrl)
          ? (firstMeta?.runtime?.tabUrl ?? firstMeta?.configUrl) ===
            (secondMeta?.runtime?.tabUrl ?? secondMeta?.configUrl)
          : null
    };

    console.log(JSON.stringify(result, null, 2));

    if (!result.secondRequestFound || !result.secondResponseFound) {
      throw new Error("strategist reuse probe did not complete the second strategist turn");
    }
  } catch (error) {
    try {
      const page = (await electronApp.windows())[0];
      await page.screenshot({ path: path.join(artifactDir, "failure.png"), fullPage: true });
      await writeFile(
        path.join(artifactDir, "failure.html"),
        await page.content(),
        "utf8"
      );
      console.error(`[probe] saved failure artifacts under ${artifactDir}`);
    } catch {
      // Ignore artifact failures.
    }
    throw error;
  } finally {
    await electronApp.close().catch(() => undefined);
    if (process.env.LITHIUM_KEEP_UI_PROBE_WORKSPACE !== "1") {
      await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.error(`[probe] kept workspace at ${workspacePath}`);
    }
  }
}

async function createWorkspace() {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-ui-probe-"));
  await mkdir(path.join(workspacePath, "paper", "sections"), { recursive: true });
  await mkdir(path.join(workspacePath, "examples"), { recursive: true });
  await writeFile(
    path.join(workspacePath, "README.md"),
    "# UI Strategist Probe\n\nThis workspace exercises strategist preview and reuse.\n",
    "utf8"
  );
  await writeFile(path.join(workspacePath, "examples", "train_probe.py"), "print('probe')\n", "utf8");
  await writeFile(
    path.join(workspacePath, "paper", "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nProbe\n\\end{document}\n",
    "utf8"
  );
  return workspacePath;
}

async function sendPrompt(page: Page, prompt: string) {
  const textarea = page.locator("textarea.composer-input");

  await textarea.click();
  await textarea.fill(prompt);
  await page.waitForTimeout(250);
  const currentValue = await textarea.inputValue();

  if (currentValue.trim() !== prompt.trim()) {
    throw new Error(`composer value mismatch before send: ${JSON.stringify(currentValue)}`);
  }

  await textarea.press("Enter");
  await page.waitForTimeout(600);
  const domSummary = await page.evaluate(() => ({
    userMessages: Array.from(document.querySelectorAll(".message.user .message-body")).map((node) =>
      (node.textContent || "").trim()
    ),
    pendingMessages: Array.from(document.querySelectorAll(".message.assistant.pending .message-body")).map((node) =>
      (node.textContent || "").trim()
    ),
    pageText: document.body.innerText.slice(0, 1200)
  }));
  console.log("[probe] post-send dom summary", domSummary);
}

async function collectPendingPreview(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const samples: string[] = [];

  while (Date.now() < deadline) {
    const text = await page
      .locator(".message.assistant.pending .message-body")
      .last()
      .textContent()
      .catch(() => null);
    const normalized = (text ?? "").replace(/\s+/g, " ").trim();

    if (normalized && !samples.includes(normalized)) {
      samples.push(normalized);
    }

    if (normalized && !isGenericPendingPreview(normalized)) {
      return samples;
    }

    await page.waitForTimeout(1200);
  }

  return samples;
}

function isGenericPendingPreview(value: string) {
  const normalized = value.trim().toLowerCase();

  return (
    !normalized ||
    /^(thinking|thinking…|reading documents?|reading document|heavy thinking|processing|analyzing)$/i.test(
      normalized
    )
  );
}

async function waitForPromptLogPrompt(workspacePath: string, prompt: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readPromptLog(workspacePath);
    if (entries.some((entry) => entry.kind === "strategist.request" && promptLogEntryMatchesPrompt(entry, prompt))) {
      return true;
    }
    await sleep(1500);
  }

  return false;
}

async function waitForLatestStrategistSlug(workspacePath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readPromptLog(workspacePath);
    const latest = [...entries].reverse().find((entry) => entry.kind === "strategist.request");
    if (latest?.oracleSessionSlug) {
      return latest.oracleSessionSlug;
    }
    await sleep(1500);
  }

  return null;
}

async function readLatestThreadId(workspacePath: string) {
  const entries = await readPromptLog(workspacePath);
  return [...entries].reverse().find((entry) => entry.kind === "strategist.request")?.threadId ?? null;
}

async function waitForSecondStrategistRequest(
  workspacePath: string,
  firstPrompt: string,
  secondPrompt: string,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readPromptLog(workspacePath);
    const second = entries.find(
      (entry) => entry.kind === "strategist.request" && promptLogEntryMatchesPrompt(entry, secondPrompt)
    );

    if (second) {
      return second;
    }

    const staleRepeat = entries.filter(
      (entry) => entry.kind === "strategist.request" && promptLogEntryMatchesPrompt(entry, firstPrompt)
    );

    if (staleRepeat.length > 1) {
      return null;
    }

    await sleep(2000);
  }

  return null;
}

async function waitForStrategistResponse(workspacePath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readPromptLog(workspacePath);

    if (entries.some((entry) => entry.kind === "strategist.response")) {
      return true;
    }

    await sleep(2000);
  }

  return false;
}

async function waitForStrategistResponseForPrompt(
  workspacePath: string,
  prompt: string,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readPromptLog(workspacePath);
    const matchingRequest = [...entries]
      .reverse()
      .find((entry) => entry.kind === "strategist.request" && promptLogEntryMatchesPrompt(entry, prompt));

    if (!matchingRequest?.threadId) {
      await sleep(2000);
      continue;
    }

    const matchingResponse = [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.kind === "strategist.response" &&
          entry.threadId === matchingRequest.threadId
      );

    if (matchingResponse) {
      return true;
    }

    await sleep(2000);
  }

  return false;
}

async function readPromptLog(workspacePath: string) {
  const promptLogPath = path.join(workspacePath, ".lithium", "prompt-log.jsonl");
  const raw = await readFile(promptLogPath, "utf8").catch(() => "");

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PromptLogEntry);
}

async function inspectChatGptConversation(sessionSlug: string, expectedPrompt: string) {
  const metadata = await readSessionMeta(sessionSlug);
  const runtime = metadata?.runtime;

  if (!runtime) {
    return null;
  }
  const host = runtime?.chromeHost || "127.0.0.1";
  const port = Number(runtime?.chromePort ?? 0);

  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }

  const targets = (await CDP.List({ host, port })) as Array<{ id?: string; url?: string }>;
  const target =
    targets.find((entry) => entry.id === runtime?.chromeTargetId) ||
    targets.find((entry) => entry.url === runtime?.tabUrl) ||
    targets.find((entry) => /chatgpt\.com\/c\//.test(entry.url ?? "")) ||
    targets.find((entry) => /chatgpt\.com/.test(entry.url ?? ""));

  if (!target) {
    return null;
  }

  const client = await CDP({ host, port, target });

  try {
    const evaluation = await client.Runtime.evaluate({
      expression: `(() => {
        const text = document.body.innerText || "";
        return {
          url: location.href,
          text,
          hasRuntimeFile: text.includes(".strategist.runtime.md"),
          hasExpectedPrompt: text.includes(${JSON.stringify(expectedPrompt)})
        };
      })()`,
      returnByValue: true
    });
    const value = evaluation.result?.value as {
      url?: string;
      text?: string;
      hasRuntimeFile?: boolean;
      hasExpectedPrompt?: boolean;
    };

    return {
      url: value?.url ?? null,
      promptVisible: Boolean(value?.hasExpectedPrompt),
      runtimeFileVisible: Boolean(value?.hasRuntimeFile),
      textSample: (value?.text ?? "").slice(0, 1000)
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function readSessionMeta(sessionSlug: string) {
  const metadataPath = path.join(os.homedir(), ".oracle", "sessions", sessionSlug, "meta.json");
  const raw = await readFile(metadataPath, "utf8").catch(() => "");

  if (!raw.trim()) {
    return null;
  }

  const metadata = JSON.parse(raw) as {
    browser?: {
      config?: {
        url?: string;
      };
      runtime?: {
        chromeHost?: string;
        chromePort?: number;
        chromeTargetId?: string;
        tabUrl?: string;
        conversationId?: string;
      };
    };
  };

  return {
    configUrl: metadata.browser?.config?.url ?? null,
    runtime: metadata.browser?.runtime ?? null
  };
}

async function collectOraclePreviewSamples(sessionSlug: string) {
  const outputPath = path.join(os.homedir(), ".oracle", "sessions", sessionSlug, "output.log");
  const raw = await readFile(outputPath, "utf8").catch(() => "");
  const values = new Set<string>();

  for (const line of raw.split("\n")) {
    const previewMatch = line.match(/^\[assistant-preview\]\s*(.+)$/);
    if (previewMatch?.[1]) {
      values.add(previewMatch[1].trim());
      continue;
    }

    const thinkingMatch = line.match(/^\d+%\s+\[[^\]]+\]\s+—\s+(.+)$/);
    if (thinkingMatch?.[1]) {
      values.add(thinkingMatch[1].trim());
    }
  }

  return [...values];
}

async function resolveLatestOracleSessionSlug(sessionSlug: string) {
  const sessionsDir = path.join(os.homedir(), ".oracle", "sessions");
  const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name === sessionSlug || entry.name.startsWith(`${sessionSlug}-`))
      .map(async (entry) => {
        const metadataPath = path.join(sessionsDir, entry.name, "meta.json");
        const metadata = await stat(metadataPath).catch(() => null);

        if (!metadata) {
          return null;
        }

        return {
          sessionSlug: entry.name,
          modifiedAt: metadata.mtimeMs
        };
      })
  );

  return (
    candidates
      .filter((entry): entry is { sessionSlug: string; modifiedAt: number } => Boolean(entry))
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.sessionSlug ?? sessionSlug
  );
}

function promptLogEntryMatchesPrompt(entry: PromptLogEntry, prompt: string) {
  const normalizedPrompt = prompt.trim();
  return entry.prompt?.trim() === normalizedPrompt || entry.displayPrompt?.trim() === normalizedPrompt;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
