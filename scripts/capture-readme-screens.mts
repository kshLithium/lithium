import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { ProjectStore } from "../src/main/services/project-store.ts";
import type { DecisionRecord, RunRecord, TaskRecord } from "../src/shared/types.ts";

const APP_WIDTH = 1512;
const APP_HEIGHT = 980;

async function main() {
  const workspacePath = await createCaptureWorkspace();
  const appName = `Lithium Readme Capture ${Date.now()}`;
  const outputDir = path.join(process.cwd(), "docs", "readme");
  await mkdir(outputDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LITHIUM_APP_NAME: appName,
    LITHIUM_WORKSPACE: workspacePath
  };

  if (process.env.VITE_DEV_SERVER_URL?.trim()) {
    env.VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
  }

  const electronApp = await electron.launch({
    args: [path.join(process.cwd(), "dist-electron", "index.cjs")],
    env
  });

  try {
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: APP_WIDTH, height: APP_HEIGHT });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("textarea.composer-input", { timeout: 30_000 });

    await page.evaluate(async (targetWorkspacePath) => {
      await window.lithium.updateAppSettings({
        onboardingDismissed: true,
        strategistSessionReady: true,
        themePreference: "light"
      });
      await window.lithium.initProject(targetWorkspacePath);
    }, workspacePath);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("textarea.composer-input", { timeout: 30_000 });
    await page.waitForTimeout(800);

    await page.evaluate(async (targetWorkspacePath) => {
      const snapshot = await window.lithium.getProjectSnapshot(targetWorkspacePath);
      const threads = snapshot.threads;
      const firstThread = threads[0];

      if (firstThread) {
        await window.lithium.renameThread({
          workspacePath: targetWorkspacePath,
          threadId: firstThread.id,
          title: "loop sketch"
        });
      }

      await window.lithium.createThread({
        workspacePath: targetWorkspacePath,
        title: "notes"
      });

      await window.lithium.createThread({
        workspacePath: targetWorkspacePath,
        title: "paper"
      });

      const refreshed = await window.lithium.getProjectSnapshot(targetWorkspacePath);
      const targetThread = refreshed.threads.find((thread) => thread.title === "loop sketch");

      if (targetThread) {
        await window.lithium.selectThread({
          workspacePath: targetWorkspacePath,
          threadId: targetThread.id
        });
      }

      await window.lithium.updateProjectMemory({
        workspacePath: targetWorkspacePath,
        projectBrief: "Loose demo workspace for Lithium README shots.",
        researchGoal: "Figure out what a local research loop should automate next.",
        openQuestions: [
          "What should stay in chat versus become a durable file?",
          "How much of the loop can run without feeling fake?"
        ],
        activeHypotheses: [
          "A thin strategist + builder split is enough for a first useful prototype."
        ]
      });

      try {
        await window.lithium.compilePaper(targetWorkspacePath);
      } catch {
        // README screenshots can still proceed without a compiled preview.
      }
    }, workspacePath);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("textarea.composer-input", { timeout: 30_000 });
    await page.waitForTimeout(1200);

    await showChatPrompt(
      page,
      "gpt-5.4 pro랑 codex cli 묶어서 지금 이 워크스페이스에서 돌아갈 만한 research loop를 대충 정리해줘"
    );
    await page.screenshot({
      path: path.join(outputDir, "hero-chat.png")
    });

    await showSlashCommand(page, "/co");
    await page.locator("#composer-slash-command-code-panel").click();
    await page.waitForSelector(".code-workbench", { timeout: 10_000 });
    await page.waitForTimeout(700);
    await page.screenshot({
      path: path.join(outputDir, "code-workbench.png")
    });

    await page.locator(".workbench-close-button").click();
    await page.waitForSelector(".chat-column", { timeout: 10_000 });
    await page.waitForTimeout(300);

    await showSlashCommand(page, "/pa");
    await page.locator("#composer-slash-command-paper-panel").click();
    await page.waitForSelector(".paper-surface", { timeout: 10_000 });
    await page.waitForTimeout(800);
    await page.screenshot({
      path: path.join(outputDir, "paper-workbench.png")
    });
  } finally {
    await electronApp.close().catch(() => undefined);
    if (process.env.LITHIUM_KEEP_README_CAPTURE_WORKSPACE !== "1") {
      await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function showChatPrompt(page: Page, prompt: string) {
  const textarea = page.locator("textarea.composer-input");
  await textarea.click();
  await textarea.fill(prompt);
  await page.waitForTimeout(250);
}

async function showSlashCommand(page: Page, query: string) {
  const textarea = page.locator("textarea.composer-input");
  await textarea.click();
  await textarea.fill(query);
  await page.waitForSelector(".composer-slash-menu", { timeout: 10_000 });
  await page.waitForTimeout(250);
}

async function createCaptureWorkspace() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lithium-readme-"));
  const workspacePath = path.join(tempRoot, "demo-loop");

  await mkdir(path.join(workspacePath, "src"), { recursive: true });
  await mkdir(path.join(workspacePath, "notes"), { recursive: true });
  await mkdir(path.join(workspacePath, "paper", "sections"), { recursive: true });
  await mkdir(path.join(workspacePath, "results"), { recursive: true });

  await Promise.all([
    writeFile(
      path.join(workspacePath, "README.md"),
      ["# demo-loop", "", "small fake workspace for Lithium screenshots.", ""].join("\n"),
      "utf8"
    ),
    writeFile(
      path.join(workspacePath, "src", "research-loop.ts"),
      [
        "export type ResearchStep = {",
        "  title: string;",
        "  owner: \"strategist\" | \"builder\";",
        "};",
        "",
        "export const draftLoop: ResearchStep[] = [",
        "  { title: \"skim recent signals\", owner: \"strategist\" },",
        "  { title: \"turn the next task into files\", owner: \"builder\" },",
        "  { title: \"write down what changed\", owner: \"builder\" }",
        "];",
        ""
      ].join("\n"),
      "utf8"
    ),
    writeFile(
      path.join(workspacePath, "notes", "loop-notes.md"),
      [
        "# loop notes",
        "",
        "- keep the workspace local",
        "- let chat stay messy",
        "- save artifacts when something becomes real",
        ""
      ].join("\n"),
      "utf8"
    ),
    writeFile(
      path.join(workspacePath, "results", "summary.json"),
      JSON.stringify(
        {
          lastRun: "dry",
          signals: ["chat is the entry point", "files are the memory", "paper should lag less"]
        },
        null,
        2
      ),
      "utf8"
    ),
    writeFile(
      path.join(workspacePath, "paper", "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Abstract}",
        "\\input{sections/abstract}",
        "",
        "\\section{Results}",
        "\\input{sections/results}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    ),
    writeFile(
      path.join(workspacePath, "paper", "sections", "abstract.tex"),
      [
        "Lithium is a rough local research loop prototype.",
        "It keeps strategist notes, builder runs, and paper files in one workspace.",
        ""
      ].join("\n"),
      "utf8"
    ),
    writeFile(
      path.join(workspacePath, "paper", "sections", "results.tex"),
      [
        "The current build mostly proves the interaction model.",
        "It is still buggy and the actual automation depth is unfinished.",
        ""
      ].join("\n"),
      "utf8"
    )
  ]);

  await seedCaptureState(workspacePath);
  return workspacePath;
}

async function seedCaptureState(workspacePath: string) {
  const projectStore = new ProjectStore();
  const project = await projectStore.initProject(workspacePath, {
    name: "demo-loop"
  });
  const activeThreadId = project.activeThreadId;
  const now = new Date().toISOString();

  const decisionPaths = await projectStore.allocateDecision(workspacePath);
  const strategistOutput = [
    "SUMMARY: Keep the loop local and lightweight.",
    "NEXT_TASK: Sketch the builder-facing loop, keep paper notes visible, and leave a short result summary in the workspace.",
    "RATIONALE: The prototype is most convincing when the chat, code, and paper surfaces all point at the same local state."
  ].join("\n");
  const decision: DecisionRecord = {
    id: decisionPaths.id,
    threadId: activeThreadId,
    prompt: "roughly map the next version of this local research loop",
    displayPrompt: "roughly map the next version of this local research loop",
    rawOutput: strategistOutput,
    summary: "Keep the loop local and lightweight.",
    nextTask:
      "Sketch the builder-facing loop, keep paper notes visible, and leave a short result summary in the workspace.",
    rationale:
      "The prototype is most convincing when the chat, code, and paper surfaces all point at the same local state.",
    model: "gpt-5.4-pro",
    engine: "browser",
    status: "completed",
    command: {
      command: "npx",
      args: ["@openai/codex", "strategize"],
      cwd: workspacePath
    },
    stdoutPath: decisionPaths.stdoutPath,
    stderrPath: decisionPaths.stderrPath,
    outputPath: decisionPaths.outputPath,
    createdAt: now
  };

  const taskPaths = await projectStore.allocateTask(workspacePath);
  const task: TaskRecord = {
    id: taskPaths.id,
    threadId: activeThreadId,
    sourceDecisionId: decision.id,
    title: "shape the local loop surface",
    prompt:
      "Sketch the builder-facing loop, keep paper notes visible, and leave a short result summary in the workspace.",
    status: "completed",
    createdAt: now,
    updatedAt: now
  };

  const runPaths = await projectStore.allocateRun(workspacePath);
  const finalMessage = [
    "SUMMARY: added a rough loop sketch, seeded paper files, and left a small workspace summary.",
    "FILES: src/research-loop.ts, notes/loop-notes.md, paper/main.tex, paper/sections/abstract.tex, paper/sections/results.tex, results/summary.json",
    "RESULT: success"
  ].join("\n");
  const run: RunRecord = {
    id: runPaths.id,
    threadId: activeThreadId,
    taskId: task.id,
    prompt: task.prompt,
    displayPrompt: "shape the local loop surface",
    model: "gpt-5.4",
    status: "completed",
    exitCode: 0,
    pid: null,
    command: {
      command: "codex",
      args: ["exec", task.prompt],
      cwd: workspacePath
    },
    stdoutPath: runPaths.stdoutPath,
    stderrPath: runPaths.stderrPath,
    finalMessagePath: runPaths.outputPath,
    finalMessage,
    changedFiles: [
      "src/research-loop.ts",
      "notes/loop-notes.md",
      "paper/main.tex",
      "paper/sections/abstract.tex",
      "paper/sections/results.tex",
      "results/summary.json"
    ],
    finalization: "auto",
    createdAt: now,
    startedAt: now,
    endedAt: now
  };

  await Promise.all([
    writeFile(decisionPaths.stdoutPath, "", "utf8"),
    writeFile(decisionPaths.stderrPath, "", "utf8"),
    writeFile(decisionPaths.outputPath, strategistOutput, "utf8"),
    writeFile(runPaths.stdoutPath, "", "utf8"),
    writeFile(runPaths.stderrPath, "", "utf8"),
    writeFile(runPaths.outputPath, finalMessage, "utf8")
  ]);

  await projectStore.writeDecision(workspacePath, decision);
  await projectStore.writeTask(workspacePath, task);
  await projectStore.writeRun(workspacePath, run);
  await projectStore.updateThread(workspacePath, activeThreadId, {
    summary: "Local loop prototype with strategist notes, builder output, and paper files kept in one workspace."
  });
  await projectStore.updateSessionSummary(workspacePath);
  await projectStore.buildContextBundle(
    workspacePath,
    "Refresh the Lithium context bundle for README capture."
  );
}

await main();
