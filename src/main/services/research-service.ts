import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type ActiveWorkerProgressRecord,
  type AppSettings,
  type AttachmentImportRequest,
  type AttachmentRecord,
  type EvaluationRecord,
  type ObjectiveCreateRequest,
  type ObjectiveRunControlRequest,
  type ObjectiveSelectionRequest,
  type ProjectRecord,
  type ResearchBranchRecord,
  type ResearchObjectiveRecord,
  type ResearchRunRecord,
  type ResearchWorkItemRecord,
  type RunRecord,
  type WorkspaceSnapshot,
  DEFAULT_APP_SETTINGS
} from "../../shared/types";
import { RecordStore } from "./record-store";
import { buildProjectPaths } from "./workspace-layout";
import { CodexRunner } from "./codex-runner";
import { ChatgptAuthRunner } from "./chatgpt-auth-runner";
import { EvaluatorRunner } from "../research/evaluator-runner";
import { OracleWorkerPool } from "../research/oracle-worker-pool";
import { ResearchEngine } from "../research/engine";
import { ResearchStateStore } from "../research/state-store";
import { WorktreeManager } from "../research/worktree-manager";
import { ArtifactService } from "../research/artifact-service";
import { ProgressRegistry } from "../research/progress-registry";
import { RuntimeContextBuilder } from "../research/runtime-context-builder";
import { SourceIngestService } from "../research/source-ingest-service";
import { AttachmentIngestService } from "../research/attachment-ingest-service";
import { WorkerGateway, type WorkerDispatchResult } from "../research/worker-gateway";

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

export class ResearchService {
  private readonly records = new RecordStore();
  private readonly stateStore: ResearchStateStore;
  private readonly oracleWorkerPool: OracleWorkerPool;
  private readonly evaluatorRunner: EvaluatorRunner;
  private readonly codexRunner: CodexRunner;
  private readonly chatgptAuthRunner: Pick<ChatgptAuthRunner, "signIn" | "prepareReusableSession">;
  private readonly worktreeManager: WorktreeManager;
  private readonly engine: ResearchEngine;
  private readonly artifactService: ArtifactService;
  private readonly runtimeContextBuilder: RuntimeContextBuilder;
  private readonly sourceIngestService: SourceIngestService;
  private readonly attachmentIngestService: AttachmentIngestService;
  private readonly workerGateway: WorkerGateway;
  private readonly progressRegistry: ProgressRegistry;
  private readonly getAppSettings: () => Promise<AppSettings>;
  private readonly loopPromises = new Map<string, Promise<void>>();
  private readonly runControls = new Map<string, RunControlState>();
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
    this.artifactService = new ArtifactService({
      stateStore: this.stateStore
    });
    this.runtimeContextBuilder = new RuntimeContextBuilder({
      stateStore: this.stateStore,
      artifactService: this.artifactService
    });
    this.sourceIngestService = new SourceIngestService({
      stateStore: this.stateStore
    });
    this.attachmentIngestService = new AttachmentIngestService({
      sourceIngestService: this.sourceIngestService
    });
    this.workerGateway = new WorkerGateway({
      stateStore: this.stateStore,
      oracleWorkerPool: this.oracleWorkerPool,
      evaluatorRunner: this.evaluatorRunner,
      codexRunner: this.codexRunner,
      worktreeManager: this.worktreeManager,
      artifactService: this.artifactService,
      getAppSettings: deps.getAppSettings ?? (async () => DEFAULT_APP_SETTINGS)
    });
    this.progressRegistry = new ProgressRegistry();
    this.getAppSettings = deps.getAppSettings ?? (async () => DEFAULT_APP_SETTINGS);
  }

  setSelectedWorkspacePath(workspacePath: string) {
    this.currentWorkspacePath = workspacePath;
  }

  async initWorkspace(workspacePath = this.currentWorkspacePath) {
    const project = await this.stateStore.initWorkspace(workspacePath);
    await this.stateStore.migrateLegacyWorkspace(workspacePath);
    await this.cleanupOrphanedWorktrees(workspacePath);
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
    const recentExperiments =
      objectiveId ? await this.artifactService.readRecentExperimentResults(workspacePath, objectiveId, 5) : [];

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
      recentSources: activeState.sources.slice(0, 8),
      recentExperiments,
      latestEvaluation: activeState.latestEvaluation,
      latestProjection: activeState.latestProjection,
      latestBuilderRun,
      blockedReason:
        activeState.runs.find((entry) => entry.id === activeObjective?.activeRunId)?.blockedReason ??
        activeState.latestRun?.blockedReason,
      attachments,
      activeWorkerProgress: this.progressRegistry.list(workspacePath, objectiveId),
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
    const hypothesisAllocation = await this.stateStore.allocateHypothesis(workspacePath);
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
    await this.stateStore.writeHypothesis(workspacePath, {
      id: hypothesisAllocation.id,
      objectiveId,
      branchId: branchAllocation.id,
      threadId: objectiveId,
      statement: request.objective.trim(),
      status: "open",
      confidence: 0.5,
      evidenceIds: [],
      createdAt: now,
      updatedAt: now
    });
    await this.stateStore.writeProject(workspacePath, {
      ...(project as ProjectRecord),
      activeObjectiveId: objectiveId,
      updatedAt: now
    });
    await this.stateStore.appendActivity(workspacePath, `objective created ${objectiveId}: ${title}`);
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

    if (!(await this.workerGateway.supportsWorkspace(workspacePath))) {
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
    await this.stateStore.appendActivity(
      workspacePath,
      run.status === "active" ? `run started ${run.id}` : `run blocked ${run.id}: ${run.blockedReason ?? "unknown"}`
    );
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
    await this.stateStore.appendActivity(workspacePath, `run resumed ${run.id}`);
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
    const stoppedRun: ResearchRunRecord = {
      ...run,
      status: "failed",
      stopReason: "Run stopped by the user.",
      activeWorkItemIds: [],
      oracleSessionSlugs: [],
      updatedAt: new Date().toISOString(),
      endedAt: new Date().toISOString()
    };
    await this.stateStore.writeRun(workspacePath, stoppedRun);
    await this.cleanupRecordedRunLeases(workspacePath, stoppedRun);
    await this.stateStore.appendActivity(workspacePath, `run stopped ${run.id}`);
    return await this.getWorkspaceSnapshot(workspacePath);
  }

  async importAttachments(request: AttachmentImportRequest) {
    const workspacePath = request.workspacePath ?? this.currentWorkspacePath;
    const snapshot = await this.getWorkspaceSnapshot(workspacePath);
    const objective = resolveRequestedObjective(snapshot, request.objectiveId);

    if (!objective) {
      throw new Error("Create or select an objective before importing attachments.");
    }

    const branch =
      (await this.stateStore.readState(workspacePath, objective.id)).branches.find(
        (entry) => entry.id === objective.activeBranchId
      ) ?? null;
    await this.attachmentIngestService.importAttachments({
      workspacePath,
      objective,
      branch,
      filePaths: request.filePaths
    });
    await this.stateStore.appendActivity(
      workspacePath,
      `attachments imported for ${objective.id}: ${request.filePaths.map((entry) => path.basename(entry)).join(", ")}`
    );

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
      sources: snapshot.recentSources,
      experiments: snapshot.recentExperiments,
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

      const selected = [...batch.oracleWorkItems, ...batch.codexWorkItems];

      if (selected.length === 0) {
        await this.engine.materializeProjection(workspacePath, objective.id);
        return;
      }

      await this.stateStore.appendActivity(
        workspacePath,
        `scheduler selected ${selected.map((entry) => `${entry.executor}:${entry.id}`).join(", ")}`
      );
      await this.engine.markWorkItemsRunning({
        workspacePath,
        run: batch.run,
        workItems: selected
      });
      selected.forEach((workItem) => this.progressRegistry.set(workspacePath, run.id, objective.id, workItem));

      const results = await Promise.all(
        selected.map(async (workItem) => ({
          workItem,
          result: await this.safeExecuteWorkItem({
            workspacePath,
            objective,
            run,
            workItem,
            runtimeContext
          })
        }))
      );

      for (const { workItem, result } of results) {
        try {
          const currentState = await this.stateStore.readState(workspacePath, objective.id);
          const currentRun = currentState.runs.find((entry) => entry.id === run.id) ?? currentState.latestRun;
          const currentObjective = currentState.latestObjective ?? objective;
          const currentBranch = currentState.branches.find((entry) => entry.id === workItem.branchId) ?? null;

          if (!currentRun) {
            continue;
          }

          if (result.lease) {
            await this.persistLeaseOnRun(workspacePath, currentRun, result.lease);
          }

          if (
            result.status === "failed" &&
            result.infraFailure &&
            (workItem.executor === "oracle-planner" || workItem.executor === "oracle-research")
          ) {
            await this.handleOracleInfraFailure({
              workspacePath,
              run: currentRun,
              workItem,
              result
            });
            continue;
          }

          const evaluation = await this.createEvaluation({
            workspacePath,
            objective: currentObjective,
            branch: currentBranch,
            workItem,
            executionResult: result,
            runtimeContext
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

          const promotion = await this.workerGateway.promotePatchArtifact({
            workspacePath,
            workItem: {
              ...workItem,
              patchArtifactPath: result.patchArtifactPath ?? workItem.patchArtifactPath
            },
            evaluation
          });

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
            oracleSessionSlug: result.oracleSessionSlug,
            patchArtifactPath: result.patchArtifactPath,
            promotionStatus: promotion.promotionStatus,
            promotionError: promotion.promotionError,
            lease: result.lease
          });
        } finally {
          await this.finishWorkItemLifecycle({
            workspacePath,
            runId: run.id,
            workItemId: workItem.id,
            lease: result.lease
          });
        }
      }

      await this.engine.materializeProjection(workspacePath, objective.id);
    }
  }

  private async safeExecuteWorkItem(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    runtimeContext: string;
  }): Promise<WorkerDispatchResult> {
    const branch = await this.resolveBranch(input.workspacePath, input.workItem.branchId);

    return await this.workerGateway.dispatch({
      workspacePath: input.workspacePath,
      objective: input.objective,
      branch,
      run: input.run,
      workItem: input.workItem,
      runtimeContext: input.runtimeContext
    });
  }

  private async handleOracleInfraFailure(input: {
    workspacePath: string;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    result: WorkerDispatchResult;
  }) {
    const now = new Date().toISOString();
    await this.stateStore.writeWorkItem(input.workspacePath, {
      ...input.workItem,
      status: "blocked",
      updatedAt: now,
      oracleSessionSlug: input.result.oracleSessionSlug ?? input.workItem.oracleSessionSlug
    });
    await this.engine.blockRun({
      workspacePath: input.workspacePath,
      run: {
        ...input.run,
        activeWorkItemIds: input.run.activeWorkItemIds.filter((entry) => entry !== input.workItem.id),
        oracleSessionSlugs: input.run.oracleSessionSlugs.filter((entry) => entry !== input.result.oracleSessionSlug)
      },
      reason: input.result.summary
    });
    await this.stateStore.appendEvent(input.workspacePath, {
      id: `${input.workItem.id}-infra-failed`,
      threadId: input.workItem.threadId,
      objectiveId: input.workItem.objectiveId,
      branchId: input.workItem.branchId,
      workItemId: input.workItem.id,
      type: "work-item.blocked",
      payload: {
        executor: input.workItem.executor,
        reason: input.result.summary
      },
      createdAt: now
    });
  }

  private async createEvaluation(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    workItem: ResearchWorkItemRecord;
    executionResult: WorkerDispatchResult;
    runtimeContext: string;
  }) {
    const branch = input.branch ?? (await this.resolveBranch(input.workspacePath, input.workItem.branchId));

    if (!branch) {
      throw new Error(`Branch not found for evaluation of ${input.workItem.id}`);
    }

    const result =
      input.executionResult.evaluatorDecision ??
      (await this.evaluatorRunner.evaluate({
        workspacePath: input.workspacePath,
        branchTitle: branch.title,
        workItemTitle: input.workItem.title,
        executionSummary: [
          input.executionResult.summary,
          input.executionResult.patchArtifactPath
            ? `PATCH_ARTIFACT: ${input.executionResult.patchArtifactPath}`
            : "",
          ...(input.executionResult.runActions ?? []).map((entry) => `RUN_ACTION: ${entry}`)
        ]
          .filter(Boolean)
          .join("\n"),
        runtimeContext: input.runtimeContext
      })).decision;
    const allocation = await this.stateStore.allocateEvaluation(input.workspacePath);
    const now = new Date().toISOString();

    return {
      id: allocation.id,
      objectiveId: input.objective.id,
      branchId: branch.id,
      threadId: input.objective.id,
      workItemId: input.workItem.id,
      verdict: input.executionResult.status === "failed" ? "kill" : result.verdict,
      scoreDelta: input.executionResult.status === "failed" ? Math.min(result.scoreDelta, -0.1) : result.scoreDelta,
      summary: result.summary,
      rationale: result.rationale,
      followupPrompt: result.followupPrompt,
      createdAt: now,
      updatedAt: now
    } satisfies EvaluationRecord;
  }

  private async buildRuntimeContext(workspacePath: string, objectiveId: string) {
    return await this.runtimeContextBuilder.build(workspacePath, objectiveId);
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

  private async persistLeaseOnRun(
    workspacePath: string,
    run: ResearchRunRecord,
    lease: NonNullable<WorkerDispatchResult["lease"]>
  ) {
    if (run.worktreeLeases.some((entry) => entry.id === lease.id)) {
      return;
    }

    await this.stateStore.writeRun(workspacePath, {
      ...run,
      worktreeLeases: [...run.worktreeLeases, lease],
      updatedAt: new Date().toISOString()
    });
  }

  private async finishWorkItemLifecycle(input: {
    workspacePath: string;
    runId: string;
    workItemId: string;
    lease?: WorkerDispatchResult["lease"];
  }) {
    this.progressRegistry.clear(input.workspacePath, input.runId, input.workItemId);
    const state = await this.stateStore.readState(input.workspacePath);
    const run = state.runs.find((entry) => entry.id === input.runId) ?? null;

    if (!run) {
      return;
    }

    const lease = input.lease ? run.worktreeLeases.find((entry) => entry.id === input.lease?.id) ?? input.lease : null;
    let worktreeLeases = run.worktreeLeases;

    if (lease) {
      const released = await this.workerGateway.releaseLease({
        workspacePath: input.workspacePath,
        lease
      });
      const now = new Date().toISOString();
      worktreeLeases = run.worktreeLeases.map((entry) =>
        entry.id === lease.id
          ? {
              ...entry,
              cleanupStatus:
                released?.cleanupStatus === "released"
                  ? ("released" as ResearchRunRecord["worktreeLeases"][number]["cleanupStatus"])
                  : ("failed" as ResearchRunRecord["worktreeLeases"][number]["cleanupStatus"]),
              cleanupError: released?.cleanupError,
              releasedAt: now,
              updatedAt: now
            }
          : entry
      );
      await this.stateStore.appendActivity(
        input.workspacePath,
        released?.cleanupStatus === "released"
          ? `worktree cleanup ${lease.id}`
          : `worktree cleanup failed ${lease.id}: ${released?.cleanupError ?? "unknown"}`
      );
    }

    await this.stateStore.writeRun(input.workspacePath, {
      ...run,
      activeWorkItemIds: run.activeWorkItemIds.filter((entry) => entry !== input.workItemId),
      worktreeLeases,
      updatedAt: new Date().toISOString()
    });
  }

  private async cleanupOrphanedWorktrees(workspacePath: string) {
    const state = await this.stateStore.readState(workspacePath);
    const activeLeasePaths = state.runs
      .flatMap((run) => run.worktreeLeases)
      .filter((lease) => lease.cleanupStatus === "active")
      .map((lease) => lease.worktreePath);
    await this.worktreeManager.garbageCollect(workspacePath, activeLeasePaths);
  }

  private async cleanupRecordedRunLeases(workspacePath: string, run: ResearchRunRecord) {
    const now = new Date().toISOString();
    const worktreeLeases = await Promise.all(
      run.worktreeLeases.map(async (lease) => {
        if (lease.cleanupStatus !== "active") {
          return lease;
        }

        const released = await this.workerGateway.releaseLease({
          workspacePath,
          lease
        });

        return {
          ...lease,
          cleanupStatus:
            released?.cleanupStatus === "released"
              ? ("released" as ResearchRunRecord["worktreeLeases"][number]["cleanupStatus"])
              : ("failed" as ResearchRunRecord["worktreeLeases"][number]["cleanupStatus"]),
          cleanupError: released?.cleanupError,
          releasedAt: now,
          updatedAt: now
        };
      })
    );

    await this.stateStore.writeRun(workspacePath, {
      ...run,
      worktreeLeases,
      updatedAt: now
    });
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
