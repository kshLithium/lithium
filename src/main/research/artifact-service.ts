import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type {
  ExperimentResultRecord,
  ExperimentSpecRecord,
  MetricRecord,
  ResearchWorkItemRecord,
  RunRecord
} from "../../shared/types";
import { RecordStore } from "../services/record-store";
import { createArtifactPaths, type ArtifactPaths, buildProjectPaths } from "../services/workspace-layout";
import { resolveWorkspaceGitRoot } from "../services/workspace-execution";
import { ResearchStateStore } from "./state-store";

const execFileAsync = promisify(execFile);

export class ArtifactService {
  private readonly records = new RecordStore();

  constructor(private readonly deps: { stateStore: ResearchStateStore }) {}

  async allocateRunArtifacts(workspacePath: string): Promise<ArtifactPaths> {
    const paths = buildProjectPaths(workspacePath);
    const id = await this.records.nextId(paths.runsDir, "R");
    await mkdir(paths.runsDir, { recursive: true });
    return createArtifactPaths(paths.runsDir, id);
  }

  async capturePatchArtifact(input: {
    workspacePath: string;
    workItemId: string;
    worktreePath?: string;
  }) {
    if (!input.worktreePath) {
      return null;
    }

    const paths = buildProjectPaths(input.workspacePath);
    await mkdir(paths.researchPatchesDir, { recursive: true });
    const patchArtifactPath = path.join(paths.researchPatchesDir, `${input.workItemId}.patch`);
    const { stdout } = await execFileAsync("git", ["diff", "--binary", "HEAD", "--"], {
      cwd: input.worktreePath,
      maxBuffer: 10 * 1024 * 1024
    }).catch(() => ({ stdout: "" }));

    if (!stdout.trim()) {
      return null;
    }

    await writeFile(patchArtifactPath, stdout, "utf8");
    return patchArtifactPath;
  }

  async promotePatchArtifact(input: {
    workspacePath: string;
    patchArtifactPath?: string;
  }): Promise<{ status: "promoted" | "skipped" | "failed"; error?: string }> {
    if (!input.patchArtifactPath) {
      return { status: "skipped" };
    }

    const gitRoot = await resolveWorkspaceGitRoot(input.workspacePath);

    if (!gitRoot) {
      return { status: "failed", error: "Patch promotion requires a git-backed workspace." };
    }

    try {
      await execFileAsync("git", ["apply", "--3way", input.patchArtifactPath], {
        cwd: gitRoot,
        maxBuffer: 10 * 1024 * 1024
      });
      return { status: "promoted" };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
          ? error
          : "Failed to apply the patch artifact.";
      return { status: "failed", error: message };
    }
  }

  async recordExperiment(input: {
    workspacePath: string;
    workItem: ResearchWorkItemRecord;
    runRecord: RunRecord;
    summary: string;
    worktreePath?: string;
    patchArtifactPath?: string;
  }) {
    if (input.workItem.executor !== "experiment-run") {
      return {
        experimentSpec: null,
        experimentResult: null,
        metrics: [] as MetricRecord[]
      };
    }

    const now = new Date().toISOString();
    const experimentSpecId = (await this.deps.stateStore.allocateExperimentSpec(input.workspacePath)).id;
    const experimentResultId = (await this.deps.stateStore.allocateExperimentResult(input.workspacePath)).id;
    const experimentSpec: ExperimentSpecRecord = {
      id: experimentSpecId,
      objectiveId: input.workItem.objectiveId,
      branchId: input.workItem.branchId,
      threadId: input.workItem.threadId,
      workItemId: input.workItem.id,
      title: input.workItem.title,
      prompt: input.workItem.prompt,
      executor: "experiment-run",
      isolation: input.workItem.isolation ?? "worktree",
      worktreePath: input.worktreePath,
      createdAt: now,
      updatedAt: now
    };
    const experimentResult: ExperimentResultRecord = {
      id: experimentResultId,
      objectiveId: input.workItem.objectiveId,
      branchId: input.workItem.branchId,
      threadId: input.workItem.threadId,
      workItemId: input.workItem.id,
      experimentSpecId,
      runId: input.runRecord.id,
      status: normalizeTerminalRunStatus(input.runRecord.status),
      summary: input.summary,
      command: [input.runRecord.command.command, ...(input.runRecord.command.args ?? [])].join(" "),
      stdoutPath: input.runRecord.stdoutPath,
      stderrPath: input.runRecord.stderrPath,
      outputPath: input.runRecord.finalMessagePath,
      worktreePath: input.worktreePath,
      changedFiles: input.runRecord.changedFiles ?? [],
      patchArtifactPath: input.patchArtifactPath,
      createdAt: now,
      updatedAt: now
    };

    await this.deps.stateStore.writeExperimentSpec(input.workspacePath, experimentSpec);
    await this.deps.stateStore.writeExperimentResult(input.workspacePath, experimentResult);

    const metrics = await this.extractMetrics({
      workspacePath: input.workspacePath,
      workItem: input.workItem,
      experimentResultId,
      finalMessage: input.runRecord.finalMessage
    });

    return {
      experimentSpec,
      experimentResult,
      metrics
    };
  }

  async readRecentExperimentResults(workspacePath: string, objectiveId: string, limit = 5) {
    return (await this.deps.stateStore.listExperimentResults(workspacePath))
      .filter((entry) => entry.objectiveId === objectiveId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  async readPatchArtifact(patchArtifactPath?: string) {
    if (!patchArtifactPath) {
      return "";
    }

    return await readFile(patchArtifactPath, "utf8").catch(() => "");
  }

  private async extractMetrics(input: {
    workspacePath: string;
    workItem: ResearchWorkItemRecord;
    experimentResultId: string;
    finalMessage: string;
  }) {
    const matches = [...input.finalMessage.matchAll(/([A-Za-z][A-Za-z0-9_.\-\/ ]{1,48})\s*[:=]\s*(-?\d+(?:\.\d+)?)/g)];
    const seen = new Set<string>();
    const metrics: MetricRecord[] = [];
    const now = new Date().toISOString();

    for (const match of matches.slice(0, 10)) {
      const rawName = match[1]?.trim().replace(/\s+/g, " ");
      const value = Number(match[2]);

      if (!rawName || !Number.isFinite(value)) {
        continue;
      }

      const dedupeKey = `${rawName}:${value}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const metric: MetricRecord = {
        id: (await this.deps.stateStore.allocateMetric(input.workspacePath)).id,
        objectiveId: input.workItem.objectiveId,
        branchId: input.workItem.branchId,
        threadId: input.workItem.threadId,
        workItemId: input.workItem.id,
        experimentResultId: input.experimentResultId,
        name: rawName,
        value,
        createdAt: now,
        updatedAt: now
      };
      await this.deps.stateStore.writeMetric(input.workspacePath, metric);
      metrics.push(metric);
    }

    return metrics;
  }
}

function normalizeTerminalRunStatus(
  status: RunRecord["status"]
): ExperimentResultRecord["status"] {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
      return status;
    default:
      return "failed";
  }
}
