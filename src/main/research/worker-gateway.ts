import path from "node:path";
import type {
  AppSettings,
  DiscoverSourceSpec,
  EvaluationRecord,
  ExperimentManifest,
  LithiumHandoff,
  ResearchBranchRecord,
  ResearchObjectiveRecord,
  ResearchPatchPromotionStatus,
  ResearchRunRecord,
  ResearchWorkItemRecord,
  RunExperimentTaskPayload,
  WorkerRunRecord
} from "../../shared/types";
import {
  collectGitChangedFiles,
  extractFinalSummary,
  mergeChangedFiles,
  parseChangedFilesFromFinalMessage
} from "../services/run-artifacts";
import { parseBuilderOutput } from "../services/protocol";
import { resolveWorkspaceCommandContext } from "../services/workspace-execution";
import { CodexRunner } from "../services/codex-runner";
import { DEFAULT_APP_SETTINGS } from "../../shared/types";
import { EvaluatorRunner, type EvaluatorDecision } from "./evaluator-runner";
import { OracleWorkerPool } from "./oracle-worker-pool";
import { ArtifactService } from "./artifact-service";
import { ResearchStateStore } from "./state-store";
import { WorktreeManager } from "./worktree-manager";
import { startCommand } from "../services/process-runner";
import { buildProjectPaths } from "../services/workspace-layout";

export type WorkerDispatchResult = {
  summary: string;
  status: "completed" | "failed" | "cancelled";
  changedFiles: string[];
  risks: string[];
  openQuestions: string[];
  runActions: string[];
  runId?: string;
  worktreePath?: string;
  oracleSessionSlug?: string;
  handoff?: LithiumHandoff;
  patchArtifactPath?: string;
  runRecord?: WorkerRunRecord;
  evaluatorDecision?: EvaluatorDecision;
  promotionStatus?: ResearchPatchPromotionStatus;
  promotionError?: string;
  infraFailure?: boolean;
  discoveredSources?: DiscoverSourceSpec[];
  synthesizedFindings?: Array<{
    summary: string;
    detail?: string;
    sourceLocator: string;
    citationText?: string;
  }>;
  experimentManifest?: ExperimentManifest;
  branch?: ResearchBranchRecord;
};

export type WorkerExecutionHandle = {
  terminate: () => void;
  deadlineAt?: string;
  oracleSessionSlug?: string;
  worktreePath?: string;
  resultPromise: Promise<WorkerDispatchResult>;
};

export class WorkerGateway {
  constructor(
    private readonly deps: {
      stateStore: ResearchStateStore;
      oracleWorkerPool: OracleWorkerPool;
      evaluatorRunner: EvaluatorRunner;
      codexRunner: CodexRunner;
      worktreeManager: WorktreeManager;
      artifactService: ArtifactService;
      getAppSettings?: () => Promise<AppSettings>;
    }
  ) {}

  async supportsWorkspace(workspacePath: string) {
    return await this.deps.worktreeManager.supportsWorkspace(workspacePath);
  }

  async dispatch(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerExecutionHandle> {
    await this.appendDispatchLogs(input.workspacePath, input.run.id, input.workItem, input.runtimeContext);

    switch (input.workItem.kind) {
      case "plan":
        return await this.startPlanner(input);
      case "discover":
        return await this.startDiscover(input);
      case "read_synthesize":
        return await this.startReadSynthesis(input);
      case "build_change":
        return await this.startBuilder(input);
      case "run_experiment":
        return await this.startExperiment(input);
      case "evaluate_branch":
        return await this.startEvaluator(input);
      case "arbitrate_branch":
        return this.startArbiter(input);
      default:
        return this.startArbiter(input);
    }
  }

  async promotePatchArtifact(input: {
    workspacePath: string;
    workItem: ResearchWorkItemRecord;
    evaluation: EvaluationRecord;
    branch: ResearchBranchRecord | null;
  }) {
    const shouldPromote =
      input.workItem.kind === "build_change" &&
      input.workItem.executor !== "experimenter" &&
      (input.evaluation.verdict === "continue" || input.evaluation.verdict === "complete");

    if (!shouldPromote || !input.branch?.worktreePath) {
      return {
        promotionStatus: "skipped" as const
      };
    }

    const patch = await this.deps.artifactService.readPatchArtifact(input.workItem.patchArtifactPath);
    if (!patch.trim()) {
      return {
        promotionStatus: "skipped" as const
      };
    }

    const commandContext = await resolveWorkspaceCommandContext(input.workspacePath);
    const paths = buildProjectPaths(input.workspacePath);
    const checkSession = await startCommand({
      spec: {
        command: "git",
        args: ["apply", "--check", input.workItem.patchArtifactPath!],
        cwd: commandContext.commandCwd
      },
      stdoutPath: path.join(paths.logsDir, "promotion-check.stdout.log"),
      stderrPath: path.join(paths.logsDir, "promotion-check.stderr.log")
    });
    const checkResult = await checkSession.result;

    if (checkResult.exitCode !== 0) {
      return {
        promotionStatus: "failed" as const,
        promotionError: "Patch promotion gate failed: clean apply check did not pass."
      };
    }

    const applySession = await startCommand({
      spec: {
        command: "git",
        args: ["apply", "--3way", input.workItem.patchArtifactPath!],
        cwd: commandContext.commandCwd
      },
      stdoutPath: path.join(paths.logsDir, "promotion-apply.stdout.log"),
      stderrPath: path.join(paths.logsDir, "promotion-apply.stderr.log")
    });
    const applyResult = await applySession.result;

    return applyResult.exitCode === 0
      ? { promotionStatus: "promoted" as const }
      : {
          promotionStatus: "failed" as const,
          promotionError: "Patch promotion gate failed while applying the patch."
        };
  }

  private async startPlanner(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerExecutionHandle> {
    const session = await this.deps.oracleWorkerPool.startPlannerTask({
      workspacePath: input.workspacePath,
      runId: input.run.id,
      objectiveTitle: input.objective.title,
      objectiveSummary: input.objective.summary,
      activeBranchTitle: input.branch?.title,
      runtimeContext: input.runtimeContext,
      task: input.workItem
    });

    return {
      terminate: () => session.terminate("SIGTERM"),
      deadlineAt: resolveDeadline(input.workItem, 5 * 60_000),
      oracleSessionSlug: session.oracleSessionSlug,
      resultPromise: session.result.then((result) => ({
        summary: result.handoff.summary,
        status: "completed",
        changedFiles: [],
        risks: result.handoff.risks ?? [],
        openQuestions: result.handoff.openQuestions ?? [],
        runActions: result.handoff.runActions ?? [],
        oracleSessionSlug: result.oracleSessionSlug,
        handoff: result.handoff
      }))
    };
  }

  private async startDiscover(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerExecutionHandle> {
    if (!input.branch) {
      throw new Error(`Branch not found for discover task ${input.workItem.id}`);
    }

    const session = await this.deps.oracleWorkerPool.startDiscoverTask({
      workspacePath: input.workspacePath,
      runId: input.run.id,
      objectiveTitle: input.objective.title,
      branchTitle: input.branch.title,
      runtimeContext: input.runtimeContext,
      task: input.workItem
    });

    return {
      terminate: () => session.terminate("SIGTERM"),
      deadlineAt: resolveDeadline(input.workItem, 10 * 60_000),
      oracleSessionSlug: session.oracleSessionSlug,
      resultPromise: session.result.then((result) => ({
        summary: result.summary,
        status: "completed",
        changedFiles: [],
        risks: [],
        openQuestions: [],
        runActions: [],
        oracleSessionSlug: result.oracleSessionSlug,
        discoveredSources: result.sources
      }))
    };
  }

  private async startReadSynthesis(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerExecutionHandle> {
    if (!input.branch) {
      throw new Error(`Branch not found for synthesis task ${input.workItem.id}`);
    }

    const files = await this.collectSourceFiles(input.workspacePath, input.workItem);
    const session = await this.deps.oracleWorkerPool.startReadSynthesisTask({
      workspacePath: input.workspacePath,
      runId: input.run.id,
      objectiveTitle: input.objective.title,
      branchTitle: input.branch.title,
      runtimeContext: input.runtimeContext,
      task: input.workItem,
      files
    });

    return {
      terminate: () => session.terminate("SIGTERM"),
      deadlineAt: resolveDeadline(input.workItem, 10 * 60_000),
      oracleSessionSlug: session.oracleSessionSlug,
      resultPromise: session.result.then((result) => ({
        summary: result.summary,
        status: "completed",
        changedFiles: [],
        risks: [],
        openQuestions: [],
        runActions: [],
        oracleSessionSlug: result.oracleSessionSlug,
        synthesizedFindings: result.findings
      }))
    };
  }

  private async startBuilder(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerExecutionHandle> {
    if (!input.branch) {
      throw new Error(`Branch not found for builder task ${input.workItem.id}`);
    }

    const appSettings = await this.readAppSettings();
    const ensuredBranch = await this.deps.worktreeManager.ensureBranchWorkspace(input.workspacePath, input.branch);
    const runPaths = await this.deps.artifactService.allocateWorkerRunArtifacts(input.workspacePath, "worker");
    const executionContext = await resolveWorkspaceCommandContext(ensuredBranch.worktreePath!);
    const session = await this.deps.codexRunner.startTask({
      workspacePath: input.workspacePath,
      commandCwd: executionContext.commandCwd,
      prompt: input.workItem.prompt,
      runtimeContext: input.runtimeContext,
      model: appSettings.builderModel,
      reasoningEffort: appSettings.builderReasoningEffort,
      promptLanguage: appSettings.promptLanguage,
      stdoutPath: runPaths.stdoutPath,
      stderrPath: runPaths.stderrPath,
      outputPath: runPaths.outputPath,
      timeoutMs: input.workItem.timeoutPolicy?.wallMs ?? 20 * 60_000,
      env: executionContext.env
    });

    return {
      terminate: () => session.terminate("SIGTERM"),
      deadlineAt: resolveDeadline(input.workItem, 20 * 60_000),
      worktreePath: ensuredBranch.worktreePath,
      resultPromise: session.result.then(async (result) => {
        const handoff = parseBuilderOutput(result.finalMessage);
        const changedFiles = mergeChangedFiles(
          parseChangedFilesFromFinalMessage(result.finalMessage),
          await collectGitChangedFiles(executionContext.commandCwd)
        );
        const committed = await this.deps.worktreeManager.commitIfDirty({
          workspacePath: input.workspacePath,
          branch: ensuredBranch,
          message: `Lithium builder task ${input.workItem.id}`
        });
        const patchBuild = await this.deps.worktreeManager.buildPromotionPatch({
          workspacePath: input.workspacePath,
          branch: committed.branch,
          fromCommit: committed.branch.promotionHeadCommit ?? committed.branch.baseCommit ?? null,
          outputPath: path.join(runPaths.jsonPath, "..", `${input.workItem.id}.patch`)
        });
        const patchArtifactPath =
          patchBuild.changed && patchBuild.patch
            ? await this.deps.artifactService.writePatchArtifact(
                input.workspacePath,
                input.workItem.id,
                patchBuild.patch
              )
            : undefined;
        const runRecord: WorkerRunRecord = {
          id: runPaths.id,
          objectiveId: input.objective.id,
          branchId: ensuredBranch.id,
          taskId: input.workItem.id,
          prompt: input.workItem.prompt,
          displayPrompt: input.workItem.title,
          model: appSettings.builderModel,
          status: inferExecutionStatus(result.exitCode, result.timedOut),
          exitCode: result.exitCode,
          pid: session.pid,
          command: result.command,
          stdoutPath: runPaths.stdoutPath,
          stderrPath: runPaths.stderrPath,
          finalMessagePath: runPaths.outputPath,
          finalMessage: result.finalMessage,
          handoff,
          changedFiles,
          finalization: "auto",
          createdAt: result.startedAt,
          updatedAt: result.endedAt,
          startedAt: result.startedAt,
          endedAt: result.endedAt
        };

        return {
          summary: extractFinalSummary(result.finalMessage) || handoff.summary || "Builder task completed.",
          status: inferExecutionStatus(result.exitCode, result.timedOut),
          changedFiles,
          risks: handoff.risks ?? [],
          openQuestions: handoff.openQuestions ?? [],
          runActions: handoff.runActions ?? [],
          handoff,
          runId: runRecord.id,
          worktreePath: committed.branch.worktreePath,
          patchArtifactPath,
          runRecord,
          branch: committed.branch
        };
      })
    };
  }

  private async startExperiment(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerExecutionHandle> {
    if (!input.branch) {
      throw new Error(`Branch not found for experiment task ${input.workItem.id}`);
    }

    const payload = input.workItem.payload as RunExperimentTaskPayload | undefined;
    const ensuredBranch = await this.deps.worktreeManager.ensureBranchWorkspace(input.workspacePath, input.branch);
    let activeTerminate: (() => void) | null = null;
    let cancelled = false;

    return {
      terminate: () => {
        cancelled = true;
        activeTerminate?.();
      },
      deadlineAt: resolveDeadline(input.workItem, payload?.timeoutMs ?? 20 * 60_000),
      worktreePath: ensuredBranch.worktreePath,
      resultPromise: (async () => {
        const commands = payload?.commands?.length ? payload.commands : [input.workItem.prompt];
        const metrics = new Map<string, number>();
        const artifacts: string[] = [];
        let lastStdoutPath: string | undefined;
        let lastStderrPath: string | undefined;
        let lastOutputPath: string | undefined;
        let finalExitCode: number | null = 0;

        for (let index = 0; index < commands.length; index += 1) {
          if (cancelled) {
            return {
              summary: "Experiment cancelled.",
              status: "cancelled" as const,
              changedFiles: [],
              risks: [],
              openQuestions: [],
              runActions: []
            };
          }

          const command = commands[index]!;
          const runPaths = await this.deps.artifactService.allocateWorkerRunArtifacts(input.workspacePath, "worker");
          const session = await startCommand({
            spec: {
              command: "/bin/zsh",
              args: ["-lc", command],
              cwd: ensuredBranch.worktreePath!
            },
            timeoutMs: payload?.timeoutMs ?? 20 * 60_000,
            stdoutPath: runPaths.stdoutPath,
            stderrPath: runPaths.stderrPath
          });
          activeTerminate = () => session.terminate("SIGTERM");
          const commandResult = await session.result;
          finalExitCode = commandResult.exitCode;
          lastStdoutPath = runPaths.stdoutPath;
          lastStderrPath = runPaths.stderrPath;
          lastOutputPath = runPaths.outputPath;
          artifacts.push(runPaths.stdoutPath, runPaths.stderrPath);
          const stdout = await import("node:fs/promises").then((fs) => fs.readFile(runPaths.stdoutPath, "utf8").catch(() => ""));
          const stderr = await import("node:fs/promises").then((fs) => fs.readFile(runPaths.stderrPath, "utf8").catch(() => ""));
          parseMetricsFromText(`${stdout}\n${stderr}`, metrics);

          if (commandResult.exitCode !== 0 || commandResult.timedOut) {
            const manifest: ExperimentManifest = {
              commands,
              exitCode: commandResult.exitCode,
              status: commandResult.timedOut ? "failed" : "failed",
              stdoutPath: lastStdoutPath,
              stderrPath: lastStderrPath,
              outputPath: lastOutputPath,
              artifacts,
              metrics: [...metrics.entries()].map(([name, value]) => ({ name, value })),
              expectations: payload?.expectedMetrics ?? []
            };
            return {
              summary: `Experiment failed while running: ${command}`,
              status: "failed" as const,
              changedFiles: [],
              risks: [command],
              openQuestions: [],
              runActions: [],
              experimentManifest: manifest,
              worktreePath: ensuredBranch.worktreePath,
              branch: ensuredBranch
            };
          }
        }

        const branchUpdate = await this.deps.worktreeManager.commitIfDirty({
          workspacePath: input.workspacePath,
          branch: ensuredBranch,
          message: `Lithium experiment task ${input.workItem.id}`
        });
        const manifest: ExperimentManifest = {
          commands,
          exitCode: finalExitCode,
          status: cancelled ? "cancelled" : "completed",
          stdoutPath: lastStdoutPath,
          stderrPath: lastStderrPath,
          outputPath: lastOutputPath,
          artifacts,
          metrics: [...metrics.entries()].map(([name, value]) => ({ name, value })),
          expectations: payload?.expectedMetrics ?? []
        };

        return {
          summary: "Experiment completed.",
          status: cancelled ? "cancelled" as const : "completed" as const,
          changedFiles: [],
          risks: [],
          openQuestions: [],
          runActions: [],
          experimentManifest: manifest,
          worktreePath: branchUpdate.branch.worktreePath,
          branch: branchUpdate.branch
        };
      })()
    };
  }

  private async startEvaluator(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerExecutionHandle> {
    const branchTitle = input.branch?.title ?? "Active branch";
    const session = await this.deps.evaluatorRunner.startEvaluate({
      workspacePath: input.workspacePath,
      branchTitle,
      workItemTitle: input.workItem.title,
      executionSummary: input.workItem.prompt,
      runtimeContext: input.runtimeContext
    });

    return {
      terminate: () => session.terminate("SIGTERM"),
      deadlineAt: resolveDeadline(input.workItem, 5 * 60_000),
      resultPromise: session.result.then((result) => ({
        summary: result.decision.summary,
        status: "completed",
        changedFiles: [],
        risks: [],
        openQuestions: [],
        runActions: result.decision.followupPrompt ? [result.decision.followupPrompt] : [],
        evaluatorDecision: result.decision
      }))
    };
  }

  private startArbiter(input: {
    workItem: ResearchWorkItemRecord;
  }): WorkerExecutionHandle {
    return {
      terminate: () => undefined,
      deadlineAt: resolveDeadline(input.workItem, 30_000),
      resultPromise: Promise.resolve({
        summary: "Arbiter decision ready.",
        status: "completed",
        changedFiles: [],
        risks: [],
        openQuestions: [],
        runActions: []
      })
    };
  }

  private async collectSourceFiles(workspacePath: string, workItem: ResearchWorkItemRecord) {
    if (!workItem.sourceIds.length) {
      return [] as string[];
    }

    const sources = await this.deps.stateStore.listSources(workspacePath);
    const artifacts = await this.deps.stateStore.listSourceArtifacts(workspacePath);
    const artifactBySourceId = new Map(artifacts.map((record) => [record.sourceId, record.path]));

    return workItem.sourceIds
      .map((sourceId) => {
        const source = sources.find((entry) => entry.id === sourceId);
        return source ? artifactBySourceId.get(source.id) ?? source.artifactPath ?? "" : "";
      })
      .filter(Boolean);
  }

  private async readAppSettings() {
    return (await this.deps.getAppSettings?.().catch(() => DEFAULT_APP_SETTINGS)) ?? DEFAULT_APP_SETTINGS;
  }

  private async appendDispatchLogs(
    workspacePath: string,
    runId: string,
    workItem: ResearchWorkItemRecord,
    runtimeContext: string
  ) {
    await this.deps.stateStore.appendPromptLog(workspacePath, {
      runId,
      workItemId: workItem.id,
      executor: workItem.executor,
      prompt: workItem.prompt,
      runtimeContext
    });
    await this.deps.stateStore.appendActivity(
      workspacePath,
      `dispatch ${workItem.executor ?? workItem.kind} ${workItem.id} "${workItem.title}"`
    );
    await this.deps.stateStore.appendWorkerHistory(workspacePath, {
      kind: "worker.dispatch",
      runId,
      workItemId: workItem.id,
      executor: workItem.executor
    });
  }
}

function inferExecutionStatus(exitCode: number | null, timedOut: boolean): "completed" | "failed" | "cancelled" {
  if (timedOut) {
    return "failed";
  }

  return exitCode === 0 ? "completed" : "failed";
}

function resolveDeadline(workItem: ResearchWorkItemRecord, defaultWallMs: number) {
  const wallMs = workItem.timeoutPolicy?.wallMs ?? defaultWallMs;
  return new Date(Date.now() + wallMs).toISOString();
}

function parseMetricsFromText(rawText: string, sink: Map<string, number>) {
  const matches = [
    ...rawText.matchAll(/([A-Za-z][A-Za-z0-9_.\-\/ ]{1,48})\s*[:=]\s*(-?\d+(?:\.\d+)?)/g)
  ];

  for (const match of matches.slice(0, 20)) {
    const name = match[1]?.trim().replace(/\s+/g, " ");
    const value = Number(match[2]);
    if (!name || !Number.isFinite(value)) {
      continue;
    }
    sink.set(name, value);
  }
}
