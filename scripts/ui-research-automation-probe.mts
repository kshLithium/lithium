import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, type Page } from "playwright-core";
import type { LithiumApi } from "../src/shared/types";

declare global {
  interface Window {
    lithium: LithiumApi;
  }
}

type PromptLogEntry = {
  ts?: string;
  kind?: string;
  prompt?: string;
  displayPrompt?: string;
  decisionId?: string;
  runtimeContext?: string;
  artifactContext?: string;
  summary?: string;
  nextTask?: string;
  rationale?: string;
  oracleSessionSlug?: string;
  threadId?: string;
  sessionId?: string;
  runId?: string;
  objective?: string;
  status?: string;
  finalMessage?: string;
};

type SnapshotSummary = {
  activeThreadId: string | null;
  activeThreadTitle: string | null;
  activeThreadSummary: string | null;
  activeThreadMemory: string | null;
  latestDecisionId: string | null;
  latestDecisionSummary: string | null;
  latestDecisionNextTask: string | null;
  latestRunId: string | null;
  latestRunStatus: string | null;
  latestRunPrompt: string | null;
  latestRunDisplayPrompt: string | null;
  latestRunFinalMessage: string | null;
  latestAutomationSessionId: string | null;
  latestAutomationStatus: string | null;
  latestAutomationObjective: string | null;
  latestCheckpointId: string | null;
  latestCheckpointSummary: string | null;
};

type ProbeReport = {
  workspacePath: string;
  prompts: {
    first: string;
    second: string;
    resume: string;
  };
  afterFirstPrompt: SnapshotSummary;
  afterSecondPrompt: SnapshotSummary;
  afterFirstCycle: SnapshotSummary;
  afterSecondCycle: SnapshotSummary;
  inspection: {
    strategistRuntimeHasOpenQuestions: boolean;
    strategistRuntimeHasHypotheses: boolean;
    builderRuntimeHasDecisionNextTask: boolean;
    builderRuntimeHasOpenQuestions: boolean;
    builderRuntimeHasActiveHypotheses: boolean;
    builderPromptUsesDecisionNextTask: boolean;
    builderArtifactContextHasLatestDecision: boolean;
    contextBundleHasLatestTaskPrompt: boolean;
  };
  keyFiles: {
    sessionSummary: string;
    currentContext: string;
    firstBuilderRuntime: string;
    secondBuilderRuntime: string | null;
    resultsSection: string;
    experimentPlan: string;
  };
};

const strategistResponseTimeoutMs = Number.parseInt(
  process.env.LITHIUM_UI_RESEARCH_PROBE_RESPONSE_TIMEOUT_MS ?? "900000",
  10
);

async function main() {
  const workspacePath = await createWorkspace();
  const attachmentPath = path.join(workspacePath, "..", `reviewer-note-${Date.now()}.md`);
  await writeFile(
    attachmentPath,
    [
      "# Reviewer Note",
      "",
      "- Compare latency gains against answer drift rather than raw quality only.",
      "- Prefer one bounded artifact update before proposing larger code changes.",
      "- Keep claims modest and make the next experiment falsifiable."
    ].join("\n"),
    "utf8"
  );
  const appName = `Lithium Research Probe ${Date.now()}`;
  const firstPrompt =
    "/research README, experiments/ablation-summary.md, paper/sections/results.md, 첨부한 reviewer note를 함께 보고 지금 가장 중요한 연구 질문 1개를 정리해줘.";
  const secondPrompt =
    "/research 좋아. 그 연구 질문을 기준으로 autopilot이 바로 실행해야 할 bounded next step 1개와 성공 기준 2개를 제안해줘.";
  const resumePrompt =
    "좋아. 방금 나온 결과를 이어서, 논문 초안과 실험 계획이 더 일관되도록 한 단계만 더 진행해줘.";

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

    await page.evaluate(
      async ({ targetWorkspacePath, targetAttachmentPath }) => {
        await window.lithium.updateAppSettings({
          strategistSessionReady: true,
          onboardingDismissed: true,
          strategistReasoningIntensity: "standard",
          builderReasoningEffort: "high"
        });
        await window.lithium.initProject(targetWorkspacePath);
        await window.lithium.updateProjectMemory({
          workspacePath: targetWorkspacePath,
          projectBrief:
            "This workspace studies when Lithium should reuse strategist preview context versus recomputing it during research automation.",
          researchGoal:
            "Derive one concrete next experiment around strategist preview reuse and leave behind notes plus manuscript-ready text a researcher can review.",
          constraints: [
            "Local-first",
            "Single-user",
            "Prototype-first",
            "Prefer bounded edits over sprawling refactors"
          ],
          openQuestions: [
            "When does reusing the same strategist conversation reduce latency without hurting answer quality?",
            "Which signals should trigger recomputation instead of reuse?"
          ],
          activeHypotheses: [
            "Conversation reuse helps same-thread follow-ups but can entrench stale assumptions.",
            "A small manuscript or notes update is the safest first bounded automation step."
          ],
          preferences: {
            strategistStyle: "Direct, critical, hypothesis-driven.",
            builderStyle: "Prefer concrete bounded artifact updates with evidence."
          }
        });
        const seededSnapshot = await window.lithium.getProjectSnapshot(targetWorkspacePath);
        await window.lithium.updateThreadMemory({
          workspacePath: targetWorkspacePath,
          threadId: seededSnapshot.activeThreadId ?? undefined,
          memory:
            "Prioritize one falsifiable hypothesis, one bounded next step, and one artifact update a human researcher can quickly inspect."
        });
        await window.lithium.importAttachments({
          workspacePath: targetWorkspacePath,
          threadId: seededSnapshot.activeThreadId ?? undefined,
          filePaths: [targetAttachmentPath]
        });
      },
      { targetWorkspacePath: workspacePath, targetAttachmentPath: attachmentPath }
    );

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("textarea.composer-input", { timeout: 30_000 });

    console.log("[probe] workspace", workspacePath);
    console.log("[probe] sending first strategist prompt");
    await sendPrompt(page, firstPrompt);
    const firstDecision = await waitForNewDecision(workspacePath, null, strategistResponseTimeoutMs);
    const afterFirstPrompt = await snapshotSummary(page, workspacePath);
    console.log("[probe] first strategist decision", {
      decisionId: afterFirstPrompt.latestDecisionId,
      summary: afterFirstPrompt.latestDecisionSummary,
      nextTask: afterFirstPrompt.latestDecisionNextTask
    });

    console.log("[probe] sending second strategist prompt");
    await sendPrompt(page, secondPrompt);
    await waitForNewDecision(workspacePath, firstDecision, strategistResponseTimeoutMs);
    const afterSecondPrompt = await snapshotSummary(page, workspacePath);
    console.log("[probe] second strategist decision", {
      decisionId: afterSecondPrompt.latestDecisionId,
      summary: afterSecondPrompt.latestDecisionSummary,
      nextTask: afterSecondPrompt.latestDecisionNextTask
    });

    console.log("[probe] starting checkpoint automation");
    const startedSnapshot = await page.evaluate(async (targetWorkspacePath) => {
      const seededSnapshot = await window.lithium.getProjectSnapshot(targetWorkspacePath);
      const objective =
        seededSnapshot.activeThread?.summary?.trim() ||
        seededSnapshot.latestDecision?.summary?.trim() ||
        "Advance the active research thread.";
      const createdSnapshot = await window.lithium.createAutomationSession({
        workspacePath: targetWorkspacePath,
        threadId: seededSnapshot.activeThreadId ?? undefined,
        objective,
        mode: "checkpoint",
        maxSteps: 2,
        maxRuntimeMinutes: 180,
        maxRetries: 2,
        paperWriteEnabled: true
      });
      const sessionId = createdSnapshot.latestAutomationSession?.id;

      if (!sessionId) {
        throw new Error("Automation session could not be created.");
      }

      return await window.lithium.startAutomationSession({
        workspacePath: targetWorkspacePath,
        sessionId
      });
    }, workspacePath);

    const sessionId = startedSnapshot.latestAutomationSession?.id;

    if (!sessionId) {
      throw new Error("No automation session id was returned.");
    }

    await waitForAutomationCheckpoint(page, workspacePath, sessionId, strategistResponseTimeoutMs);
    const afterFirstCycle = await snapshotSummary(page, workspacePath);
    console.log("[probe] first automation checkpoint", {
      sessionId,
      checkpointId: afterFirstCycle.latestCheckpointId,
      runId: afterFirstCycle.latestRunId,
      runStatus: afterFirstCycle.latestRunStatus
    });
    const firstCheckpointId = afterFirstCycle.latestCheckpointId;

    if (!firstCheckpointId) {
      throw new Error("First automation cycle did not produce a checkpoint.");
    }

    await page.evaluate(
      async ({ targetWorkspacePath, targetSessionId, targetCheckpointId, response }) => {
        await window.lithium.approveAutomationCheckpoint({
          workspacePath: targetWorkspacePath,
          sessionId: targetSessionId,
          checkpointId: targetCheckpointId,
          response
        });
      },
      {
        targetWorkspacePath: workspacePath,
        targetSessionId: sessionId,
        targetCheckpointId: firstCheckpointId,
        response: resumePrompt
      }
    );

    await waitForNextCheckpoint(page, workspacePath, sessionId, firstCheckpointId, strategistResponseTimeoutMs);
    const afterSecondCycle = await snapshotSummary(page, workspacePath);
    console.log("[probe] second automation checkpoint", {
      sessionId,
      checkpointId: afterSecondCycle.latestCheckpointId,
      runId: afterSecondCycle.latestRunId,
      runStatus: afterSecondCycle.latestRunStatus
    });

    const promptEntries = await readPromptLog(workspacePath);
    const automationStrategistRequest = promptEntries.find(
      (entry) =>
        entry.kind === "strategist.request" &&
        entry.prompt === afterFirstCycle.latestAutomationObjective
    );
    const builderRequests = promptEntries.filter((entry) => entry.kind === "builder.request");
    const firstBuilderRequest = builderRequests[0] ?? null;
    const secondBuilderRequest = builderRequests[1] ?? null;

    const sessionSummary = await readWorkspaceFile(
      path.join(workspacePath, ".lithium", "memory", "session-summary.md")
    );
    const currentContext = await readWorkspaceFile(
      path.join(workspacePath, ".lithium", "context", "current-context.md")
    );
    const firstBuilderRuntime = await readWorkspaceFile(
      path.join(
        workspacePath,
        ".lithium",
        "context",
        `${afterFirstCycle.latestRunId}.builder.runtime.md`
      )
    );
    const secondBuilderRuntime =
      afterSecondCycle.latestRunId && afterSecondCycle.latestRunId !== afterFirstCycle.latestRunId
        ? await readWorkspaceFile(
            path.join(
              workspacePath,
              ".lithium",
              "context",
              `${afterSecondCycle.latestRunId}.builder.runtime.md`
            )
          )
        : null;
    const resultsSection = await readWorkspaceFile(path.join(workspacePath, "paper", "sections", "results.md"));
    const experimentPlan = await readWorkspaceFile(path.join(workspacePath, "notes", "experiment-plan.md"));

    const decisionNextTask = afterSecondPrompt.latestDecisionNextTask?.trim() || afterFirstPrompt.latestDecisionNextTask?.trim() || "";
    const builderArtifactContext = firstBuilderRequest?.artifactContext ?? "";

    const report: ProbeReport = {
      workspacePath,
      prompts: {
        first: firstPrompt,
        second: secondPrompt,
        resume: resumePrompt
      },
      afterFirstPrompt,
      afterSecondPrompt,
      afterFirstCycle,
      afterSecondCycle,
      inspection: {
        strategistRuntimeHasOpenQuestions: (automationStrategistRequest?.runtimeContext ?? "").includes(
          "Open Questions"
        ),
        strategistRuntimeHasHypotheses: (automationStrategistRequest?.runtimeContext ?? "").includes(
          "Active Hypotheses"
        ),
        builderRuntimeHasDecisionNextTask: Boolean(decisionNextTask) && firstBuilderRuntime.includes(decisionNextTask),
        builderRuntimeHasOpenQuestions: firstBuilderRuntime.includes("Open Questions"),
        builderRuntimeHasActiveHypotheses: firstBuilderRuntime.includes("Active Hypotheses"),
        builderPromptUsesDecisionNextTask: Boolean(decisionNextTask) && (firstBuilderRequest?.prompt ?? "").includes(decisionNextTask),
        builderArtifactContextHasLatestDecision: builderArtifactContext.includes("## Latest Decision"),
        contextBundleHasLatestTaskPrompt: currentContext.includes("Latest task prompt:")
      },
      keyFiles: {
        sessionSummary,
        currentContext,
        firstBuilderRuntime,
        secondBuilderRuntime,
        resultsSection,
        experimentPlan
      }
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await electronApp.close().catch(() => undefined);
    if (process.env.LITHIUM_KEEP_UI_RESEARCH_PROBE_WORKSPACE !== "1") {
      await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
      await rm(attachmentPath, { force: true }).catch(() => undefined);
    } else {
      console.error(`[probe] kept workspace at ${workspacePath}`);
      console.error(`[probe] kept attachment at ${attachmentPath}`);
    }
  }
}

async function createWorkspace() {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-research-probe-"));
  await mkdir(path.join(workspacePath, "experiments"), { recursive: true });
  await mkdir(path.join(workspacePath, "notes"), { recursive: true });
  await mkdir(path.join(workspacePath, "paper", "sections"), { recursive: true });
  await mkdir(path.join(workspacePath, "src"), { recursive: true });

  await writeFile(
    path.join(workspacePath, "README.md"),
    [
      "# Strategist Preview Reuse Study",
      "",
      "This research workspace studies when Lithium should reuse an existing strategist conversation versus recomputing the strategist context from scratch.",
      "",
      "## Goal",
      "",
      "- Decide one bounded next experiment around strategist preview reuse.",
      "- Leave behind notes and manuscript-ready text a human researcher can inspect quickly.",
      "",
      "## Current Tension",
      "",
      "- Reusing the same strategist thread is faster on follow-up questions.",
      "- Fresh recomputation may be safer when the question or evidence has shifted.",
      "",
      "## Expected Outputs",
      "",
      "- A concrete next experiment plan.",
      "- A small manuscript or notes update grounded in current evidence."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspacePath, "experiments", "ablation-summary.md"),
    [
      "# Ablation Summary",
      "",
      "| Condition | Median latency | Analyst quality | Evidence drift risk |",
      "| --- | ---: | ---: | ---: |",
      "| Reuse same strategist thread | 24s | 0.78 | medium |",
      "| Fresh strategist thread | 41s | 0.84 | low |",
      "| Reuse cached runtime only | 19s | 0.75 | high |",
      "",
      "## Notes",
      "",
      "- Same-thread reuse is materially faster.",
      "- Fresh threads recover quality when the task shifts from repository diagnosis to experiment design.",
      "- Cached runtime alone is fast but tends to miss nuance from recent follow-up turns."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspacePath, "notes", "experiment-plan.md"),
    [
      "# Experiment Plan",
      "",
      "This file should evolve into the next concrete experiment plan.",
      "",
      "- Pending: decide when preview reuse is safe.",
      "- Pending: define a falsifiable trigger for recomputation."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspacePath, "paper", "sections", "results.md"),
    [
      "# Results",
      "",
      "Current draft: reuse is faster, but the evidence for when to recompute is still underspecified.",
      "",
      "We need a sharper statement that separates latency gains from answer drift risk."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspacePath, "paper", "main.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{sections/results.md}",
      "\\end{document}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspacePath, "src", "analyze_preview.py"),
    [
      "def summarize_latency_gap(reuse_latency, fresh_latency):",
      "    return fresh_latency - reuse_latency",
      ""
    ].join("\n"),
    "utf8"
  );

  return workspacePath;
}

async function sendPrompt(page: Page, prompt: string) {
  const textarea = page.locator("textarea.composer-input");

  await textarea.click();
  await textarea.fill(prompt);
  await page.waitForTimeout(250);

  if ((await textarea.inputValue()).trim() !== prompt.trim()) {
    throw new Error("Composer value did not match the intended prompt.");
  }

  await textarea.press("Enter");
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

async function waitForNewDecision(workspacePath: string, previousDecisionId: string | null, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readPromptLog(workspacePath);
    const latestResponse = [...entries].reverse().find((entry) => entry.kind === "strategist.response");

    if (latestResponse?.decisionId && latestResponse.decisionId !== previousDecisionId) {
      return latestResponse.decisionId;
    }

    await sleep(1500);
  }

  throw new Error("Timed out waiting for a strategist response.");
}

async function waitForAutomationCheckpoint(
  page: Page,
  workspacePath: string,
  sessionId: string,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(async ({ targetWorkspacePath }) => {
      return await window.lithium.getProjectSnapshot(targetWorkspacePath);
    }, { targetWorkspacePath: workspacePath });

    if (
      snapshot.latestAutomationSession?.id === sessionId &&
      snapshot.latestAutomationSession.status === "awaiting-checkpoint"
    ) {
      return;
    }

    await page.waitForTimeout(2000);
  }

  throw new Error("Timed out waiting for the automation checkpoint.");
}

async function waitForNextCheckpoint(
  page: Page,
  workspacePath: string,
  sessionId: string,
  previousCheckpointId: string,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(async ({ targetWorkspacePath }) => {
      return await window.lithium.getProjectSnapshot(targetWorkspacePath);
    }, { targetWorkspacePath: workspacePath });

    if (
      snapshot.latestAutomationSession?.id === sessionId &&
      snapshot.latestAutomationSession.status === "awaiting-checkpoint" &&
      snapshot.latestAutomationCheckpoint?.id &&
      snapshot.latestAutomationCheckpoint.id !== previousCheckpointId
    ) {
      return;
    }

    await page.waitForTimeout(2000);
  }

  throw new Error("Timed out waiting for the second automation checkpoint.");
}

async function snapshotSummary(page: Page, workspacePath: string): Promise<SnapshotSummary> {
  return await page.evaluate(async (targetWorkspacePath) => {
    const snapshot = await window.lithium.getProjectSnapshot(targetWorkspacePath);

    return {
      activeThreadId: snapshot.activeThreadId ?? null,
      activeThreadTitle: snapshot.activeThread?.title ?? null,
      activeThreadSummary: snapshot.activeThread?.summary ?? null,
      activeThreadMemory: snapshot.activeThread?.memory ?? null,
      latestDecisionId: snapshot.latestDecision?.id ?? null,
      latestDecisionSummary: snapshot.latestDecision?.summary ?? null,
      latestDecisionNextTask: snapshot.latestDecision?.nextTask ?? null,
      latestRunId: snapshot.latestRun?.id ?? null,
      latestRunStatus: snapshot.latestRun?.status ?? null,
      latestRunPrompt: snapshot.latestRun?.prompt ?? null,
      latestRunDisplayPrompt: snapshot.latestRun?.displayPrompt ?? null,
      latestRunFinalMessage: snapshot.latestRun?.finalMessage ?? null,
      latestAutomationSessionId: snapshot.latestAutomationSession?.id ?? null,
      latestAutomationStatus: snapshot.latestAutomationSession?.status ?? null,
      latestAutomationObjective: snapshot.latestAutomationSession?.objective ?? null,
      latestCheckpointId: snapshot.latestAutomationCheckpoint?.id ?? null,
      latestCheckpointSummary: snapshot.latestAutomationCheckpoint?.summary ?? null
    };
  }, workspacePath);
}

async function readWorkspaceFile(filePath: string) {
  return await readFile(filePath, "utf8").catch(() => "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
