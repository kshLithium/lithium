import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type Page } from "playwright-core";
import { ProjectStore } from "../src/main/services/project-store.ts";
import type { ConversationEntryRecord } from "../src/shared/types.ts";

const APP_WIDTH = 1512;
const APP_HEIGHT = 980;

async function main() {
  const workspacePath = await createCaptureWorkspace();
  const appName = `Lithium Readme Capture ${Date.now()}`;
  const outputDir = path.join(process.cwd(), "docs", "readme");
  await mkdir(outputDir, { recursive: true });

  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      LITHIUM_APP_NAME: appName,
      LITHIUM_WORKSPACE: workspacePath,
      VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL?.trim() || undefined
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );

  const electronApp = await electron.launch({
    args: [path.join(process.cwd(), "dist-electron", "index.cjs")],
    env
  });

  try {
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: APP_WIDTH, height: APP_HEIGHT });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("textarea.composer-input", { timeout: 30_000 });
    await page.waitForTimeout(1200);
    await ensureLatestMessageVisible(page);
    await page.screenshot({
      path: path.join(outputDir, "hero-chat.png")
    });
  } finally {
    await electronApp.close().catch(() => undefined);
    if (process.env.LITHIUM_KEEP_README_CAPTURE_WORKSPACE !== "1") {
      await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function ensureLatestMessageVisible(page: Page) {
  const scroller = page.locator(".chat-scroll");
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(200);
}

async function createCaptureWorkspace() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lithium-readme-"));
  const workspacePath = path.join(tempRoot, "demo-loop");

  await mkdir(path.join(workspacePath, "src"), { recursive: true });
  await mkdir(path.join(workspacePath, "notes"), { recursive: true });
  await mkdir(path.join(workspacePath, "results"), { recursive: true });
  await mkdir(path.join(workspacePath, "experiments"), { recursive: true });

  await Promise.all([
    writeFile(
      path.join(workspacePath, "README.md"),
      ["# demo-loop", "", "Small local workspace for the Lithium README capture.", ""].join("\n"),
      "utf8"
    ),
    writeFile(
      path.join(workspacePath, "src", "research-loop.ts"),
      [
        "export const draftLoop = [",
        "  \"scan recent signals\",",
        "  \"turn the next move into files\",",
        "  \"write back results into the workspace\"",
        "];",
        ""
      ].join("\n"),
      "utf8"
    ),
    writeFile(
      path.join(workspacePath, "notes", "automation-loop.md"),
      [
        "# automation loop",
        "",
        "- keep the workspace local",
        "- let chat stay conversational",
        "- save durable outputs into files",
        "- keep the UI focused on the main thread",
        ""
      ].join("\n"),
      "utf8"
    ),
    writeFile(
      path.join(workspacePath, "results", "summary.json"),
      JSON.stringify(
        {
          lastRun: "seeded",
          themes: [
            "chat is the entry point",
            "files are the durable memory",
            "automation should stay visible in one thread"
          ]
        },
        null,
        2
      ),
      "utf8"
    ),
    writeFile(
      path.join(workspacePath, "experiments", "next-step.txt"),
      "Tighten the local loop until it can move from planning to repeatable execution.\n",
      "utf8"
    )
  ]);

  await seedCaptureState(workspacePath);
  return workspacePath;
}

async function seedCaptureState(workspacePath: string) {
  const store = new ProjectStore();
  const project = await store.initProject(workspacePath, {
    name: "demo-loop"
  });

  await store.writeProjectMemory(workspacePath, {
    projectBrief: "Small local workspace for README capture.",
    researchGoal: "Tighten the automation loop until the main chat can carry real research work.",
    openQuestions: [
      "Which updates should stay as chat versus become files?",
      "How much of the loop can run unattended before trust drops?"
    ],
    activeHypotheses: [
      "A single main thread plus durable workspace state is enough for the first useful version."
    ],
    sessionSummary: "Seeded workspace for a single-view Lithium screenshot."
  });

  await store.updateThread(workspacePath, project.defaultThreadId, {
    title: "working notes",
    summary: "Loose observations and scratch prompts."
  });

  const baselineThread = await store.createThread(workspacePath, "baseline sweep");
  await store.updateThread(workspacePath, baselineThread.id, {
    summary: "Quick scan of prior signals and open questions."
  });

  const resultsThread = await store.createThread(workspacePath, "results review");
  await store.updateThread(workspacePath, resultsThread.id, {
    summary: "Summaries, metrics, and workspace artifacts to revisit."
  });

  const mainThread = await store.createThread(workspacePath, "automation loop");
  await store.updateThread(workspacePath, mainThread.id, {
    summary: "Main thread for steering the local research loop."
  });
  await store.selectThread(workspacePath, mainThread.id);

  const startedAt = Date.parse("2026-03-26T08:00:00.000Z");
  const entries: Array<Omit<ConversationEntryRecord, "id">> = [
    {
      threadId: mainThread.id,
      role: "user",
      source: "user",
      body: "현재 워크스페이스 기준으로 자동화 연구 루프를 더 가볍게 정리해줘.",
      createdAt: new Date(startedAt).toISOString()
    },
    {
      threadId: mainThread.id,
      role: "assistant",
      source: "orchestrator",
      body: [
        "정리 방향은 이렇습니다.",
        "",
        "1. 메인 채팅 하나에서 계획, 실행, 요약을 끝냅니다.",
        "2. 산출물은 [`notes/automation-loop.md`](" + path.join(workspacePath, "notes", "automation-loop.md") + ") 같은 파일에 남깁니다.",
        "3. 실험 결과는 [`results/summary.json`](" + path.join(workspacePath, "results", "summary.json") + ") 에 축적합니다."
      ].join("\n"),
      createdAt: new Date(startedAt + 60_000).toISOString()
    },
    {
      threadId: mainThread.id,
      role: "user",
      source: "user",
      body: "좋아. 그럼 지금 코드베이스에서 main chat이 아닌 나머지 개념은 계속 줄여도 되는지 체크해줘.",
      createdAt: new Date(startedAt + 120_000).toISOString()
    },
    {
      threadId: mainThread.id,
      role: "assistant",
      source: "automation",
      body: [
        "네. 현재 기준으로는 다음 원칙이 안전합니다.",
        "",
        "- UI는 thread rail + main chat + composer 정도만 유지",
        "- durable state는 `.lithium/` 과 워크스페이스 파일에만 남기기",
        "- 수동 편집기나 추가 패널은 다시 붙이지 않기"
      ].join("\n"),
      createdAt: new Date(startedAt + 180_000).toISOString()
    }
  ];

  for (const entry of entries) {
    const allocated = await store.allocateConversationEntry(workspacePath);
    await store.writeConversationEntry(workspacePath, {
      id: allocated.id,
      ...entry
    });
  }

  await store.updateSessionSummary(workspacePath);
  await store.buildContextBundle(
    workspacePath,
    "Refresh the workspace context bundle for README capture."
  );
}

await main();
