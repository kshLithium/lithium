import type {
  AppSettings,
  EvaluationRecord,
  ResearchBranchRecord,
  ResearchObjectiveRecord,
  ResearchPatchPromotionStatus,
  ResearchRunRecord,
  ResearchWorkItemRecord,
  ResearchWorktreeLeaseRecord,
  RunRecord
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
import { RecordStore } from "../services/record-store";

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
  handoff?: ReturnType<typeof parseBuilderOutput>;
  patchArtifactPath?: string;
  lease?: ResearchWorktreeLeaseRecord;
  runRecord?: RunRecord;
  evaluatorDecision?: EvaluatorDecision;
  promotionStatus?: ResearchPatchPromotionStatus;
  promotionError?: string;
  infraFailure?: boolean;
};

export class WorkerGateway {
  private readonly records = new RecordStore();

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
  }): Promise<WorkerDispatchResult> {
    try {
      switch (input.workItem.executor) {
        case "oracle-planner":
          return await this.runOraclePlanner(input);
        case "oracle-research":
          return await this.runOracleResearch(input);
        case "evaluator":
          return await this.runEvaluator(input);
        case "experiment-run":
        case "builder-edit":
        default:
          return await this.runCodex(input);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const infraFailure =
        input.workItem.executor === "oracle-planner" || input.workItem.executor === "oracle-research";

      await this.deps.stateStore.appendWorkerHistory(input.workspacePath, {
        kind: "worker.error",
        executor: input.workItem.executor,
        workItemId: input.workItem.id,
        runId: input.run.id,
        message
      });

      return {
        summary: message,
        status: "failed",
        changedFiles: [],
        risks: [message],
        openQuestions: [],
        runActions: [],
        infraFailure
      };
    }
  }

  async promotePatchArtifact(input: {
    workspacePath: string;
    workItem: ResearchWorkItemRecord;
    evaluation: EvaluationRecord;
  }) {
    const shouldPromote =
      input.workItem.executor === "builder-edit" &&
      (input.evaluation.verdict === "continue" || input.evaluation.verdict === "complete");

    if (!shouldPromote) {
      return {
        promotionStatus: "skipped" as const
      };
    }

    const result = await this.deps.artifactService.promotePatchArtifact({
      workspacePath: input.workspacePath,
      patchArtifactPath: input.workItem.patchArtifactPath
    });

    await this.deps.stateStore.appendWorkerHistory(input.workspacePath, {
      kind: "patch.promotion",
      workItemId: input.workItem.id,
      status: result.status,
      patchArtifactPath: input.workItem.patchArtifactPath ?? null,
      error: result.error ?? null
    });

    return {
      promotionStatus: result.status,
      promotionError: result.error
    };
  }

  async releaseLease(input: {
    workspacePath: string;
    lease?: ResearchWorktreeLeaseRecord;
  }) {
    if (!input.lease) {
      return null;
    }

    return await this.deps.worktreeManager.releaseLease(input.workspacePath, input.lease);
  }

  private async runOraclePlanner(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerDispatchResult> {
    await this.appendDispatchLogs(input.workspacePath, input.run.id, input.workItem, input.runtimeContext);
    const result = await this.deps.oracleWorkerPool.runPlannerTask({
      workspacePath: input.workspacePath,
      runId: input.run.id,
      objectiveTitle: input.objective.title,
      objectiveSummary: input.objective.summary,
      branchTitle: input.branch?.title,
      runtimeContext: input.runtimeContext,
      workItem: input.workItem
    });
    return {
      summary: result.handoff.summary,
      status: "completed",
      changedFiles: [],
      risks: result.handoff.risks ?? [],
      openQuestions: result.handoff.openQuestions ?? [],
      runActions: result.handoff.runActions ?? [],
      oracleSessionSlug: result.oracleSessionSlug,
      handoff: result.handoff
    };
  }

  private async runOracleResearch(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerDispatchResult> {
    if (!input.branch) {
      throw new Error(`Branch not found for research work item ${input.workItem.id}`);
    }

    await this.appendDispatchLogs(input.workspacePath, input.run.id, input.workItem, input.runtimeContext);
    const result = await this.deps.oracleWorkerPool.runResearchTask({
      workspacePath: input.workspacePath,
      runId: input.run.id,
      objectiveTitle: input.objective.title,
      objectiveSummary: input.objective.summary,
      branchTitle: input.branch.title,
      runtimeContext: input.runtimeContext,
      workItem: input.workItem
    });
    return {
      summary: result.handoff.summary,
      status: "completed",
      changedFiles: [],
      risks: result.handoff.risks ?? [],
      openQuestions: result.handoff.openQuestions ?? [],
      runActions: result.handoff.runActions ?? [],
      oracleSessionSlug: result.oracleSessionSlug,
      handoff: result.handoff
    };
  }

  private async runEvaluator(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerDispatchResult> {
    const branchTitle = input.branch?.title ?? "Active branch";
    await this.appendDispatchLogs(input.workspacePath, input.run.id, input.workItem, input.runtimeContext);
    const result = await this.deps.evaluatorRunner.evaluate({
      workspacePath: input.workspacePath,
      branchTitle,
      workItemTitle: input.workItem.title,
      executionSummary: input.workItem.prompt,
      runtimeContext: input.runtimeContext
    });
    return {
      summary: result.decision.summary,
      status: "completed",
      changedFiles: [],
      risks: [],
      openQuestions: [],
      runActions: result.decision.followupPrompt ? [result.decision.followupPrompt] : [],
      evaluatorDecision: result.decision
    };
  }

  private async runCodex(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerDispatchResult> {
    const appSettings = await this.readAppSettings();
    const runPaths = await this.deps.artifactService.allocateRunArtifacts(input.workspacePath);
    const lease =
      input.workItem.isolation === "worktree"
        ? await this.deps.worktreeManager.acquireLease(input.workspacePath, input.workItem.id)
        : undefined;
    const worktreePath = lease?.worktreePath;
    const executionContext = await resolveWorkspaceCommandContext(worktreePath ?? input.workspacePath);

    await this.appendDispatchLogs(input.workspacePath, input.run.id, input.workItem, input.runtimeContext);
    const result = await this.deps.codexRunner.runTask({
      workspacePath: input.workspacePath,
      commandCwd: executionContext.commandCwd,
      prompt: input.workItem.prompt,
      runtimeContext: input.runtimeContext,
      model: appSettings.builderModel,
      reasoningEffort: appSettings.builderReasoningEffort,
      promptLanguage: appSettings.autopilotPromptLanguage,
      stdoutPath: runPaths.stdoutPath,
      stderrPath: runPaths.stderrPath,
      outputPath: runPaths.outputPath,
      env: executionContext.env
    });
    const handoff = parseBuilderOutput(result.finalMessage);
    const changedFiles = mergeChangedFiles(
      parseChangedFilesFromFinalMessage(result.finalMessage),
      await collectGitChangedFiles(executionContext.commandCwd)
    );
    const status = inferExecutionStatus(result.exitCode, result.timedOut);
    const patchArtifactPath =
      input.workItem.executor === "builder-edit" || input.workItem.executor === "experiment-run"
        ? await this.deps.artifactService.capturePatchArtifact({
            workspacePath: input.workspacePath,
            workItemId: input.workItem.id,
            worktreePath
          })
        : null;
    const runRecord: RunRecord = {
      id: runPaths.id,
      threadId: input.objective.id,
      taskId: input.workItem.id,
      prompt: input.workItem.prompt,
      displayPrompt: input.workItem.title,
      model: appSettings.builderModel,
      status,
      exitCode: result.exitCode,
      pid: null,
      command: result.command,
      stdoutPath: runPaths.stdoutPath,
      stderrPath: runPaths.stderrPath,
      finalMessagePath: runPaths.outputPath,
      finalMessage: result.finalMessage,
      handoff,
      changedFiles,
      finalization: "auto",
      createdAt: result.startedAt,
      startedAt: result.startedAt,
      endedAt: result.endedAt
    };
    await this.records.writeJson(runPaths.jsonPath, runRecord);
    await this.deps.stateStore.appendWorkerHistory(input.workspacePath, {
      kind: "worker.completed",
      executor: input.workItem.executor,
      workItemId: input.workItem.id,
      runId: input.run.id,
      patchArtifactPath,
      changedFiles
    });

    const { experimentResult } = await this.deps.artifactService.recordExperiment({
      workspacePath: input.workspacePath,
      workItem: input.workItem,
      runRecord,
      summary: extractFinalSummary(result.finalMessage) || handoff.summary || "Codex work item completed.",
      worktreePath,
      patchArtifactPath: patchArtifactPath ?? undefined
    });

    return {
      summary: extractFinalSummary(result.finalMessage) || handoff.summary || "Codex work item completed.",
      status,
      changedFiles,
      risks: handoff.risks ?? [],
      openQuestions: handoff.openQuestions ?? [],
      runActions: handoff.runActions ?? [],
      handoff,
      runId: runRecord.id,
      worktreePath,
      patchArtifactPath: patchArtifactPath ?? undefined,
      lease,
      runRecord,
      promotionStatus: experimentResult ? "skipped" : "pending"
    };
  }

  private async readAppSettings() {
    return await this.deps.getAppSettings?.().catch(() => DEFAULT_APP_SETTINGS) ?? DEFAULT_APP_SETTINGS;
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
      `dispatch ${workItem.executor ?? "builder-edit"} ${workItem.id} "${workItem.title}"`
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
