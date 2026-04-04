import path from "node:path";
import type {
  ArtifactRef,
  BranchRecord,
  ExperimentManifest,
  ExperimentTaskPayload,
  MetricMeasurement,
  TaskOutcome,
  TaskRecord,
  WorkerRunRecord
} from "../../../shared/types";
import { startCommand } from "../../services/process-runner";
import { resolveWorkspaceCommandContext } from "../../services/workspace-execution";
import { ArtifactStore } from "../artifact-store";
import { createId, nowIso } from "../utils";
import { WorkerLeaseManager } from "../worker-lease-manager";
import { isPidAlive, terminateByPid, waitForPidExit } from "./process-recovery";
import type { ProviderContext, ProviderHandle, ProviderRecoveryContext, TaskProvider } from "./types";

export class ExperimentProvider implements TaskProvider {
  constructor(
    private readonly deps: {
      artifactStore: ArtifactStore;
      leaseManager: WorkerLeaseManager;
    }
  ) {}

  supports(kind: TaskRecord["kind"]) {
    return kind === "run_experiment";
  }

  async start(context: ProviderContext): Promise<ProviderHandle> {
    if (!context.branch) {
      throw new Error(`Branch not found for experiment task ${context.task.id}`);
    }

    const payload = context.task.payload as ExperimentTaskPayload;
    const leaseInfo = await this.deps.leaseManager.ensureLease({
      workspacePath: context.workspacePath,
      branch: context.branch,
      taskId: context.task.id
    });
    const execution = await resolveWorkspaceCommandContext(leaseInfo.branch.worktreePath!);
    const artifacts = await this.deps.artifactStore.allocateRunArtifacts(context.workspacePath, "worker", createId("experiment"));
    const command = buildExperimentCommand(payload.commands);
    const session = await startCommand({
      spec: {
        command: "/bin/zsh",
        args: ["-lc", command],
        cwd: execution.commandCwd
      },
      timeoutMs: payload.timeoutMs,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      env: {
        ...execution.env,
        ...this.deps.leaseManager.buildRuntimeEnv(leaseInfo.lease.tempDir)
      }
    });

    const workerRun: WorkerRunRecord = {
      id: artifacts.id,
      taskId: context.task.id,
      runId: context.run.id,
      objectiveId: context.objective.id,
      branchId: context.branch.id,
      provider: "experimenter",
      command: {
        command: "/bin/zsh",
        args: ["-lc", command],
        cwd: execution.commandCwd
      },
      status: "running",
      pid: session.pid,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      outputPath: artifacts.outputPath,
      worktreePath: leaseInfo.branch.worktreePath,
      tempDir: leaseInfo.lease.tempDir,
      metadata: {
        commands: payload.commands,
        expectedMetrics: payload.expectedMetrics
      },
      createdAt: session.startedAt,
      updatedAt: session.startedAt,
      startedAt: session.startedAt
    };

    return {
      workerRun,
      lease: leaseInfo.lease,
      terminate: session.terminate,
      result: session.result.then((result) =>
        this.finalize({
          workspacePath: context.workspacePath,
          task: context.task,
          branch: leaseInfo.branch,
          workerRun,
          exitCode: result.exitCode,
          timedOut: result.timedOut
        })
      )
    };
  }

  async recover(context: ProviderRecoveryContext): Promise<ProviderHandle | null> {
    if (!(await isPidAlive(context.workerRun.pid))) {
      return null;
    }

    return {
      workerRun: context.workerRun,
      lease: context.lease ?? undefined,
      terminate: (signal) => terminateByPid(context.workerRun.pid, signal),
      result: (async () => {
        await waitForPidExit(context.workerRun.pid!);
        return await this.finalize({
          workspacePath: context.workspacePath,
          task: context.task,
          branch: context.branch,
          workerRun: context.workerRun
        });
      })()
    };
  }

  private async finalize(input: {
    workspacePath: string;
    task: TaskRecord;
    branch: BranchRecord | null;
    workerRun: WorkerRunRecord;
    exitCode?: number | null;
    timedOut?: boolean;
  }): Promise<TaskOutcome> {
    if (!input.branch) {
      return {
        status: "failed",
        summary: "Experiment branch disappeared before finalization.",
        failureReason: "Branch missing",
        retryability: "needs-human",
        artifactRefs: [],
        changedFiles: [],
        metrics: []
      };
    }

    const payload = input.task.payload as ExperimentTaskPayload;
    const stdoutRef: ArtifactRef = {
      id: createId("art"),
      kind: "stdout",
      path: input.workerRun.stdoutPath,
      createdAt: nowIso()
    };
    const stderrRef: ArtifactRef = {
      id: createId("art"),
      kind: "stderr",
      path: input.workerRun.stderrPath,
      createdAt: nowIso()
    };
    const stdout = await this.deps.artifactStore.readText(stdoutRef);
    const stderr = await this.deps.artifactStore.readText(stderrRef);
    const metrics = parseMetrics(`${stdout}\n${stderr}`);
    const changedFiles = input.workerRun.worktreePath
      ? await this.deps.leaseManager.listChangedFiles(input.workerRun.worktreePath).catch(() => [])
      : [];
    const committed = await this.deps.leaseManager.commitIfDirty({
      workspacePath: input.workspacePath,
      branch: input.branch,
      message: `Lithium V4 experiment task ${input.task.id}`
    });
    const patchBuild = await this.deps.leaseManager.buildPromotionPatch({
      workspacePath: input.workspacePath,
      branch: committed.branch,
      fromCommit:
        typeof input.workerRun.metadata?.promotionHeadCommit === "string"
          ? input.workerRun.metadata.promotionHeadCommit
          : committed.branch.promotionHeadCommit ?? committed.branch.baseCommit
    });
    const artifactRefs: ArtifactRef[] = [stdoutRef, stderrRef];
    if (patchBuild.changed && patchBuild.patch) {
      artifactRefs.push(await this.deps.artifactStore.writePatchArtifact(input.workspacePath, input.task.id, patchBuild.patch));
    }
    const manifest: ExperimentManifest = {
      commands: payload.commands,
      exitCode: input.exitCode ?? null,
      status: input.timedOut ? "failed" : input.exitCode === 0 || input.exitCode === undefined ? "completed" : "failed",
      stdoutPath: input.workerRun.stdoutPath,
      stderrPath: input.workerRun.stderrPath,
      outputPath: input.workerRun.outputPath,
      artifacts: artifactRefs.map((entry) => entry.path),
      metrics,
      expectations: payload.expectedMetrics
    };
    artifactRefs.push(
      await this.deps.artifactStore.writeJsonArtifact({
        directory: path.dirname(input.workerRun.stdoutPath),
        fileName: `${input.task.id}.manifest.json`,
        value: manifest,
        kind: "manifest"
      })
    );

    return {
      status: manifest.status,
      summary:
        manifest.status === "completed"
          ? "Experiment completed."
          : input.timedOut
            ? "Experiment timed out."
            : "Experiment failed.",
      failureReason: manifest.status === "completed" ? undefined : stderr.split("\n").find(Boolean) || stdout.split("\n").find(Boolean) || undefined,
      retryability: manifest.status === "completed" ? "needs-human" : "retryable",
      artifactRefs,
      changedFiles,
      metrics,
      experimentManifest: manifest,
      providerMetadata: {
        branch: committed.branch
      }
    };
  }
}

function buildExperimentCommand(commands: string[]) {
  return commands.filter(Boolean).join("\n");
}

function parseMetrics(text: string): MetricMeasurement[] {
  const metrics = new Map<string, MetricMeasurement>();
  const matches = text.matchAll(/\b([A-Za-z][A-Za-z0-9_.-]{1,40})\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*([A-Za-z%/_-]+)?/g);
  for (const match of matches) {
    const name = match[1];
    const value = Number(match[2]);
    if (!name || !Number.isFinite(value)) {
      continue;
    }
    metrics.set(name, {
      name,
      value,
      unit: match[3] || undefined
    });
  }
  return [...metrics.values()];
}
