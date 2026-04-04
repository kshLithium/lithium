import { readFile } from "node:fs/promises";
import type {
  AppSettings,
  AttachmentImportRequest,
  ObjectiveCreateRequest,
  ObjectiveRunControlRequest,
  ObjectiveSelectionRequest,
  ProjectRecord,
  ResearchBranchRecord,
  ResearchObjectiveRecord,
  ResearchRunRecord,
  WorkerRunRecord,
  WorkspaceSnapshot
} from "../../shared/types";
import { DEFAULT_APP_SETTINGS } from "../../shared/types";
import { ArtifactService } from "../research/artifact-service";
import { EvaluatorRunner } from "../research/evaluator-runner";
import { OracleWorkerPool } from "../research/oracle-worker-pool";
import { ResearchResultProcessor } from "../research/result-processor";
import { RuntimeRegistry } from "../research/runtime-registry";
import { ResearchScheduler } from "../research/scheduler";
import { ResearchStateStore } from "../research/state-store";
import { ResearchRunCoordinator } from "../research/run-coordinator";
import { ResearchWatchdog } from "../research/watchdog";
import { WorkerGateway, type WorkerDispatchResult } from "../research/worker-gateway";
import { WorktreeManager } from "../research/worktree-manager";
import { CodexRunner } from "./codex-runner";
import { ChatgptAuthRunner } from "./chatgpt-auth-runner";
import { buildProjectPaths } from "./workspace-layout";

type ResearchServiceDependencies = {
  stateStore?: ResearchStateStore;
  oracleWorkerPool?: OracleWorkerPool;
  evaluatorRunner?: EvaluatorRunner;
  codexRunner?: CodexRunner;
  chatgptAuthRunner?: Pick<ChatgptAuthRunner, "signIn" | "prepareReusableSession">;
  worktreeManager?: WorktreeManager;
  artifactService?: ArtifactService;
  workerGateway?: WorkerGateway;
  runtimeRegistry?: RuntimeRegistry<WorkerDispatchResult>;
  scheduler?: ResearchScheduler;
  resultProcessor?: ResearchResultProcessor;
  watchdog?: ResearchWatchdog<WorkerDispatchResult>;
  coordinator?: ResearchRunCoordinator;
  getAppSettings?: () => Promise<AppSettings>;
};

export class ResearchService {
  private readonly stateStore: ResearchStateStore;
  private readonly oracleWorkerPool: OracleWorkerPool;
  private readonly evaluatorRunner: EvaluatorRunner;
  private readonly codexRunner: CodexRunner;
  private readonly chatgptAuthRunner: Pick<ChatgptAuthRunner, "signIn" | "prepareReusableSession">;
  private readonly worktreeManager: WorktreeManager;
  private readonly artifactService: ArtifactService;
  private readonly workerGateway: WorkerGateway;
  private readonly runtimeRegistry: RuntimeRegistry<WorkerDispatchResult>;
  private readonly scheduler: ResearchScheduler;
  private readonly resultProcessor: ResearchResultProcessor;
  private readonly watchdog: ResearchWatchdog<WorkerDispatchResult>;
  private readonly coordinator: ResearchRunCoordinator;
  private readonly loopPromises = new Map<string, Promise<void>>();
  private currentWorkspacePath: string;

  constructor(workspacePath: string, deps: ResearchServiceDependencies = {}) {
    this.currentWorkspacePath = workspacePath;
    this.stateStore = deps.stateStore ?? new ResearchStateStore();
    this.oracleWorkerPool = deps.oracleWorkerPool ?? new OracleWorkerPool();
    this.evaluatorRunner = deps.evaluatorRunner ?? new EvaluatorRunner();
    this.codexRunner = deps.codexRunner ?? new CodexRunner();
    this.chatgptAuthRunner = deps.chatgptAuthRunner ?? new ChatgptAuthRunner();
    this.worktreeManager = deps.worktreeManager ?? new WorktreeManager();
    this.artifactService =
      deps.artifactService ??
      new ArtifactService({
        stateStore: this.stateStore
      });
    this.workerGateway =
      deps.workerGateway ??
      new WorkerGateway({
        stateStore: this.stateStore,
        oracleWorkerPool: this.oracleWorkerPool,
        evaluatorRunner: this.evaluatorRunner,
        codexRunner: this.codexRunner,
        worktreeManager: this.worktreeManager,
        artifactService: this.artifactService,
        getAppSettings: deps.getAppSettings ?? (async () => DEFAULT_APP_SETTINGS)
      });
    this.runtimeRegistry = deps.runtimeRegistry ?? new RuntimeRegistry<WorkerDispatchResult>();
    this.scheduler =
      deps.scheduler ??
      new ResearchScheduler({
        stateStore: this.stateStore
      });
    this.resultProcessor =
      deps.resultProcessor ??
      new ResearchResultProcessor({
        stateStore: this.stateStore,
        artifactService: this.artifactService,
        workerGateway: this.workerGateway
      });
    this.watchdog = deps.watchdog ?? new ResearchWatchdog<WorkerDispatchResult>();
    this.coordinator =
      deps.coordinator ??
      new ResearchRunCoordinator({
        stateStore: this.stateStore,
        scheduler: this.scheduler,
        resultProcessor: this.resultProcessor,
        runtimeRegistry: this.runtimeRegistry,
        watchdog: this.watchdog,
        workerGateway: this.workerGateway
      });
  }

  setSelectedWorkspacePath(workspacePath: string) {
    this.currentWorkspacePath = workspacePath;
  }

  async initWorkspace(workspacePath = this.currentWorkspacePath) {
    const project = await this.stateStore.initWorkspace(workspacePath);
    await this.stateStore.migrateLegacyWorkspace(workspacePath);
    await this.resultProcessor.recoverInterruptedRuns(workspacePath);
    const snapshot = await this.getWorkspaceSnapshot(workspacePath);

    if (!snapshot.activeObjective && snapshot.objectives.length === 0) {
      return await this.createObjective({
        workspacePath,
        title: project.name,
        objective: `Advance the next research outcome for ${project.name}.`
      });
    }

    return snapshot;
  }

  async getWorkspaceSnapshot(workspacePath = this.currentWorkspacePath): Promise<WorkspaceSnapshot> {
    await this.stateStore.initWorkspace(workspacePath);
    const project = await this.stateStore.readProject(workspacePath);
    const fullState = await this.stateStore.readState(workspacePath);
    const activeObjectiveId = project?.activeObjectiveId?.trim() || fullState.latestObjective?.id || null;
    const scopedState = activeObjectiveId ? await this.stateStore.readState(workspacePath, activeObjectiveId) : fullState;
    const activeObjective = scopedState.latestObjective ?? null;
    const activeRun =
      (activeObjective
        ? scopedState.runs.find((entry) => entry.id === activeObjective.activeRunId)
        : null) ??
      scopedState.latestRun ??
      null;
    const attachments = await this.stateStore.listAttachments(workspacePath, activeObjective?.id ?? null);
    const latestWorkerRun = activeObjective ? await this.readLatestWorkerRun(workspacePath, activeObjective.id) : null;
    const logs = await this.readRecentLogs(workspacePath);
    const recentExperiments =
      activeObjective ? await this.artifactService.readRecentExperimentResults(workspacePath, activeObjective.id, 5) : [];

    return {
      project,
      activeObjectiveId: activeObjective?.id ?? null,
      activeObjective,
      objectives: fullState.objectives,
      activeRun,
      runs: scopedState.runs,
      branches: scopedState.branches,
      queue: scopedState.workItems.filter((entry) => entry.status === "pending" || entry.status === "running"),
      recentFindings: scopedState.findings.slice(0, 8),
      recentSources: scopedState.sources.slice(0, 8),
      recentExperiments,
      latestEvaluation: scopedState.latestEvaluation,
      latestProjection: scopedState.latestProjection,
      latestWorkerRun,
      blockedReason: activeRun?.blockedReason,
      attachments,
      activeWorkerProgress: this.runtimeRegistry.listProgress(workspacePath, activeObjective?.id ?? null),
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
    const objectiveId = (await this.stateStore.allocateObjective(workspacePath)).id;
    const branchId = (await this.stateStore.allocateBranch(workspacePath)).id;
    const hypothesisId = (await this.stateStore.allocateHypothesis(workspacePath)).id;
    const title = request.title?.trim() || request.objective.trim();
    const objective: ResearchObjectiveRecord = {
      id: objectiveId,
      title,
      objective: request.objective.trim(),
      summary: request.objective.trim(),
      status: "pending",
      successCriteria: request.successCriteria?.filter(Boolean) ?? [
        "Advance the highest-value branch with bounded work.",
        "Capture source-grounded evidence and structured experiment records."
      ],
      activeBranchId: branchId,
      sourceIds: [],
      branchIds: [branchId],
      createdAt: now,
      updatedAt: now
    };
    await this.stateStore.writeObjective(workspacePath, objective);
    await this.stateStore.writeBranch(workspacePath, {
      id: branchId,
      objectiveId,
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
      id: hypothesisId,
      objectiveId,
      branchId,
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
    await this.resultProcessor.materializeProjection(workspacePath, objectiveId);
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
    await this.resultProcessor.materializeProjection(workspacePath, objective.id);
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
    const existingRun =
      scoped.runs.find((entry) => entry.id === objective.activeRunId) ??
      scoped.runs.find((entry) => entry.status === "active" || entry.status === "blocked" || entry.status === "paused") ??
      null;

    if (existingRun?.status === "active") {
      this.ensureRunLoop(workspacePath, existingRun.id);
      return await this.getWorkspaceSnapshot(workspacePath);
    }

    if (existingRun?.status === "paused" || existingRun?.status === "blocked") {
      return await this.getWorkspaceSnapshot(workspacePath);
    }

    let blockedReason: string | undefined;
    try {
      await this.chatgptAuthRunner.prepareReusableSession?.();
    } catch (error) {
      blockedReason = error instanceof Error ? error.message : String(error);
    }

    const now = new Date().toISOString();
    const run: ResearchRunRecord = {
      id: (await this.stateStore.allocateRun(workspacePath)).id,
      objectiveId: objective.id,
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
      dispatchPaused: false,
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };

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
    await this.resultProcessor.materializeProjection(workspacePath, objective.id);

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

    await this.stateStore.writeRun(workspacePath, {
      ...run,
      status: "paused",
      dispatchPaused: true,
      updatedAt: new Date().toISOString()
    });
    await this.stateStore.appendActivity(workspacePath, `run paused ${run.id}`);
    if (snapshot.activeObjective) {
      await this.resultProcessor.materializeProjection(workspacePath, snapshot.activeObjective.id);
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

    await this.stateStore.writeRun(workspacePath, {
      ...run,
      status: "active",
      blockedReason: undefined,
      stopReason: undefined,
      dispatchPaused: false,
      updatedAt: new Date().toISOString()
    });
    await this.stateStore.appendActivity(workspacePath, `run resumed ${run.id}`);
    if (snapshot.activeObjective) {
      await this.resultProcessor.materializeProjection(workspacePath, snapshot.activeObjective.id);
    }
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

    this.coordinator.terminateRun(run.id);
    const now = new Date().toISOString();
    await this.stateStore.writeRun(workspacePath, {
      ...run,
      status: "failed",
      stopReason: "Run stopped by the user.",
      activeWorkItemIds: [],
      oracleSessionSlugs: [],
      dispatchPaused: true,
      updatedAt: now,
      endedAt: now
    });
    await this.stateStore.appendActivity(workspacePath, `run stopped ${run.id}`);
    if (snapshot.activeObjective) {
      await this.resultProcessor.materializeProjection(workspacePath, snapshot.activeObjective.id);
    }
    return await this.getWorkspaceSnapshot(workspacePath);
  }

  async importAttachments(request: AttachmentImportRequest) {
    const workspacePath = request.workspacePath ?? this.currentWorkspacePath;
    const snapshot = await this.getWorkspaceSnapshot(workspacePath);
    const objective = resolveRequestedObjective(snapshot, request.objectiveId);
    if (!objective) {
      throw new Error("Create or select an objective before importing attachments.");
    }

    const scoped = await this.stateStore.readState(workspacePath, objective.id);
    const branch =
      scoped.branches.find((entry) => entry.id === objective.activeBranchId) ??
      scoped.latestBranch ??
      null;
    await this.resultProcessor.importAttachments({
      workspacePath,
      objective,
      branch,
      filePaths: request.filePaths
    });
    await this.stateStore.appendActivity(workspacePath, `attachments imported for ${objective.id}`);
    await this.resultProcessor.materializeProjection(workspacePath, objective.id);
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

    const loop = this.coordinator.runLoop(workspacePath, runId).finally(() => {
      this.loopPromises.delete(key);
    });
    this.loopPromises.set(key, loop);
    return loop;
  }

  private async readLatestWorkerRun(workspacePath: string, objectiveId: string) {
    const workerRuns = await this.stateStore.listWorkerRuns<WorkerRunRecord>(workspacePath);
    return (
      workerRuns
        .filter((entry) => entry.objectiveId === objectiveId)
        .sort((left, right) => (right.endedAt ?? right.startedAt).localeCompare(left.endedAt ?? left.startedAt))[0] ?? null
    );
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
}

function resolveRequestedObjective(snapshot: WorkspaceSnapshot, objectiveId?: string) {
  if (!objectiveId) {
    return snapshot.activeObjective;
  }
  return snapshot.objectives.find((entry) => entry.id === objectiveId) ?? null;
}

function resolveRequestedRun(snapshot: WorkspaceSnapshot, runId?: string) {
  if (!runId) {
    return snapshot.activeRun;
  }
  return snapshot.runs.find((entry) => entry.id === runId) ?? null;
}
