import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type Page } from "playwright-core";
import type { LithiumApi } from "../src/shared/types";

declare global {
  interface Window {
    lithium: LithiumApi;
  }
}

type PromptLogEntry = {
  kind?: string;
  prompt?: string;
  displayPrompt?: string;
  decisionId?: string;
  threadId?: string;
  sessionId?: string;
  checkpointId?: string;
  runId?: string;
  response?: string;
  instruction?: string;
  status?: string;
  summary?: string;
  finalMessage?: string;
  changedFiles?: string[];
  runtimeContext?: string;
  artifactContext?: string;
};

type SnapshotSummary = {
  activeThreadId: string | null;
  activeThreadTitle: string | null;
  activeThreadSummary: string | null;
  latestDecisionId: string | null;
  latestDecisionSummary: string | null;
  latestRunId: string | null;
  latestRunStatus: string | null;
  latestRunPrompt: string | null;
  latestRunDisplayPrompt: string | null;
  latestRunChangedFiles: string[];
  latestAutomationSessionId: string | null;
  latestAutomationStatus: string | null;
  latestAutomationObjective: string | null;
  latestCheckpointId: string | null;
  latestCheckpointSummary: string | null;
};

type LongSessionReport = {
  workspacePath: string;
  threadId: string | null;
  prompts: {
    first: string;
    second: string;
    interrupt: string;
    resume: string;
    finalResearch: string;
  };
  phases: {
    afterFirstPrompt: SnapshotSummary;
    afterSecondPrompt: SnapshotSummary;
    afterInterrupt: SnapshotSummary;
    afterResumeCycle: SnapshotSummary;
    afterPause: SnapshotSummary;
    afterFinalResearch: SnapshotSummary;
  };
  evidence: {
    builderRequestCount: number;
    builderResponseCount: number;
    strategistResponseCount: number;
    interruptCount: number;
    checkpointApprovalCount: number;
    changedFilesAcrossRuns: string[];
    sameThreadAcrossWholeSession: boolean;
    codeTouched: boolean;
    experimentTouched: boolean;
    paperTouched: boolean;
  };
  keyFiles: {
    policySource: string;
    experimentJson: string;
    experimentMarkdown: string;
    notesPlan: string;
    paperResults: string;
    sessionSummary: string;
    currentContext: string;
  };
};

const overallTimeoutMs = Number.parseInt(
  process.env.LITHIUM_UI_LONG_SESSION_TIMEOUT_MS ?? "1800000",
  10
);

async function main() {
  const workspacePath = await createWorkspace();
  const artifactDir = path.join(workspacePath, ".probe-artifacts");
  await mkdir(artifactDir, { recursive: true });

  const prompts = {
    first:
      "이 워크스페이스 전체를 읽고, 지금 가장 중요한 연구 질문 1개를 정리해줘. 오늘 안에 코드 수정, 실험 실행, 결과 정리, 논문 문구 반영까지 끝낼 생각이야.",
    second:
      "좋아. 그러면 지금 저장소에 있는 코드와 스크립트를 실제로 써서 끝까지 밀 수 있게, 어떤 가설과 판단 기준으로 autopilot을 움직이면 좋을지 짧게 정리해줘.",
    interrupt:
      "잠깐. 결과를 과장하지 말고, 코드 리팩터링보다 heuristic 수정 + 실험 재실행 + notes/paper 정합성에만 집중해줘.",
    resume:
      "좋아, 그 방향으로 계속해. 이번엔 notes와 paper 결과 문장이 실험 산출물과 정확히 맞도록 마무리해줘.",
    finalResearch:
      "/research 지금까지 이 한 스레드에서 나온 내용을 기준으로, 최종 결론과 코드/실험/논문에서 각각 무엇이 바뀌었는지 한 번에 요약해줘."
  };

  const electronApp = await electron.launch({
    args: [path.join(process.cwd(), "dist-electron/index.cjs")],
    env: {
      ...process.env,
      LITHIUM_APP_NAME: `Lithium Long Session ${Date.now()}`,
      LITHIUM_WORKSPACE: workspacePath,
      ...(process.env.VITE_DEV_SERVER_URL ? { VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL } : {})
    }
  });

  try {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("textarea.composer-input", { timeout: 60_000 });

    await page.evaluate(async (targetWorkspacePath) => {
      await window.lithium.updateAppSettings({
        strategistSessionReady: true,
        onboardingDismissed: true,
        strategistReasoningIntensity: "standard",
        builderReasoningEffort: "high",
        autopilotPromptLanguage: "ko"
      });
      await window.lithium.initProject(targetWorkspacePath);
    }, workspacePath);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("textarea.composer-input", { timeout: 60_000 });

    console.log("[long-probe] workspace", workspacePath);

    const firstDecisionId = await sendPromptAndWaitForDecision(page, workspacePath, prompts.first, null);
    const afterFirstPrompt = await snapshotSummary(page, workspacePath);
    console.log("[long-probe] first strategist response", afterFirstPrompt);

    await sendPromptAndWaitForDecision(page, workspacePath, prompts.second, firstDecisionId);
    const afterSecondPrompt = await snapshotSummary(page, workspacePath);
    console.log("[long-probe] second strategist response", afterSecondPrompt);

    await clickAutomationButton(page, "Start autopilot");
    await waitForAutomationStatus(page, workspacePath, ["running"], overallTimeoutMs);
    await waitForNewBuilderRequest(workspacePath, 0, overallTimeoutMs);
    await waitForRunState(page, workspacePath, (snapshot) => Boolean(snapshot.latestRunId), overallTimeoutMs);
    console.log("[long-probe] automation started");

    await sendPrompt(page, prompts.interrupt);
    await waitForAutomationStatus(page, workspacePath, ["awaiting-checkpoint"], overallTimeoutMs);
    const afterInterrupt = await snapshotSummary(page, workspacePath);
    console.log("[long-probe] interrupt checkpoint", afterInterrupt);

    const builderResponsesBeforeResume = countEntries(await readPromptLog(workspacePath), "builder.response");
    await sendPrompt(page, prompts.resume);
    await waitForPromptLogCount(workspacePath, "automation.checkpoint.approved", 1, overallTimeoutMs);
    await waitForAutomationStatus(page, workspacePath, ["running"], overallTimeoutMs);
    await waitForPromptLogCount(
      workspacePath,
      "builder.response",
      builderResponsesBeforeResume + 1,
      overallTimeoutMs
    );
    const afterResumeCycle = await snapshotSummary(page, workspacePath);
    console.log("[long-probe] post-resume cycle", afterResumeCycle);

    await clickAutomationButton(page, "Pause autopilot");
    await waitForAutomationStatus(page, workspacePath, ["paused"], overallTimeoutMs);
    const afterPause = await snapshotSummary(page, workspacePath);
    console.log("[long-probe] paused after current step", afterPause);

    await sendPromptAndWaitForDecision(
      page,
      workspacePath,
      prompts.finalResearch,
      afterPause.latestDecisionId
    );
    const afterFinalResearch = await snapshotSummary(page, workspacePath);
    console.log("[long-probe] final strategist synthesis", afterFinalResearch);

    const promptEntries = await readPromptLog(workspacePath);
    const changedFilesAcrossRuns = Array.from(
      new Set(
        promptEntries
          .filter((entry) => entry.kind === "builder.response")
          .flatMap((entry) => entry.changedFiles ?? [])
      )
    );

    const report: LongSessionReport = {
      workspacePath,
      threadId: afterFinalResearch.activeThreadId,
      prompts,
      phases: {
        afterFirstPrompt,
        afterSecondPrompt,
        afterInterrupt,
        afterResumeCycle,
        afterPause,
        afterFinalResearch
      },
      evidence: {
        builderRequestCount: countEntries(promptEntries, "builder.request"),
        builderResponseCount: countEntries(promptEntries, "builder.response"),
        strategistResponseCount: countEntries(promptEntries, "strategist.response"),
        interruptCount: countEntries(promptEntries, "automation.interrupt"),
        checkpointApprovalCount: countEntries(promptEntries, "automation.checkpoint.approved"),
        changedFilesAcrossRuns,
        sameThreadAcrossWholeSession: areSameThread([
          afterFirstPrompt,
          afterSecondPrompt,
          afterInterrupt,
          afterResumeCycle,
          afterPause,
          afterFinalResearch
        ]),
        codeTouched: changedFilesAcrossRuns.some((filePath) => filePath.startsWith("src/")),
        experimentTouched: changedFilesAcrossRuns.some(
          (filePath) => filePath.startsWith("experiments/") || filePath.startsWith("notes/")
        ),
        paperTouched: changedFilesAcrossRuns.some((filePath) => filePath.startsWith("paper/"))
      },
      keyFiles: {
        policySource: await readWorkspaceFile(path.join(workspacePath, "src", "reuse_policy.py")),
        experimentJson: await readWorkspaceFile(path.join(workspacePath, "experiments", "results", "latest.json")),
        experimentMarkdown: await readWorkspaceFile(path.join(workspacePath, "experiments", "results", "latest.md")),
        notesPlan: await readWorkspaceFile(path.join(workspacePath, "notes", "experiment-plan.md")),
        paperResults: await readWorkspaceFile(path.join(workspacePath, "paper", "sections", "results.md")),
        sessionSummary: await readWorkspaceFile(
          path.join(workspacePath, ".lithium", "memory", "session-summary.md")
        ),
        currentContext: await readWorkspaceFile(
          path.join(workspacePath, ".lithium", "context", "current-context.md")
        )
      }
    };

    await page.screenshot({
      path: path.join(artifactDir, "final-ui.png"),
      fullPage: true
    });

    assertLongSessionReport(report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    try {
      const page = (await electronApp.windows())[0];
      await page.screenshot({ path: path.join(artifactDir, "failure-ui.png"), fullPage: true });
      await writeFile(path.join(artifactDir, "failure.html"), await page.content(), "utf8");
      console.error(`[long-probe] saved failure artifacts under ${artifactDir}`);
    } catch {
      // Ignore secondary failures while collecting artifacts.
    }
    throw error;
  } finally {
    await electronApp.close().catch(() => undefined);

    if (process.env.LITHIUM_KEEP_UI_LONG_SESSION_WORKSPACE !== "1") {
      await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.error(`[long-probe] kept workspace at ${workspacePath}`);
    }
  }
}

async function createWorkspace() {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-long-session-"));
  await mkdir(path.join(workspacePath, "experiments", "results"), { recursive: true });
  await mkdir(path.join(workspacePath, "notes"), { recursive: true });
  await mkdir(path.join(workspacePath, "paper", "sections"), { recursive: true });
  await mkdir(path.join(workspacePath, "src"), { recursive: true });

  await writeFile(
    path.join(workspacePath, "README.md"),
    [
      "# Preview Reuse Policy Study",
      "",
      "This workspace studies when Lithium should reuse strategist preview context versus recomputing it from scratch.",
      "",
      "## Research Goal",
      "",
      "- Produce one concrete heuristic in `src/reuse_policy.py`.",
      "- Run the local ablation script and save fresh outputs under `experiments/results/`.",
      "- Update the experiment plan and the paper results section to reflect the new evidence.",
      "",
      "## Local Experiment",
      "",
      "Run:",
      "",
      "`python3 experiments/run_reuse_ablation.py`",
      "",
      "The script imports `src/reuse_policy.py`, evaluates synthetic cases, and writes both JSON and Markdown outputs under `experiments/results/`.",
      "",
      "## Current Problem",
      "",
      "- The current heuristic only triggers recomputation for extreme task shifts.",
      "- It ignores evidence delta, so it under-reacts on moderate shifts with large evidence changes.",
      "- The paper text is lagging behind the actual experiment outputs."
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(workspacePath, "src", "reuse_policy.py"),
    [
      '"""Heuristic for deciding when strategist preview context should be recomputed."""',
      "",
      "def should_recompute(task_shift_score: float, evidence_delta: float) -> bool:",
      '    """',
      "    Return True when the app should discard preview reuse and recompute strategist context.",
      "",
      "    Current baseline: only recompute on extreme task shifts.",
      '    """',
      "    return task_shift_score >= 0.85",
      ""
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(workspacePath, "experiments", "run_reuse_ablation.py"),
    [
      "from __future__ import annotations",
      "",
      "import json",
      "from pathlib import Path",
      "import statistics",
      "import sys",
      "",
      'ROOT = Path(__file__).resolve().parents[1]',
      "sys.path.insert(0, str(ROOT))",
      "",
      "from src.reuse_policy import should_recompute",
      "",
      "CASES = [",
      '    {"id": "N1", "task_shift": 0.08, "evidence_delta": 0.12, "expected": "reuse", "reuse_latency": 19, "fresh_latency": 37, "reuse_drift": 0.10, "fresh_drift": 0.08},',
      '    {"id": "N2", "task_shift": 0.22, "evidence_delta": 0.24, "expected": "reuse", "reuse_latency": 21, "fresh_latency": 40, "reuse_drift": 0.13, "fresh_drift": 0.10},',
      '    {"id": "S1", "task_shift": 0.44, "evidence_delta": 0.68, "expected": "fresh", "reuse_latency": 22, "fresh_latency": 39, "reuse_drift": 0.47, "fresh_drift": 0.16},',
      '    {"id": "S2", "task_shift": 0.61, "evidence_delta": 0.34, "expected": "fresh", "reuse_latency": 24, "fresh_latency": 41, "reuse_drift": 0.38, "fresh_drift": 0.17},',
      '    {"id": "S3", "task_shift": 0.72, "evidence_delta": 0.71, "expected": "fresh", "reuse_latency": 25, "fresh_latency": 43, "reuse_drift": 0.56, "fresh_drift": 0.14},',
      '    {"id": "S4", "task_shift": 0.57, "evidence_delta": 0.62, "expected": "fresh", "reuse_latency": 23, "fresh_latency": 40, "reuse_drift": 0.45, "fresh_drift": 0.15},',
      "]",
      "",
      "",
      "def choose_policy(case: dict[str, float | str]) -> str:",
      '    return "fresh" if should_recompute(case["task_shift"], case["evidence_delta"]) else "reuse"',
      "",
      "",
      "def selected_metric(case: dict[str, float | str], policy: str, key: str) -> float:",
      '    return float(case[f"{policy}_{key}"])',
      "",
      "",
      "def main() -> None:",
      "    rows = []",
      "    for case in CASES:",
      "        policy = choose_policy(case)",
      '        correct = policy == case["expected"]',
      "        rows.append(",
      "            {",
      '                "id": case["id"],',
      '                "task_shift": case["task_shift"],',
      '                "evidence_delta": case["evidence_delta"],',
      '                "expected": case["expected"],',
      '                "selected_policy": policy,',
      '                "correct": correct,',
      '                "selected_latency": selected_metric(case, policy, "latency"),',
      '                "selected_drift": selected_metric(case, policy, "drift"),',
      "            }",
      "        )",
      "",
      '    accuracy = sum(1 for row in rows if row["correct"]) / len(rows)',
      '    mean_latency = statistics.mean(row["selected_latency"] for row in rows)',
      '    mean_drift = statistics.mean(row["selected_drift"] for row in rows)',
      "    summary = {",
      '        "accuracy": round(accuracy, 3),',
      '        "mean_latency": round(mean_latency, 2),',
      '        "mean_drift": round(mean_drift, 3),',
      '        "selected_reuse_cases": [row["id"] for row in rows if row["selected_policy"] == "reuse"],',
      '        "selected_fresh_cases": [row["id"] for row in rows if row["selected_policy"] == "fresh"],',
      '        "rows": rows,',
      "    }",
      "",
      '    results_dir = ROOT / "experiments" / "results"',
      "    results_dir.mkdir(parents=True, exist_ok=True)",
      '    (results_dir / "latest.json").write_text(json.dumps(summary, indent=2) + "\\n", encoding="utf8")',
      '    (results_dir / "latest.md").write_text(render_markdown(summary), encoding="utf8")',
      "",
      "",
      "def render_markdown(summary: dict[str, object]) -> str:",
      '    rows = summary["rows"]',
      "    lines = [",
      '        "# Latest Reuse Ablation",',
      '        "",',
      '        f"- accuracy: {summary[\"accuracy\"]}",',
      '        f"- mean latency: {summary[\"mean_latency\"]}",',
      '        f"- mean drift: {summary[\"mean_drift\"]}",',
      '        "",',
      '        "| Case | Expected | Selected | Correct |",',
      '        "| --- | --- | --- | --- |",',
      "    ]",
      "    for row in rows:",
      '        lines.append(f"| {row[\"id\"]} | {row[\"expected\"]} | {row[\"selected_policy\"]} | {row[\"correct\"]} |")',
      '    lines.extend(["", "Interpretation: higher accuracy with lower drift is better, but latency should remain materially below always-fresh recomputation."])',
      '    return "\\n".join(lines) + "\\n"',
      "",
      "",
      'if __name__ == "__main__":',
      "    main()",
      ""
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(workspacePath, "notes", "experiment-plan.md"),
    [
      "# Experiment Plan",
      "",
      "- Goal: turn preview reuse into a simple heuristic that still protects shifted tasks.",
      "- Pending: update `src/reuse_policy.py` so evidence delta matters alongside task shift.",
      "- Pending: rerun the local ablation and sync the paper wording to the measured outcome."
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(workspacePath, "paper", "sections", "results.md"),
    [
      "# Results",
      "",
      "Current draft: preview reuse is faster, but the trigger for recomputation is too vague.",
      "",
      "We still need a concrete heuristic and a fresh experiment run that justifies the paper claim."
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(workspacePath, "experiments", "results", "latest.md"),
    [
      "# Latest Reuse Ablation",
      "",
      "- accuracy: 0.333",
      "- mean latency: 22.33",
      "- mean drift: 0.348",
      "",
      "This file is stale and should be regenerated by the experiment script."
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(workspacePath, "experiments", "results", "latest.json"),
    JSON.stringify(
      {
        accuracy: 0.333,
        mean_latency: 22.33,
        mean_drift: 0.348,
        note: "stale baseline"
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  return workspacePath;
}

async function sendPromptAndWaitForDecision(
  page: Page,
  workspacePath: string,
  prompt: string,
  previousDecisionId: string | null
) {
  await sendPrompt(page, prompt);
  return await waitForNewDecision(workspacePath, previousDecisionId, overallTimeoutMs);
}

async function sendPrompt(page: Page, prompt: string) {
  const textarea = page.locator("textarea.composer-input");
  const sendButton = page.locator("button.send-button");

  await textarea.click();
  await textarea.fill(prompt);
  await page.waitForTimeout(250);

  if ((await textarea.inputValue()).trim() !== prompt.trim()) {
    throw new Error("Composer value did not match the intended prompt.");
  }

  await sendButton.waitFor({ state: "visible", timeout: 10_000 });

  if (await sendButton.isDisabled()) {
    throw new Error("Composer send button stayed disabled.");
  }

  await textarea.press("Enter");
}

async function clickAutomationButton(page: Page, ariaLabel: string) {
  const button = page.locator(`button[aria-label="${ariaLabel}"]`).first();
  await button.waitFor({ state: "visible", timeout: 60_000 });

  if (await button.isDisabled()) {
    throw new Error(`${ariaLabel} button was disabled.`);
  }

  await button.click();
}

async function waitForNewDecision(
  workspacePath: string,
  previousDecisionId: string | null,
  timeoutMs: number
) {
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

async function waitForNewBuilderRequest(
  workspacePath: string,
  previousCount: number,
  timeoutMs: number
) {
  await waitForPromptLogCount(workspacePath, "builder.request", previousCount + 1, timeoutMs);
}

async function waitForPromptLogCount(
  workspacePath: string,
  kind: string,
  minimumCount: number,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readPromptLog(workspacePath);

    if (countEntries(entries, kind) >= minimumCount) {
      return;
    }

    await sleep(1500);
  }

  throw new Error(`Timed out waiting for ${kind} count ${minimumCount}.`);
}

async function waitForAutomationStatus(
  page: Page,
  workspacePath: string,
  statuses: string[],
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = await snapshotSummary(page, workspacePath);

    if (snapshot.latestAutomationStatus && statuses.includes(snapshot.latestAutomationStatus)) {
      return snapshot;
    }

    await page.waitForTimeout(1500);
  }

  throw new Error(`Timed out waiting for automation status ${statuses.join(", ")}.`);
}

async function waitForRunState(
  page: Page,
  workspacePath: string,
  predicate: (snapshot: SnapshotSummary) => boolean,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = await snapshotSummary(page, workspacePath);

    if (predicate(snapshot)) {
      return snapshot;
    }

    await page.waitForTimeout(1500);
  }

  throw new Error("Timed out waiting for the expected run state.");
}

async function snapshotSummary(page: Page, workspacePath: string): Promise<SnapshotSummary> {
  return await page.evaluate(async (targetWorkspacePath) => {
    const snapshot = await window.lithium.getProjectSnapshot(targetWorkspacePath);

    return {
      activeThreadId: snapshot.activeThreadId ?? null,
      activeThreadTitle: snapshot.activeThread?.title ?? null,
      activeThreadSummary: snapshot.activeThread?.summary ?? null,
      latestDecisionId: snapshot.latestDecision?.id ?? null,
      latestDecisionSummary: snapshot.latestDecision?.summary ?? null,
      latestRunId: snapshot.latestRun?.id ?? null,
      latestRunStatus: snapshot.latestRun?.status ?? null,
      latestRunPrompt: snapshot.latestRun?.prompt ?? null,
      latestRunDisplayPrompt: snapshot.latestRun?.displayPrompt ?? null,
      latestRunChangedFiles: snapshot.latestRun?.changedFiles ?? [],
      latestAutomationSessionId: snapshot.latestAutomationSession?.id ?? null,
      latestAutomationStatus: snapshot.latestAutomationSession?.status ?? null,
      latestAutomationObjective: snapshot.latestAutomationSession?.objective ?? null,
      latestCheckpointId: snapshot.latestAutomationCheckpoint?.id ?? null,
      latestCheckpointSummary: snapshot.latestAutomationCheckpoint?.summary ?? null
    };
  }, workspacePath);
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

async function readWorkspaceFile(filePath: string) {
  return await readFile(filePath, "utf8").catch(() => "");
}

function countEntries(entries: PromptLogEntry[], kind: string) {
  return entries.filter((entry) => entry.kind === kind).length;
}

function areSameThread(snapshots: SnapshotSummary[]) {
  const ids = snapshots.map((snapshot) => snapshot.activeThreadId).filter(Boolean);
  return ids.length > 0 && new Set(ids).size === 1;
}

function assertLongSessionReport(report: LongSessionReport) {
  if (!report.evidence.sameThreadAcrossWholeSession) {
    throw new Error("The long session drifted across multiple threads.");
  }

  if (report.evidence.strategistResponseCount < 3) {
    throw new Error("Expected at least three strategist responses in the long session.");
  }

  if (report.evidence.builderResponseCount < 2) {
    throw new Error("Expected at least two builder responses across the autopilot session.");
  }

  if (report.evidence.interruptCount < 1 || report.evidence.checkpointApprovalCount < 1) {
    throw new Error("The long session did not exercise interrupt and resume through the composer.");
  }

  if (!report.evidence.codeTouched) {
    throw new Error("The long session never touched code artifacts.");
  }

  if (!report.evidence.experimentTouched) {
    throw new Error("The long session never touched experiment or notes artifacts.");
  }

  if (!report.evidence.paperTouched) {
    throw new Error("The long session never touched paper artifacts.");
  }

  if (!report.keyFiles.experimentJson.trim() || !report.keyFiles.experimentMarkdown.trim()) {
    throw new Error("The long session did not leave behind fresh experiment outputs.");
  }

  if (!report.keyFiles.paperResults.trim()) {
    throw new Error("The long session did not leave behind a paper results update.");
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
