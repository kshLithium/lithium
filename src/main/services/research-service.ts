import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ActiveWorkerProgressRecord,
  type AppSettings,
  type AttachmentImportRequest,
  type AttachmentKind,
  type AttachmentRecord,
  type BuilderReasoningEffort,
  type EvaluationRecord,
  type ObjectiveCreateRequest,
  type ObjectiveRunControlRequest,
  type ObjectiveSelectionRequest,
  type ProjectRecord,
  type ResearchObjectiveRecord,
  type ResearchRunRecord,
  type ResearchWorkItemRecord,
  type RunRecord,
  type WorkspaceSnapshot,
  DEFAULT_APP_SETTINGS
} from "../../shared/types";
import { extractFinalSummary, mergeChangedFiles, parseChangedFilesFromFinalMessage, collectGitChangedFiles } from "./run-artifacts";
import { parseBuilderOutput } from "./protocol";
import { RecordStore } from "./record-store";
import { buildProjectPaths, type ArtifactPaths } from "./workspace-layout";
import { resolveWorkspaceCommandContext } from "./workspace-execution";
import { CodexRunner } from "./codex-runner";
import { ChatgptAuthRunner } from "./chatgpt-auth-runner";
import { EvaluatorRunner } from "../research/evaluator-runner";
import { OracleWorkerPool } from "../research/oracle-worker-pool";
import { ResearchEngine } from "../research/engine";
import { ResearchStateStore } from "../research/state-store";
import { WorktreeManager } from "../research/worktree-manager";

type ResearchServiceDependencies = {
  stateStore?: ResearchStateStore;
  oracleWorkerPool?: OracleWorkerPool;
  evaluatorRunner?: EvaluatorRunner;
  codexRunner?: CodexRunner;
  chatgptAuthRunner?: Pick<ChatgptAuthRunner, "signIn" | "prepareReusableSession">;
  worktreeManager?: WorktreeManager;
  getAppSettings?: () => Promise<AppSettings>;
};

type RunControlState = {
  stopRequested: boolean;
};

type WorkItemExecutionResult = {
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
};

const DOCUMENT_ATTACHMENT_EXCERPT =
  "Document attachment. Reference the file path directly when asking the engine to inspect it.";
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".rtf",
  ".odt",
  ".ods",
  ".odp"
]);

export class ResearchService {
  private readonly records = new RecordStore();
  private readonly stateStore: ResearchStateStore;
  private readonly oracleWorkerPool: OracleWorkerPool;
  private readonly evaluatorRunner: EvaluatorRunner;
  private readonly codexRunner: CodexRunner;
  private readonly chatgptAuthRunner: Pick<ChatgptAuthRunner, "signIn" | "prepareReusableSession">;
  private readonly worktreeManager: WorktreeManager;
  private readonly engine: ResearchEngine;
  private readonly getAppSettings: () => Promise<AppSettings>;
  private readonly loopPromises = new Map<string, Promise<void>>();
  private readonly runControls = new Map<string, RunControlState>();
  private readonly activeProgress = new Map<string, ActiveWorkerProgressRecord>();
  private currentWorkspacePath: string;

  constructor(workspacePath: string, deps: ResearchServiceDependencies = {}) {
    this.currentWorkspacePath = workspacePath;
    this.stateStore = deps.stateStore ?? new ResearchStateStore();
    this.oracleWorkerPool = deps.oracleWorkerPool ?? new OracleWorkerPool();
    this.evaluatorRunner = deps.evaluatorRunner ?? new EvaluatorRunner();
    this.codexRunner = deps.codexRunner ?? new CodexRunner();
    this.chatgptAuthRunner = deps.chatgptAuthRunner ?? new ChatgptAuthRunner();
    this.worktreeManager = deps.worktreeManager ?? new WorktreeManager();
    this.engine = new ResearchEngine({
      stateStore: this.stateStore
    });
    this.getAppSettings = deps.getAppSettings ?? (async () => DEFAULT_APP_SETTINGS);
  }

  setSelectedWorkspacePath(workspacePath: string) {
    this.currentWorkspacePath = workspacePath;
  }

  async initWorkspace(workspacePath = this.currentWorkspacePath) {
    const project = await this.stateStore.initWorkspace(workspacePath);
    await this.stateStore.migrateLegacyWorkspace(workspacePath);
    await this.engine.recoverInterruptedRuns(workspacePath);
    const snapshot = await this.getWorkspaceSnapshot(workspacePath);

    if (!snapshot.activeObjective && snapshot.objectives.length === 0) {
      const created = await this.createObjective({
        workspacePath,
        title: project.name,
        objective: `Advance the next research outcome for ${project.name}.`
      });
      return created;
    }

    return snapshot;
  }

  async getWorkspaceSnapshot(workspacePath = this.currentWorkspacePath): Promise<WorkspaceSnapshot> {
    await this.stateStore.initWorkspace(workspacePath);
    const project = await this.stateStore.readProject(workspacePath);
    const activeObjectiveId = project?.activeObjectiveId?.trim() || null;
    const scoped = await this.stateStore.readState(workspacePath, activeObjectiveId);
    const activeObjective =
      scoped.latestObjective ??
      (await this.stateStore.readState(workspacePath)).latestObjective ??
      null;
    const objectiveId = activeObjective?.id ?? null;
    const activeState = objectiveId ? await this.stateStore.readState(workspacePath, objectiveId) : scoped;
    const attachments = await this.listAttachments(workspacePath, objectiveId);
    const latestBuilderRun = objectiveId ? await this.readLatestBuilderRun(workspacePath, objectiveId) : null;
    const logs = await this.readRecentLogs(workspacePath);

    return {
      project,
      activeObjectiveId: objectiveId,
      activeObjective,
      objectives: (await this.stateStore.readState(workspacePath)).objectives,
      activeRun:
        (activeObjective
          ? activeState.runs.find((entry) => entry.id === activeObjective.activeRunId) ?? activeState.latestRun
          : activeState.latestRun) ?? null,
      runs: activeState.runs,
      branches: activeState.branches,
      queue: activeState.workItems.filter((entry) => entry.status === "pending" || entry.status === "running"),
      recentFindings: activeState.findings.slice(0, 8),
      latestEvaluation: activeState.latestEvaluation,
      latestProjection: activeState.latestProjection,
      latestBuilderRun,
      attachments,
      activeWorkerProgress: this.listActiveProgress(workspacePath, objectiveId),
      logs
    };
  }

  async listObjectives(workspacePath = this.currentWorkspacePath) {
    return (await this.stateStore.readState(workspacePath)).objectives;
  }

  async createObjective(request: ObjectiveCreateRequest): Promise<WorkspaceSnapshot> {
    const workspacePath = request.workspacePath ?? this.currentWorkspacePath;
    const project = await this.stateStore.initWorkspace(workspacePath);
    const now = new Date().toISOString();
    const objectiveAllocation = await this.stateStore.allocateObjective(workspacePath);
    const branchAllocation = await this.stateStore.allocateBranch(workspacePath);
    const objectiveId = objectiveAllocation.id;
    const title = request.title?.trim() || request.objective.trim();
    const objective: ResearchObjectiveRecord = {
      id: objectiveId,
      threadId: objectiveId,
      title,
      objective: request.objective.trim(),
      summary: request.objective.trim(),
      status: "pending",
      successCriteria: request.successCriteria?.filter(Boolean) ?? [
        "Advance the highest-value branch with bounded work.",
        "Capture evidence and evaluations after each executed work item."
      ],
      activeBranchId: branchAllocation.id,
      sourceIds: [],
      branchIds: [branchAllocation.id],
      createdAt: now,
      updatedAt: now
    };
    await this.stateStore.writeObjective(workspacePath, objective);
    await this.stateStore.writeBranch(workspacePath, {
      id: branchAllocation.id,
      objectiveId,
      threadId: objectiveId,
      title: "Primary branch",
      hypothesis: request.objective.trim(),
      status: "active",
      score: 0.6,
      evidenceIds: [],
      sourceIds: [],
      findingIds: [],
      workItemIds: [],
      createdAt: now,
      updatedAt: now,
      lastUpdatedAt: now
    });
    await this.stateStore.writeProject(workspacePath, {
      ...(project as ProjectRecord),
      activeObjectiveId: objectiveId,
      updatedAt: now
    });
    await this.engine.materializeProjection(workspacePath, objectiveId);
    return await this.getWorkspaceSnapshot(workspacePath);
  }

  async selectObjective(request: ObjectiveSelectionRequest): Promise<WorkspaceSnapshot> {
    const workspacePath = request.workspacePath ?? this.currentWorkspacePath;
    const project = await this.stateStore.initWorkspace(workspacePath);
    const state = await this.stateStore.readState(workspacePath);
    const objective = state.objectives.find((entry) => entry.id === request.objectiveId);

    if (!objective) {
      throw new Error(`Objective not found: ${request.objectiveId}`);
    }

    await this.stateStore.writeProject(workspacePath, {
      ...project,
      activeObjectiveId: objective.id,
      updatedAt: new Date().toISOString()
    });
    await this.engine.materializeProjection(workspacePath, objective.id);
    return await this.getWorkspaceSnapshot(workspacePath);
  }

  async startRun(request: ObjectiveRunControlRequest = {}): Promise<WorkspaceSnapshot> {
    const workspacePath = request.workspacePath ?? this.currentWorkspacePath;
    const snapshot = await this.initWorkspace(workspacePath);
    const objective = resolveRequestedObjective(snapshot, request.objectiveId);

    if (!objective) {
      throw new Error("No active objective is available.");
    }

    if (!(await this.worktreeManager.supportsWorkspace(workspacePath))) {
      throw new Error("Objective runs require a git-backed workspace so builder and experiment work can run in isolated worktrees.");
    }

    const scoped = await this.stateStore.readState(workspacePath, objective.id);
    const existingActive = scoped.runs.find((entry) => entry.status === "active" || entry.status === "blocked" || entry.status === "paused") ?? null;
    const now = new Date().toISOString();

    if (existingActive?.status === "active") {
      this.ensureRunLoop(workspacePath, existingActive.id);
      return await this.getWorkspaceSnapshot(workspacePath);
    }

    if (existingActive?.status === "blocked") {
      return await this.getWorkspaceSnapshot(workspacePath);
    }

    let blockedReason: string | undefined;
    try {
      await this.chatgptAuthRunner.prepareReusableSession?.();
    } catch (error) {
      blockedReason = error instanceof Error ? error.message : String(error);
    }

    const run =
      existingActive ??
      ({
        id: (await this.stateStore.allocateRun(workspacePath)).id,
        objectiveId: objective.id,
        threadId: objective.id,
        status: blockedReason ? "blocked" : "active",
        blockedReason,
        slotBudget: {
          codexSlots: 1,
          oracleSlots: 2,
          maxTotalWorkItems: 12,
          completedWorkItems: 0
        },
        activeWorkItemIds: [],
        oracleSessionSlugs: [],
        worktreeLeases: [],
        createdAt: now,
        updatedAt: now,
        startedAt: now
      } satisfies ResearchRunRecord);

    await this.stateStore.writeRun(workspacePath, run);
    await this.stateStore.writeObjective(workspacePath, {
      ...objective,
      activeRunId: run.id,
      status: run.status === "active" ? "active" : objective.status,
      updatedAt: now
    });
    await this.engine.materializeProjection(workspacePath, objective.id);

    if (run.status === "active") {
      this.ensureRunLoop(workspacePath, run.id);
    }

    return await this.getWorkspaceSnapshot(workspacePath);
  }

  async pauseRun(request: ObjectiveRunControlRequest = {}) {
    const workspacePath = request.workspacePath ?? this.currentWorkspacePath;
    const snapshot = await this.getWorkspaceSnapshot(workspacePath);
    const run = resolveRequestedRun(snapshot, request.runId);

    if (!run) {
      throw new Error("No active run is available.");
    }

    this.getRunControl(workspacePath, run.id).stopRequested = true;
    await this.stateStore.writeRun(workspacePath, {
      ...run,
      status: "paused",
      updatedAt: new Date().toISOString()
    });
    if (snapshot.activeObjective) {
      await this.engine.materializeProjection(workspacePath, snapshot.activeObjective.id);
    }
    return await this.getWorkspaceSnapshot(workspacePath);
  }

  async resumeRun(request: ObjectiveRunControlRequest = {}) {
    const workspacePath = request.workspacePath ?? this.currentWorkspacePath;
    const snapshot = await this.getWorkspaceSnapshot(workspacePath);
    const run = resolveRequestedRun(snapshot, request.runId);

    if (!run) {
      throw new Error("No run is available to resume.");
    }

    if (run.status === "blocked") {
      await this.chatgptAuthRunner.prepareReusableSession?.();
    }

    await this.engine.resumeRun({
      workspacePath,
      run
    });
    this.ensureRunLoop(workspacePath, run.id);
    return await this.getWorkspaceSnapshot(workspacePath);
  }

  async stopRun(request: ObjectiveRunControlRequest = {}) {
    const workspacePath = request.workspacePath ?? this.currentWorkspacePath;
    const snapshot = await this.getWorkspaceSnapshot(workspacePath);
    const run = resolveRequestedRun(snapshot, request.runId);

    if (!run) {
      throw new Error("No run is available to stop.");
    }

    this.getRunControl(workspacePath, run.id).stopRequested = true;
    await this.stateStore.writeRun(workspacePath, {
      ...run,
      status: "failed",
      stopReason: "Run stopped by the user.",
      activeWorkItemIds: [],
      oracleSessionSlugs: [],
      updatedAt: new Date().toISOString(),
      endedAt: new Date().toISOString()
    });
    return await this.getWorkspaceSnapshot(workspacePath);
  }

  async importAttachments(request: AttachmentImportRequest) {
    const workspacePath = request.workspacePath ?? this.currentWorkspacePath;
    const snapshot = await this.getWorkspaceSnapshot(workspacePath);
    const objective = resolveRequestedObjective(snapshot, request.objectiveId);

    if (!objective) {
      throw new Error("Create or select an objective before importing attachments.");
    }

    const paths = buildProjectPaths(workspacePath);
    const existing = await this.listAttachmentRecords(workspacePath);

    for (const filePath of request.filePaths) {
      const absoluteSourcePath = path.resolve(filePath);
      const sourceStat = await stat(absoluteSourcePath);

      if (!sourceStat.isFile()) {
        continue;
      }

      const duplicate = existing.find(
        (record) =>
          record.objectiveId === objective.id &&
          record.sourcePath === absoluteSourcePath &&
          record.sizeBytes === sourceStat.size
      );

      if (duplicate) {
        continue;
      }

      const id = await this.records.nextId(paths.attachmentRecordsDir, "A");
      const objectiveDir = path.join(paths.workspaceAttachmentsDir, objective.id);
      await mkdir(objectiveDir, { recursive: true });
      const fileName = `${id}-${path.basename(absoluteSourcePath)}`;
      const absoluteDestinationPath = path.join(objectiveDir, fileName);
      await copyFile(absoluteSourcePath, absoluteDestinationPath);
      const relativePath = path.relative(workspacePath, absoluteDestinationPath);
      const now = new Date().toISOString();
      const record: AttachmentRecord = {
        id,
        threadId: objective.id,
        objectiveId: objective.id,
        name: fileName,
        relativePath,
        sourcePath: absoluteSourcePath,
        kind: classifyAttachmentKind(absoluteDestinationPath),
        sizeBytes: sourceStat.size,
        excerpt: await buildAttachmentExcerpt(absoluteDestinationPath),
        importedAt: now,
        updatedAt: now
      };
      await this.records.writeJson(path.join(paths.attachmentRecordsDir, `${id}.json`), record);
    }

    return await this.getWorkspaceSnapshot(workspacePath);
  }

  async prepareOracleSignIn() {
    await this.chatgptAuthRunner.signIn?.();
    await this.chatgptAuthRunner.prepareReusableSession?.();
  }

  async getQueueView(workspacePath = this.currentWorkspacePath) {
    return (await this.getWorkspaceSnapshot(workspacePath)).queue;
  }

  async getEvidenceView(workspacePath = this.currentWorkspacePath) {
    const snapshot = await this.getWorkspaceSnapshot(workspacePath);
    return {
      findings: snapshot.recentFindings,
      evaluation: snapshot.latestEvaluation,
      projection: snapshot.latestProjection
    };
  }

  private ensureRunLoop(workspacePath: string, runId: string) {
    const key = `${workspacePath}::${runId}`;
    const existing = this.loopPromises.get(key);

    if (existing) {
      return existing;
    }

    const loop = this.processRunLoop(workspacePath, runId).finally(() => {
      this.loopPromises.delete(key);
      this.runControls.delete(key);
    });
    this.loopPromises.set(key, loop);
    return loop;
  }

  private async processRunLoop(workspacePath: string, runId: string) {
    while (true) {
      const snapshot = await this.getWorkspaceSnapshot(workspacePath);
      const objective = snapshot.activeObjective;
      const run = snapshot.runs.find((entry) => entry.id === runId) ?? snapshot.activeRun;

      if (!objective || !run || run.status !== "active") {
        return;
      }

      const control = this.getRunControl(workspacePath, run.id);
      if (control.stopRequested) {
        return;
      }

      const runtimeContext = await this.buildRuntimeContext(workspacePath, objective.id);
      await this.engine.ensureRunnableQueue({
        workspacePath,
        objective,
        run,
        runtimeContext
      });

      const batch = await this.engine.pickDispatchBatch({
        workspacePath,
        objectiveId: objective.id,
        runId: run.id
      });

      if (!batch) {
        return;
      }

      const selected = [...batch.oracleWorkItems, ...(batch.codexWorkItem ? [batch.codexWorkItem] : [])];

      if (selected.length === 0) {
        await this.engine.materializeProjection(workspacePath, objective.id);
        return;
      }

      await this.engine.markWorkItemsRunning({
        workspacePath,
        run: batch.run,
        workItems: selected
      });
      selected.forEach((workItem) => this.setProgress(workspacePath, run.id, objective.id, workItem));

      const results = await Promise.allSettled(
        selected.map(async (workItem) => ({
          workItem,
          result: await this.executeWorkItem({
            workspacePath,
            objective,
            run,
            workItem,
            runtimeContext
          })
        }))
      );

      for (const settled of results) {
        if (settled.status !== "fulfilled") {
          continue;
        }

        const { workItem, result } = settled.value;
        this.clearProgress(workspacePath, run.id, workItem.id);
        const currentState = await this.stateStore.readState(workspacePath, objective.id);
        const currentRun = currentState.runs.find((entry) => entry.id === run.id) ?? currentState.latestRun;
        const currentObjective = currentState.latestObjective ?? objective;

        if (!currentRun) {
          continue;
        }

        if (result.status === "failed" && (workItem.executor === "oracle-planner" || workItem.executor === "oracle-research")) {
          await this.stateStore.writeWorkItem(workspacePath, {
            ...workItem,
            status: "blocked",
            updatedAt: new Date().toISOString(),
            oracleSessionSlug: result.oracleSessionSlug ?? workItem.oracleSessionSlug
          });
          await this.engine.blockRun({
            workspacePath,
            run: currentRun,
            reason: result.summary
          });
          continue;
        }

        const evaluation = await this.createEvaluation({
          workspacePath,
          objective: currentObjective,
          workItem,
          executionSummary: result.summary,
          runtimeContext,
          executionStatus: result.status
        });

        if (workItem.executor === "oracle-planner" && result.handoff) {
          await this.engine.applyPlannerHandoff({
            workspacePath,
            objective: currentObjective,
            run: currentRun,
            workItem,
            handoff: result.handoff,
            oracleSessionSlug: result.oracleSessionSlug ?? workItem.oracleSessionSlug ?? workItem.id
          });
        }

        await this.engine.finalizeOutcome({
          workspacePath,
          objective: currentObjective,
          run: currentRun,
          workItem,
          summary: result.summary,
          status: result.status,
          evaluation,
          changedFiles: result.changedFiles,
          risks: result.risks,
          openQuestions: result.openQuestions,
          runActions: result.runActions,
          handoff: result.handoff,
          runId: result.runId,
          worktreePath: result.worktreePath,
          oracleSessionSlug: result.oracleSessionSlug
        });
      }

      await this.engine.materializeProjection(workspacePath, objective.id);
    }
  }

  private async executeWorkItem(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkItemExecutionResult> {
    switch (input.workItem.executor) {
      case "oracle-planner": {
        const branch = await this.resolveBranch(input.workspacePath, input.workItem.branchId);
        const result = await this.oracleWorkerPool.runPlannerTask({
          workspacePath: input.workspacePath,
          runId: input.run.id,
          objectiveTitle: input.objective.title,
          objectiveSummary: input.objective.summary,
          branchTitle: branch?.title,
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
      case "oracle-research": {
        const branch = await this.resolveBranch(input.workspacePath, input.workItem.branchId);

        if (!branch) {
          throw new Error(`Branch not found for research work item ${input.workItem.id}`);
        }

        const result = await this.oracleWorkerPool.runResearchTask({
          workspacePath: input.workspacePath,
          runId: input.run.id,
          objectiveTitle: input.objective.title,
          objectiveSummary: input.objective.summary,
          branchTitle: branch.title,
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
      case "builder-edit":
      case "experiment-run":
      case "evaluator":
      default:
        return await this.executeCodexWorkItem(input);
    }
  }

  private async executeCodexWorkItem(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkItemExecutionResult> {
    if (input.workItem.executor === "evaluator") {
      return {
        summary: input.workItem.prompt,
        status: "completed",
        changedFiles: [],
        risks: [],
        openQuestions: [],
        runActions: []
      };
    }

    const paths = buildProjectPaths(input.workspacePath);
    const runPaths = await this.allocateRunArtifacts(paths);
    const worktreePath =
      input.workItem.isolation === "worktree"
        ? (await this.worktreeManager.prepareRunWorkspace(input.workspacePath, input.workItem.id)).worktreePath
        : undefined;
    const executionContext = await resolveWorkspaceCommandContext(worktreePath ?? input.workspacePath);
    const appSettings = await this.getAppSettings().catch(() => DEFAULT_APP_SETTINGS);
    const reasoningEffort = resolveReasoningEffort(appSettings.builderReasoningEffort);

    const result = await this.codexRunner.runTask({
      workspacePath: input.workspacePath,
      commandCwd: executionContext.commandCwd,
      prompt: input.workItem.prompt,
      runtimeContext: input.runtimeContext,
      model: appSettings.builderModel,
      reasoningEffort,
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
    const status = inferRunCompletionStatus(result.exitCode, result.timedOut);
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

    return {
      summary: extractFinalSummary(result.finalMessage) || handoff.summary || "Codex work item completed.",
      status,
      changedFiles,
      risks: handoff.risks ?? [],
      openQuestions: handoff.openQuestions ?? [],
      runActions: handoff.runActions ?? [],
      handoff,
      runId: runRecord.id,
      worktreePath
    };
  }

  private async createEvaluation(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    workItem: ResearchWorkItemRecord;
    executionSummary: string;
    runtimeContext: string;
    executionStatus: "completed" | "failed" | "cancelled";
  }) {
    const branch = await this.resolveBranch(input.workspacePath, input.workItem.branchId);

    if (!branch) {
      throw new Error(`Branch not found for evaluation of ${input.workItem.id}`);
    }

    const result = await this.evaluatorRunner.evaluate({
      workspacePath: input.workspacePath,
      branchTitle: branch.title,
      workItemTitle: input.workItem.title,
      executionSummary: input.executionSummary,
      runtimeContext: input.runtimeContext
    });
    const allocation = await this.stateStore.allocateEvaluation(input.workspacePath);
    const now = new Date().toISOString();

    return {
      id: allocation.id,
      objectiveId: input.objective.id,
      branchId: branch.id,
      threadId: input.objective.id,
      workItemId: input.workItem.id,
      verdict: input.executionStatus === "failed" ? "kill" : result.decision.verdict,
      scoreDelta: input.executionStatus === "failed" ? Math.min(result.decision.scoreDelta, -0.1) : result.decision.scoreDelta,
      summary: result.decision.summary,
      rationale: result.decision.rationale,
      followupPrompt: result.decision.followupPrompt,
      createdAt: now,
      updatedAt: now
    } satisfies EvaluationRecord;
  }

  private async buildRuntimeContext(workspacePath: string, objectiveId: string) {
    const state = await this.stateStore.readState(workspacePath, objectiveId);
    const objective = state.latestObjective;

    if (!objective) {
      return "";
    }

    return [
      `OBJECTIVE: ${objective.objective}`,
      `OBJECTIVE_SUMMARY: ${objective.summary}`,
      `ACTIVE_BRANCH: ${state.latestBranch?.title || "none"}`,
      `LATEST_EVALUATION: ${state.latestEvaluation?.summary || "none"}`,
      `RECENT_FINDINGS:`,
      ...state.findings.slice(0, 5).map((entry) => `- ${entry.summary}`),
      `QUEUE:`,
      ...state.workItems
        .filter((entry) => entry.status === "pending")
        .slice(0, 5)
        .map((entry) => `- [${entry.executor}] ${entry.title}`),
      `RECENT_RUNS:`,
      ...(await this.readBuilderRuns(workspacePath, objective.id))
        .slice(0, 3)
        .map((entry) => `- ${entry.status}: ${extractFinalSummary(entry.finalMessage) || entry.prompt}`)
    ].join("\n");
  }

  private async resolveBranch(workspacePath: string, branchId: string) {
    return (await this.stateStore.readState(workspacePath)).branches.find((entry) => entry.id === branchId) ?? null;
  }

  private getRunControl(workspacePath: string, runId: string) {
    const key = `${workspacePath}::${runId}`;
    const existing = this.runControls.get(key);

    if (existing) {
      return existing;
    }

    const created: RunControlState = {
      stopRequested: false
    };
    this.runControls.set(key, created);
    return created;
  }

  private setProgress(
    workspacePath: string,
    runId: string,
    objectiveId: string,
    workItem: ResearchWorkItemRecord
  ) {
    const key = `${workspacePath}::${runId}::${workItem.id}`;
    this.activeProgress.set(key, {
      runId,
      workItemId: workItem.id,
      objectiveId,
      title: workItem.title,
      executor: workItem.executor ?? "builder-edit",
      status: "running",
      summary: workItem.title,
      oracleSessionSlug: workItem.oracleSessionSlug,
      worktreePath: workItem.worktreePath,
      updatedAt: new Date().toISOString()
    });
  }

  private clearProgress(workspacePath: string, runId: string, workItemId: string) {
    this.activeProgress.delete(`${workspacePath}::${runId}::${workItemId}`);
  }

  private listActiveProgress(workspacePath: string, objectiveId: string | null) {
    return Array.from(this.activeProgress.entries())
      .filter(([key, value]) => key.startsWith(`${workspacePath}::`) && (!objectiveId || value.objectiveId === objectiveId))
      .map(([, value]) => value)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async listAttachmentRecords(workspacePath: string) {
    return await this.records.readRecordDirectory<AttachmentRecord>(buildProjectPaths(workspacePath).attachmentRecordsDir);
  }

  private async listAttachments(workspacePath: string, objectiveId: string | null) {
    const records = await this.listAttachmentRecords(workspacePath);
    return records
      .filter((record) => !objectiveId || record.objectiveId === objectiveId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async readBuilderRuns(workspacePath: string, objectiveId: string) {
    return (await this.records.readRecordDirectory<RunRecord>(buildProjectPaths(workspacePath).runsDir))
      .filter((entry) => entry.threadId === objectiveId)
      .sort((left, right) => (right.endedAt ?? right.startedAt).localeCompare(left.endedAt ?? left.startedAt));
  }

  private async readLatestBuilderRun(workspacePath: string, objectiveId: string) {
    return (await this.readBuilderRuns(workspacePath, objectiveId))[0] ?? null;
  }

  private async readRecentLogs(workspacePath: string) {
    const content = await readFile(buildProjectPaths(workspacePath).activityLog, "utf8").catch(() => "");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-40)
      .reverse();
  }

  private async allocateRunArtifacts(paths: ReturnType<typeof buildProjectPaths>): Promise<ArtifactPaths> {
    const id = await this.records.nextId(paths.runsDir, "R");
    await mkdir(paths.runsDir, { recursive: true });
    return {
      id,
      jsonPath: path.join(paths.runsDir, `${id}.json`),
      stdoutPath: path.join(paths.runsDir, `${id}.stdout.log`),
      stderrPath: path.join(paths.runsDir, `${id}.stderr.log`),
      outputPath: path.join(paths.runsDir, `${id}.output.txt`),
      transcriptPath: path.join(paths.runsDir, `${id}.transcript.log`)
    };
  }
}

function resolveRequestedObjective(snapshot: WorkspaceSnapshot, objectiveId?: string | null) {
  if (objectiveId?.trim()) {
    return snapshot.objectives.find((entry) => entry.id === objectiveId) ?? null;
  }

  return snapshot.activeObjective;
}

function resolveRequestedRun(snapshot: WorkspaceSnapshot, runId?: string | null) {
  if (runId?.trim()) {
    return snapshot.runs.find((entry) => entry.id === runId) ?? null;
  }

  return snapshot.activeRun;
}

function resolveReasoningEffort(value: BuilderReasoningEffort) {
  return value;
}

function inferRunCompletionStatus(
  exitCode: number | null,
  timedOut: boolean
): "completed" | "failed" | "cancelled" {
  if (timedOut) {
    return "failed";
  }

  return exitCode === 0 ? "completed" : "failed";
}

function classifyAttachmentKind(filePath: string): AttachmentKind {
  const extension = path.extname(filePath).toLowerCase();

  if ([".md", ".txt", ".log"].includes(extension)) {
    return "text";
  }

  if ([".json", ".jsonl"].includes(extension)) {
    return "json";
  }

  if ([".csv", ".tsv"].includes(extension)) {
    return "csv";
  }

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) {
    return "image";
  }

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return "document";
  }

  return "other";
}

async function buildAttachmentExcerpt(filePath: string) {
  if (DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return DOCUMENT_ATTACHMENT_EXCERPT;
  }

  const content = await readFile(filePath, "utf8").catch(() => "");
  return content.replace(/\s+/g, " ").trim().slice(0, 240);
}
