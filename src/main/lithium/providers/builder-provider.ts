import path from "node:path";
import type {
  AppSettings,
  ArtifactRef,
  BranchRecord,
  BuildTaskPayload,
  TaskOutcome,
  TaskRecord,
  WorkerRunRecord
} from "../../../shared/types";
import { CodexRunner } from "../../services/codex-runner";
import { parseBuilderStatus } from "../../services/protocol";
import { resolveWorkspaceCommandContext } from "../../services/workspace-execution";
import { ArtifactStore } from "../artifact-store";
import { ResearchStore } from "../store";
import { clamp01, createId, nowIso } from "../utils";
import { WorkerLeaseManager } from "../worker-lease-manager";
import { isPidAlive, terminateByPid, waitForPidExit } from "./process-recovery";
import type { ProviderContext, ProviderHandle, ProviderRecoveryContext, TaskProvider } from "./types";

export class BuilderProvider implements TaskProvider {
  constructor(
    private readonly deps: {
      codexRunner: CodexRunner;
      artifactStore: ArtifactStore;
      store: ResearchStore;
      leaseManager: WorkerLeaseManager;
      settings: AppSettings;
    }
  ) {}

  supports(kind: TaskRecord["kind"]) {
    return kind === "build_change";
  }

  async start(context: ProviderContext): Promise<ProviderHandle> {
    if (!context.branch) {
      throw new Error(`Branch not found for build task ${context.task.id}`);
    }

    const payload = context.task.payload as BuildTaskPayload;
    const leaseInfo = await this.deps.leaseManager.ensureLease({
      workspacePath: context.workspacePath,
      branch: context.branch,
      taskId: context.task.id,
      mode: "write"
    });
    const execution = await resolveWorkspaceCommandContext(leaseInfo.branch.worktreePath!);
    const artifacts = await this.deps.artifactStore.allocateRunArtifacts(context.workspacePath, "worker", createId("builder"));
    const session = await this.deps.codexRunner.startTask({
      workspacePath: context.workspacePath,
      commandCwd: execution.commandCwd,
      prompt: buildBuilderPrompt(context.task.prompt, payload),
      runtimeContext: context.contextText,
      model: this.deps.settings.builderModel,
      reasoningEffort: this.deps.settings.builderReasoningEffort,
      promptLanguage: this.deps.settings.promptLanguage,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      outputPath: artifacts.outputPath,
      timeoutMs: 20 * 60_000,
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
      provider: "builder",
      command: session.command,
      status: "running",
      pid: session.pid,
      model: this.deps.settings.builderModel,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      outputPath: artifacts.outputPath,
      worktreePath: leaseInfo.branch.worktreePath,
      tempDir: leaseInfo.lease.tempDir,
      metadata: {
        baseCommit: leaseInfo.branch.baseCommit ?? null,
        promotionHeadCommit: leaseInfo.branch.promotionHeadCommit ?? null
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
        summary: "Build branch disappeared before finalization.",
        failureReason: "Branch missing",
        retryability: "needs-human",
        artifactRefs: [],
        changedFiles: [],
        metrics: []
      };
    }

    const outputText = await this.deps.artifactStore.readText(
      input.workerRun.outputPath
        ? {
            id: createId("art"),
            kind: "output",
            path: input.workerRun.outputPath,
            createdAt: nowIso()
          }
        : null
    );
    const statusPayload = parseBuilderStatus(outputText);
    const changedFiles = input.workerRun.worktreePath
      ? await this.deps.leaseManager.listChangedFiles(input.workerRun.worktreePath).catch(() => [])
      : [];
    const committed = await this.deps.leaseManager.commitIfDirty({
      workspacePath: input.workspacePath,
      branch: input.branch,
      message: `Lithium V4 builder task ${input.task.id}`
    });
    const patchBuild = await this.deps.leaseManager.buildPromotionPatch({
      workspacePath: input.workspacePath,
      branch: committed.branch,
      fromCommit:
        typeof input.workerRun.metadata?.promotionHeadCommit === "string"
          ? input.workerRun.metadata.promotionHeadCommit
          : committed.branch.promotionHeadCommit ?? committed.branch.baseCommit
    });
    const artifactRefs: ArtifactRef[] = [
      {
        id: createId("art"),
        kind: "stdout",
        path: input.workerRun.stdoutPath,
        createdAt: nowIso()
      },
      {
        id: createId("art"),
        kind: "stderr",
        path: input.workerRun.stderrPath,
        createdAt: nowIso()
      }
    ];
    if (input.workerRun.outputPath) {
      artifactRefs.push({
        id: createId("art"),
        kind: "output",
        path: input.workerRun.outputPath,
        createdAt: nowIso()
      });
    }

    if (patchBuild.changed && patchBuild.patch) {
      artifactRefs.push(await this.deps.artifactStore.writePatchArtifact(input.workspacePath, input.task.id, patchBuild.patch));
    }

    if (!statusPayload.ok) {
      return {
        status: "failed",
        summary: "Builder output violated the structured protocol.",
        failureReason: statusPayload.error,
        retryability: "retryable",
        artifactRefs,
        changedFiles,
        metrics: [],
        providerMetadata: {
          branch: committed.branch
        }
      };
    }

    const resultTag = statusPayload.value.result;
    const inferredStatus =
      input.timedOut || input.exitCode === null
        ? "failed"
        : input.exitCode === 0
          ? resultTag === "failed"
            ? "failed"
            : "completed"
          : "failed";

    return {
      status: inferredStatus,
      summary: statusPayload.value.machineSummary || "Builder task finished.",
      failureReason: inferredStatus === "failed" ? statusPayload.value.risks[0] || "Builder execution failed." : undefined,
      retryability: inferredStatus === "failed" ? "needs-human" : "needs-human",
      artifactRefs,
      changedFiles: Array.from(new Set([...statusPayload.value.files, ...changedFiles])),
      metrics: [],
      providerMetadata: {
        successCriteria: statusPayload.value.successCriteria,
        runActions: statusPayload.value.runActions,
        openQuestions: statusPayload.value.openQuestions,
        branchScoreHint: clamp01(statusPayload.value.files.length > 0 ? 0.7 : 0.55),
        branch: committed.branch
      }
    };
  }
}

function buildBuilderPrompt(prompt: string, payload: BuildTaskPayload) {
  const lines = [
    prompt.trim(),
    payload.constraints.length > 0 ? `Constraints:\n- ${payload.constraints.join("\n- ")}` : null,
    payload.successCriteria.length > 0 ? `Success criteria:\n- ${payload.successCriteria.join("\n- ")}` : null
  ].filter((entry): entry is string => Boolean(entry));
  return lines.join("\n\n");
}
