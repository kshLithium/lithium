import path from "node:path";
import type {
  ArtifactRef,
  BranchRecord,
  ExperimentManifest,
  ExperimentTaskPayload,
  MetricMeasurement,
  PromoteTaskPayload,
  TaskOutcome,
  TaskRecord,
  WorkerRunRecord
} from "../../../shared/types";
import { startCommand } from "../../services/process-runner";
import { resolveWorkspaceCommandContext } from "../../services/workspace-execution";
import { ArtifactStore } from "../artifact-store";
import { createId, nowIso } from "../utils";
import { WorkerLeaseManager } from "../worker-lease-manager";
import { ResearchStore } from "../store";
import { isPidAlive, terminateByPid, waitForPidExit } from "./process-recovery";
import type { ProviderContext, ProviderHandle, ProviderRecoveryContext, TaskProvider } from "./types";

export class ExperimentProvider implements TaskProvider {
  constructor(
    private readonly deps: {
      artifactStore: ArtifactStore;
      leaseManager: WorkerLeaseManager;
      store: ResearchStore;
    }
  ) {}

  supports(kind: TaskRecord["kind"]) {
    return kind === "verify_change" || kind === "run_experiment" || kind === "promote_patch";
  }

  async start(context: ProviderContext): Promise<ProviderHandle> {
    if (context.task.kind === "promote_patch") {
      const payload = context.task.payload as PromoteTaskPayload;
      const artifacts = await this.deps.artifactStore.allocateRunArtifacts(context.workspacePath, "worker", createId("promote"));
      const workerRun: WorkerRunRecord = {
        id: artifacts.id,
        taskId: context.task.id,
        runId: context.run.id,
        objectiveId: context.objective.id,
        branchId: context.task.branchId,
        provider: "experimenter",
        command: {
          command: "git",
          args: ["apply", "--3way", payload.patchArtifactRef.path],
          cwd: context.workspacePath
        },
        status: "running",
        pid: null,
        stdoutPath: artifacts.stdoutPath,
        stderrPath: artifacts.stderrPath,
        outputPath: artifacts.outputPath,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        startedAt: nowIso()
      };
      return {
        workerRun,
        terminate: () => undefined,
        result: (async () => {
          const result = await this.deps.leaseManager.promotePatchArtifact(context.workspacePath, payload.patchArtifactRef.path);
          return {
            status: result.promotionStatus === "promoted" ? "completed" : "failed",
            summary: result.promotionStatus === "promoted" ? "Patch promoted." : result.promotionError || "Patch promotion failed.",
            failureReason: result.promotionStatus === "promoted" ? undefined : result.promotionError,
            retryability: "needs-human",
            artifactRefs: [payload.patchArtifactRef],
            changedFiles: [],
            metrics: [],
            promotion: {
              status: result.promotionStatus === "promoted" ? "promoted" : "failed",
              summary: result.promotionStatus === "promoted" ? "Patch promoted." : result.promotionError || "Patch promotion failed."
            }
          } satisfies TaskOutcome;
        })()
      };
    }

    if (!context.branch) {
      throw new Error(`Branch not found for experiment task ${context.task.id}`);
    }

    const payload = context.task.payload as ExperimentTaskPayload;
    const spec = this.deps.store.readProjection(context.workspacePath, "experiment_spec", payload.experimentSpecId);
    if (!spec) {
      throw new Error(`Experiment spec ${payload.experimentSpecId} is missing for task ${context.task.id}`);
    }
    if (spec.mode !== "read-only") {
      throw new Error(`Experiment spec ${spec.id} violates the read-only contract.`);
    }

    const leaseInfo = await this.deps.leaseManager.ensureLease({
      workspacePath: context.workspacePath,
      branch: context.branch,
      taskId: context.task.id,
      mode: "read"
    });
    const execution = await resolveWorkspaceCommandContext(leaseInfo.branch.worktreePath!);
    const commandCwd = resolveSpecCommandCwd(execution.commandCwd, spec.cwd);
    const artifacts = await this.deps.artifactStore.allocateRunArtifacts(context.workspacePath, "worker", createId("experiment"));
    const command = buildExperimentCommand(spec.commands);
    const session = await startCommand({
      spec: {
        command: "/bin/zsh",
        args: ["-lc", command],
        cwd: commandCwd
      },
      timeoutMs: spec.timeoutMs,
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
        cwd: commandCwd
      },
      status: "running",
      pid: session.pid,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      outputPath: artifacts.outputPath,
      worktreePath: leaseInfo.branch.worktreePath,
      tempDir: leaseInfo.lease.tempDir,
      metadata: {
        experimentSpecId: spec.id,
        commands: spec.commands,
        expectedMetrics: spec.expectedMetrics,
        mode: spec.mode
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
    if (context.task.kind === "promote_patch") {
      return null;
    }
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
    const spec = this.deps.store.readProjection(input.workspacePath, "experiment_spec", payload.experimentSpecId);
    if (!spec) {
      return {
        status: "failed",
        summary: "Experiment spec disappeared before finalization.",
        failureReason: "Experiment spec missing",
        retryability: "needs-human",
        artifactRefs: [],
        changedFiles: [],
        metrics: []
      };
    }

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
      ? await this.deps.leaseManager.listChangedFiles(input.workerRun.worktreePath, {
          trackedOnly: true
        }).catch(() => [])
      : [];

    let branch = input.branch;
    let contractViolation: string | undefined;
    const artifactRefs: ArtifactRef[] = [stdoutRef, stderrRef];
    if (changedFiles.length > 0 && input.workerRun.worktreePath) {
      contractViolation = "Read-only experiment mutated tracked files.";
      const patchBuild = await this.deps.leaseManager.buildWorkingTreePatch(input.branch);
      if (patchBuild.changed && patchBuild.patch) {
        artifactRefs.push(await this.deps.artifactStore.writePatchArtifact(input.workspacePath, input.task.id, patchBuild.patch));
      }
      branch = await this.deps.leaseManager.restoreBranchWorkspace(input.workspacePath, input.branch);
    }

    const manifest: ExperimentManifest = {
      experimentSpecId: spec.id,
      commands: spec.commands,
      exitCode: input.exitCode ?? null,
      status:
        contractViolation || input.timedOut
          ? "failed"
          : input.exitCode === 0 || input.exitCode === undefined
            ? "completed"
            : "failed",
      stdoutPath: input.workerRun.stdoutPath,
      stderrPath: input.workerRun.stderrPath,
      outputPath: input.workerRun.outputPath,
      artifacts: artifactRefs.map((entry) => entry.path),
      metrics,
      expectations: spec.expectedMetrics,
      contractViolation
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
        contractViolation
          ? contractViolation
          : manifest.status === "completed"
            ? input.task.kind === "verify_change"
              ? "Verification completed."
              : "Experiment completed."
            : input.timedOut
              ? "Experiment timed out."
              : "Experiment failed.",
      failureReason:
        contractViolation ||
        (manifest.status === "completed"
          ? undefined
          : stderr.split("\n").find(Boolean) || stdout.split("\n").find(Boolean) || undefined),
      retryability: "needs-human",
      artifactRefs,
      changedFiles,
      metrics,
      experimentManifest: manifest,
      providerMetadata: {
        branch
      }
    };
  }
}

function buildExperimentCommand(commands: string[]) {
  return commands.filter(Boolean).join("\n");
}

function resolveSpecCommandCwd(workspaceRoot: string, relativeCwd: string) {
  const resolved = path.resolve(workspaceRoot, relativeCwd);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`ExperimentSpec.cwd escapes the workspace root: ${relativeCwd}`);
  }
  return resolved;
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
