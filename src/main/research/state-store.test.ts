import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchStateStore } from "./state-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe("ResearchStateStore", () => {
  it("migrates legacy automation state into an objective-first graph and archives legacy directories", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-research-state-"));
    tempDirs.push(workspacePath);
    const store = new ResearchStateStore();
    const lithiumRoot = path.join(workspacePath, ".lithium");
    const sessionsDir = path.join(lithiumRoot, "automation", "sessions");
    const checkpointsDir = path.join(lithiumRoot, "automation", "checkpoints");
    const decisionsDir = path.join(lithiumRoot, "decisions");
    const runsDir = path.join(lithiumRoot, "runs");
    const threadsDir = path.join(lithiumRoot, "threads");

    await Promise.all([
      mkdir(sessionsDir, { recursive: true }),
      mkdir(checkpointsDir, { recursive: true }),
      mkdir(decisionsDir, { recursive: true }),
      mkdir(runsDir, { recursive: true }),
      mkdir(threadsDir, { recursive: true })
    ]);

    await writeFile(
      path.join(sessionsDir, "AU001.json"),
      JSON.stringify({
        id: "AU001",
        threadId: "TH001",
        objective: "Find the next reproducible experiment.",
        displayObjective: "Find the next reproducible experiment.",
        mode: "continuous",
        status: "running",
        allowedActions: ["strategize", "experiment-run"],
        evidenceMode: "strict",
        budget: {
          maxSteps: 8,
          maxRuntimeMinutes: 60,
          maxRetries: 2,
          usedSteps: 0,
          usedRetries: 0
        },
        currentStepSummary: "Planning the next bounded step.",
        createdAt: "2026-04-04T00:00:00.000Z",
        updatedAt: "2026-04-04T00:00:00.000Z"
      }),
      "utf8"
    );
    await writeFile(
      path.join(checkpointsDir, "AC001.json"),
      JSON.stringify({
        id: "AC001",
        sessionId: "AU001",
        threadId: "TH001",
        status: "approved",
        title: "checkpoint",
        summary: "The latest direction is good enough to continue.",
        whatChanged: ["Added stronger evidence."],
        evidence: ["paper A"],
        risks: [],
        nextActions: ["Run the benchmark again."],
        createdAt: "2026-04-04T00:00:01.000Z",
        updatedAt: "2026-04-04T00:00:01.000Z"
      }),
      "utf8"
    );
    await writeFile(
      path.join(decisionsDir, "D001.json"),
      JSON.stringify({
        id: "D001",
        threadId: "TH001",
        prompt: "Review the branch portfolio.",
        rawOutput: "Strategist output",
        summary: "The baseline branch still looks strongest.",
        rationale: "The repo evidence still points there.",
        model: "gpt-5.4-pro",
        engine: "browser",
        status: "completed",
        command: { command: "npx", args: ["oracle"], cwd: workspacePath },
        stdoutPath: path.join(workspacePath, "d.stdout.log"),
        stderrPath: path.join(workspacePath, "d.stderr.log"),
        outputPath: path.join(workspacePath, "d.output.txt"),
        createdAt: "2026-04-04T00:00:01.000Z"
      }),
      "utf8"
    );
    await writeFile(
      path.join(runsDir, "R001.json"),
      JSON.stringify({
        id: "R001",
        threadId: "TH001",
        taskId: "T001",
        prompt: "Run the next benchmark.",
        model: "gpt-5.4",
        status: "completed",
        exitCode: 0,
        pid: null,
        command: { command: "codex", args: ["exec"], cwd: workspacePath },
        stdoutPath: path.join(workspacePath, "r.stdout.log"),
        stderrPath: path.join(workspacePath, "r.stderr.log"),
        finalMessagePath: path.join(workspacePath, "r.output.txt"),
        finalMessage: "Benchmark improved by 2 points.",
        changedFiles: ["results/latest.json"],
        finalization: "auto",
        createdAt: "2026-04-04T00:00:02.000Z",
        startedAt: "2026-04-04T00:00:02.000Z",
        endedAt: "2026-04-04T00:00:03.000Z"
      }),
      "utf8"
    );
    await writeFile(
      path.join(threadsDir, "TH001.json"),
      JSON.stringify({
        id: "TH001",
        title: "Legacy thread",
        summary: "",
        createdAt: "2026-04-04T00:00:00.000Z",
        updatedAt: "2026-04-04T00:00:00.000Z"
      }),
      "utf8"
    );

    const migration = await store.migrateLegacyWorkspace(workspacePath);
    const state = await store.readState(workspacePath, migration.objectiveId);
    const archivedDecision = await readFile(path.join(lithiumRoot, "legacy", "v2", "decisions", "D001.json"), "utf8");

    expect(migration.migrated).toBe(true);
    expect(state.objectives).toHaveLength(1);
    expect(state.runs).toHaveLength(1);
    expect(state.findings.length).toBeGreaterThanOrEqual(2);
    expect(state.latestObjective?.title).toContain("reproducible experiment");
    expect(JSON.parse(archivedDecision).id).toBe("D001");
  });
});
