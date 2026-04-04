import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AttachmentRecord,
  EvaluationRecord,
  ExperimentResultRecord,
  ExperimentSpecRecord,
  MetricRecord,
  ProjectRecord,
  ResearchBranchRecord,
  ResearchEventRecord,
  ResearchFindingRecord,
  ResearchHypothesisRecord,
  ResearchObjectiveRecord,
  ResearchProjectionRecord,
  ResearchRunRecord,
  ResearchSourceRecord,
  ResearchWorkItemRecord,
  SourceArtifactRecord
} from "../../shared/types";
import { PROJECT_SCHEMA_VERSION } from "../../shared/types";
import { pathExists } from "../services/fs-utils";
import { buildProjectPaths, LEGACY_LITHIUM_SENTINELS } from "../services/workspace-layout";

export type ResearchStateSnapshot = {
  objectives: ResearchObjectiveRecord[];
  branches: ResearchBranchRecord[];
  sources: ResearchSourceRecord[];
  findings: ResearchFindingRecord[];
  hypotheses: ResearchHypothesisRecord[];
  workItems: ResearchWorkItemRecord[];
  evaluations: EvaluationRecord[];
  experimentSpecs: ExperimentSpecRecord[];
  experimentResults: ExperimentResultRecord[];
  metrics: MetricRecord[];
  runs: ResearchRunRecord[];
  latestObjective: ResearchObjectiveRecord | null;
  latestBranch: ResearchBranchRecord | null;
  latestSource: ResearchSourceRecord | null;
  latestFinding: ResearchFindingRecord | null;
  latestHypothesis: ResearchHypothesisRecord | null;
  latestWorkItem: ResearchWorkItemRecord | null;
  latestEvaluation: EvaluationRecord | null;
  latestExperimentResult: ExperimentResultRecord | null;
  latestProjection: ResearchProjectionRecord | null;
  latestRun: ResearchRunRecord | null;
};

export type LegacyMigrationResult = {
  migrated: false;
};

type CounterKind =
  | "objective"
  | "branch"
  | "source"
  | "source-artifact"
  | "finding"
  | "hypothesis"
  | "work-item"
  | "evaluation"
  | "projection"
  | "run"
  | "worker-run"
  | "experiment-spec"
  | "experiment-result"
  | "metric"
  | "attachment";

const COUNTER_PREFIX: Record<CounterKind, string> = {
  objective: "RO",
  branch: "RB",
  source: "RS",
  "source-artifact": "SA",
  finding: "RF",
  hypothesis: "RH",
  "work-item": "RT",
  evaluation: "RE",
  projection: "RP",
  run: "RR",
  "worker-run": "WR",
  "experiment-spec": "ES",
  "experiment-result": "ER",
  metric: "RM",
  attachment: "RA"
};

const V3_ALLOWED_ROOT_NAMES = new Set([
  "research.db",
  "artifacts",
  "logs",
  "legacy"
]);

export class ResearchStateStore {
  private readonly databases = new Map<string, DatabaseSync>();

  buildPaths(workspacePath: string) {
    return buildProjectPaths(workspacePath);
  }

  async ensureLayout(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    await Promise.all([
      mkdir(paths.root, { recursive: true }),
      mkdir(paths.artifactRoot, { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
      mkdir(paths.workerRunsDir, { recursive: true }),
      mkdir(paths.oracleSessionsDir, { recursive: true }),
      mkdir(paths.evaluatorDir, { recursive: true }),
      mkdir(paths.experimentManifestDir, { recursive: true }),
      mkdir(paths.sourceArtifactsDir, { recursive: true }),
      mkdir(paths.researchPatchesDir, { recursive: true }),
      mkdir(paths.worktreesDir, { recursive: true }),
      mkdir(paths.workspaceAttachmentsDir, { recursive: true })
    ]);
  }

  async initWorkspace(workspacePath: string) {
    await this.ensureLayout(workspacePath);
    await this.assertNoLegacyWorkspace(workspacePath);
    const db = this.getDb(workspacePath);
    const now = new Date().toISOString();
    const existing = this.readProjectSync(db);

    const project: ProjectRecord = existing ?? {
      id: `project-${path.basename(workspacePath)}`,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name: path.basename(workspacePath) || "lithium",
      workspacePath,
      oracleModel: "gpt-5.4-pro",
      codexModel: "gpt-5.4",
      createdAt: now,
      updatedAt: now
    };

    const normalized: ProjectRecord = {
      ...project,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      workspacePath,
      updatedAt: now
    };

    this.writeProjectSync(db, normalized);
    return normalized;
  }

  async migrateLegacyWorkspace(workspacePath: string): Promise<LegacyMigrationResult> {
    await this.assertNoLegacyWorkspace(workspacePath);
    return { migrated: false };
  }

  async readProject(workspacePath: string) {
    await this.ensureLayout(workspacePath);
    return this.readProjectSync(this.getDb(workspacePath));
  }

  async writeProject(workspacePath: string, project: ProjectRecord) {
    await this.ensureLayout(workspacePath);
    this.writeProjectSync(this.getDb(workspacePath), project);
  }

  async allocateObjective(workspacePath: string) {
    return { id: this.nextId(workspacePath, "objective") };
  }

  async allocateBranch(workspacePath: string) {
    return { id: this.nextId(workspacePath, "branch") };
  }

  async allocateSource(workspacePath: string) {
    return { id: this.nextId(workspacePath, "source") };
  }

  async allocateSourceArtifact(workspacePath: string) {
    return { id: this.nextId(workspacePath, "source-artifact") };
  }

  async allocateFinding(workspacePath: string) {
    return { id: this.nextId(workspacePath, "finding") };
  }

  async allocateHypothesis(workspacePath: string) {
    return { id: this.nextId(workspacePath, "hypothesis") };
  }

  async allocateWorkItem(workspacePath: string) {
    return { id: this.nextId(workspacePath, "work-item") };
  }

  async allocateEvaluation(workspacePath: string) {
    return { id: this.nextId(workspacePath, "evaluation") };
  }

  async allocateProjection(workspacePath: string) {
    return { id: this.nextId(workspacePath, "projection") };
  }

  async allocateRun(workspacePath: string) {
    return { id: this.nextId(workspacePath, "run") };
  }

  async allocateWorkerRun(workspacePath: string) {
    return { id: this.nextId(workspacePath, "worker-run") };
  }

  async allocateExperimentSpec(workspacePath: string) {
    return { id: this.nextId(workspacePath, "experiment-spec") };
  }

  async allocateExperimentResult(workspacePath: string) {
    return { id: this.nextId(workspacePath, "experiment-result") };
  }

  async allocateMetric(workspacePath: string) {
    return { id: this.nextId(workspacePath, "metric") };
  }

  async allocateAttachment(workspacePath: string) {
    return { id: this.nextId(workspacePath, "attachment") };
  }

  async writeObjective(workspacePath: string, record: ResearchObjectiveRecord) {
    this.upsertRecord(workspacePath, "objectives", record, {
      objectiveId: record.id,
      status: record.status
    });
  }

  async writeBranch(workspacePath: string, record: ResearchBranchRecord) {
    this.upsertRecord(workspacePath, "branches", record, {
      objectiveId: record.objectiveId,
      branchId: record.id,
      status: record.status,
      score: record.score,
      updatedAt: record.lastUpdatedAt ?? record.updatedAt
    });
    this.upsertBranchHead(workspacePath, record);
  }

  async writeSource(workspacePath: string, record: ResearchSourceRecord) {
    this.upsertRecord(workspacePath, "sources", record, {
      objectiveId: record.objectiveId,
      branchId: record.branchId,
      kind: record.kind,
      locator: record.locator
    });
  }

  async writeSourceArtifact(workspacePath: string, record: SourceArtifactRecord) {
    this.upsertRecord(workspacePath, "source_artifacts", record as SourceArtifactRecord & { objectiveId?: string; branchId?: string }, {
      objectiveId: record.objectiveId,
      locator: record.path
    });
  }

  async writeFinding(workspacePath: string, record: ResearchFindingRecord) {
    this.upsertRecord(workspacePath, "findings", record, {
      objectiveId: record.objectiveId,
      branchId: record.branchId,
      sourceId: record.sourceId
    });
  }

  async writeHypothesis(workspacePath: string, record: ResearchHypothesisRecord) {
    this.upsertRecord(workspacePath, "hypotheses", record, {
      objectiveId: record.objectiveId,
      branchId: record.branchId,
      status: record.status
    });
  }

  async writeWorkItem(workspacePath: string, record: ResearchWorkItemRecord) {
    this.upsertRecord(workspacePath, "tasks", record, {
      objectiveId: record.objectiveId,
      branchId: record.branchId,
      kind: record.kind,
      executor: record.executor,
      status: record.status,
      createdAt: record.createdAt
    });
  }

  async writeEvaluation(workspacePath: string, record: EvaluationRecord) {
    this.upsertRecord(workspacePath, "evaluations", record, {
      objectiveId: record.objectiveId,
      branchId: record.branchId,
      taskId: record.workItemId,
      verdict: record.verdict
    });
  }

  async writeRun(workspacePath: string, record: ResearchRunRecord) {
    this.upsertRecord(workspacePath, "runs", record, {
      objectiveId: record.objectiveId,
      status: record.status
    });
  }

  async writeWorkerRun<T extends { id: string; objectiveId: string; branchId?: string; createdAt: string; updatedAt: string }>(
    workspacePath: string,
    record: T,
    metadata: {
      status?: string | null;
      kind?: string | null;
      executor?: string | null;
      taskId?: string | null;
    } = {}
  ) {
    this.upsertRecord(workspacePath, "worker_runs", record, {
      objectiveId: record.objectiveId,
      branchId: record.branchId,
      status: metadata.status,
      kind: metadata.kind,
      executor: metadata.executor,
      taskId: metadata.taskId
    });
  }

  async writeProjection(workspacePath: string, record: ResearchProjectionRecord) {
    this.upsertRecord(workspacePath, "projections", record, {
      objectiveId: record.objectiveId,
      status: record.status
    });
  }

  async writeExperimentSpec(workspacePath: string, record: ExperimentSpecRecord) {
    this.upsertRecord(workspacePath, "experiment_specs", record, {
      objectiveId: record.objectiveId,
      branchId: record.branchId,
      taskId: record.workItemId
    });
  }

  async writeExperimentResult(workspacePath: string, record: ExperimentResultRecord) {
    this.upsertRecord(workspacePath, "experiments", record, {
      objectiveId: record.objectiveId,
      branchId: record.branchId,
      taskId: record.workItemId,
      status: record.status
    });
  }

  async writeMetric(workspacePath: string, record: MetricRecord) {
    this.upsertRecord(workspacePath, "metrics", record, {
      objectiveId: record.objectiveId,
      branchId: record.branchId,
      taskId: record.workItemId,
      experimentId: record.experimentResultId
    });
  }

  async writeAttachment(workspacePath: string, record: AttachmentRecord) {
    this.upsertRecord(
      workspacePath,
      "attachments",
      {
        ...record,
        createdAt: record.importedAt
      },
      {
      objectiveId: record.objectiveId ?? null,
      importedAt: record.importedAt
      }
    );
  }

  async appendEvent(workspacePath: string, record: ResearchEventRecord) {
    const db = this.getDb(workspacePath);
    db.prepare(
      `INSERT OR REPLACE INTO events (
        id, objective_id, branch_id, task_id, type, created_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.objectiveId ?? null,
      record.branchId ?? null,
      record.workItemId ?? null,
      record.type,
      record.createdAt,
      record.createdAt,
      JSON.stringify(record)
    );
  }

  async appendActivity(workspacePath: string, message: string) {
    await appendFile(this.buildPaths(workspacePath).activityLog, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  }

  async appendPromptLog(workspacePath: string, entry: Record<string, unknown>) {
    await appendFile(
      this.buildPaths(workspacePath).promptLog,
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      "utf8"
    );
  }

  async appendWorkerHistory(workspacePath: string, entry: Record<string, unknown>) {
    await appendFile(
      this.buildPaths(workspacePath).workerHistoryLog,
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      "utf8"
    );
  }

  async listObjectives(workspacePath: string) {
    return this.selectRecords<ResearchObjectiveRecord>(workspacePath, "objectives");
  }

  async listBranches(workspacePath: string) {
    return this.selectRecords<ResearchBranchRecord>(workspacePath, "branches");
  }

  async listSources(workspacePath: string) {
    return this.selectRecords<ResearchSourceRecord>(workspacePath, "sources");
  }

  async listFindings(workspacePath: string) {
    return this.selectRecords<ResearchFindingRecord>(workspacePath, "findings");
  }

  async listSourceArtifacts(workspacePath: string) {
    return this.selectRecords<SourceArtifactRecord>(workspacePath, "source_artifacts");
  }

  async listHypotheses(workspacePath: string) {
    return this.selectRecords<ResearchHypothesisRecord>(workspacePath, "hypotheses");
  }

  async listWorkItems(workspacePath: string) {
    return this.selectRecords<ResearchWorkItemRecord>(workspacePath, "tasks");
  }

  async listEvaluations(workspacePath: string) {
    return this.selectRecords<EvaluationRecord>(workspacePath, "evaluations");
  }

  async listExperimentSpecs(workspacePath: string) {
    return this.selectRecords<ExperimentSpecRecord>(workspacePath, "experiment_specs");
  }

  async listExperimentResults(workspacePath: string) {
    return this.selectRecords<ExperimentResultRecord>(workspacePath, "experiments");
  }

  async listMetrics(workspacePath: string) {
    return this.selectRecords<MetricRecord>(workspacePath, "metrics");
  }

  async listRuns(workspacePath: string) {
    return this.selectRecords<ResearchRunRecord>(workspacePath, "runs");
  }

  async listWorkerRuns<T>(workspacePath: string) {
    return this.selectRecords<T>(workspacePath, "worker_runs");
  }

  async listAttachments(workspacePath: string, objectiveId?: string | null) {
    const attachments = this.selectRecords<AttachmentRecord>(workspacePath, "attachments");
    return objectiveId ? attachments.filter((record) => record.objectiveId === objectiveId) : attachments;
  }

  async readCurrentProjection(workspacePath: string) {
    return this.selectLatestRecord<ResearchProjectionRecord>(workspacePath, "projections");
  }

  async readCurrentRun(workspacePath: string) {
    return this.selectLatestRecord<ResearchRunRecord>(workspacePath, "runs");
  }

  async readState(workspacePath: string, scopeId?: string | null): Promise<ResearchStateSnapshot> {
    const objectiveFilter = scopeId?.trim() || null;
    const objectives = objectiveFilter
      ? (await this.listObjectives(workspacePath)).filter((record) => record.id === objectiveFilter)
      : await this.listObjectives(workspacePath);
    const objectiveIds = new Set(objectives.map((record) => record.id));
    const branches = (await this.listBranches(workspacePath))
      .filter((record) => !objectiveFilter || objectiveIds.has(record.objectiveId))
      .sort(sortByUpdatedAt);
    const branchIds = new Set(branches.map((record) => record.id));
    const sources = (await this.listSources(workspacePath))
      .filter((record) => !objectiveFilter || objectiveIds.has(record.objectiveId) || (record.branchId ? branchIds.has(record.branchId) : false))
      .sort(sortByUpdatedAt);
    const findings = (await this.listFindings(workspacePath))
      .filter((record) => !objectiveFilter || objectiveIds.has(record.objectiveId) || (record.branchId ? branchIds.has(record.branchId) : false))
      .sort(sortByUpdatedAt);
    const hypotheses = (await this.listHypotheses(workspacePath))
      .filter((record) => !objectiveFilter || objectiveIds.has(record.objectiveId) || branchIds.has(record.branchId))
      .sort(sortByUpdatedAt);
    const workItems = (await this.listWorkItems(workspacePath))
      .filter((record) => !objectiveFilter || objectiveIds.has(record.objectiveId) || branchIds.has(record.branchId))
      .sort(sortByUpdatedAt);
    const evaluations = (await this.listEvaluations(workspacePath))
      .filter((record) => !objectiveFilter || objectiveIds.has(record.objectiveId) || branchIds.has(record.branchId))
      .sort(sortByUpdatedAt);
    const experimentSpecs = (await this.listExperimentSpecs(workspacePath))
      .filter((record) => !objectiveFilter || objectiveIds.has(record.objectiveId) || branchIds.has(record.branchId))
      .sort(sortByUpdatedAt);
    const experimentResults = (await this.listExperimentResults(workspacePath))
      .filter((record) => !objectiveFilter || objectiveIds.has(record.objectiveId) || branchIds.has(record.branchId))
      .sort(sortByUpdatedAt);
    const metrics = (await this.listMetrics(workspacePath))
      .filter((record) => !objectiveFilter || objectiveIds.has(record.objectiveId) || branchIds.has(record.branchId))
      .sort(sortByUpdatedAt);
    const runs = (await this.listRuns(workspacePath))
      .filter((record) => !objectiveFilter || objectiveIds.has(record.objectiveId))
      .sort(sortByUpdatedAt);
    const latestProjection = await this.readCurrentProjection(workspacePath);
    const latestRun = await this.readCurrentRun(workspacePath);

    return {
      objectives: [...objectives].sort(sortByUpdatedAt),
      branches,
      sources,
      findings,
      hypotheses,
      workItems,
      evaluations,
      experimentSpecs,
      experimentResults,
      metrics,
      runs,
      latestObjective: [...objectives].sort(sortByUpdatedAt)[0] ?? null,
      latestBranch: branches[0] ?? null,
      latestSource: sources[0] ?? null,
      latestFinding: findings[0] ?? null,
      latestHypothesis: hypotheses[0] ?? null,
      latestWorkItem: workItems[0] ?? null,
      latestEvaluation: evaluations[0] ?? null,
      latestExperimentResult: experimentResults[0] ?? null,
      latestProjection:
        latestProjection && (!objectiveFilter || objectiveIds.has(latestProjection.objectiveId)) ? latestProjection : null,
      latestRun: latestRun && (!objectiveFilter || objectiveIds.has(latestRun.objectiveId)) ? latestRun : runs[0] ?? null
    };
  }

  private getDb(workspacePath: string) {
    const existing = this.databases.get(workspacePath);
    if (existing) {
      return existing;
    }

    const paths = this.buildPaths(workspacePath);
    const db = new DatabaseSync(paths.researchDbFile);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    this.initializeSchema(db);
    this.databases.set(workspacePath, db);
    return db;
  }

  private initializeSchema(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS id_counters (
        kind TEXT PRIMARY KEY,
        next_value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS objectives (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS branch_heads (
        branch_id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        base_commit TEXT,
        git_ref TEXT,
        head_commit TEXT,
        worktree_path TEXT,
        promotion_head_commit TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_runs (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_artifacts (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hypotheses (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_specs (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metrics (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projections (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        branch_id TEXT,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        objective_id TEXT,
        branch_id TEXT,
        status TEXT,
        kind TEXT,
        executor TEXT,
        locator TEXT,
        score REAL,
        verdict TEXT,
        task_id TEXT,
        experiment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        objective_id TEXT,
        branch_id TEXT,
        task_id TEXT,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_branches_objective ON branches(objective_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_objective ON tasks(objective_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_objective ON runs(objective_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sources_objective ON sources(objective_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_findings_objective ON findings(objective_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_evaluations_objective ON evaluations(objective_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_experiments_objective ON experiments(objective_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_metrics_objective ON metrics(objective_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_projections_objective ON projections(objective_id, updated_at DESC);
    `);

    const schemaVersion = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    if (schemaVersion?.value && Number(schemaVersion.value) !== PROJECT_SCHEMA_VERSION) {
      throw new Error(
        `Lithium V3 found incompatible state in .lithium/research.db. Clear .lithium and retry.`
      );
    }
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(String(PROJECT_SCHEMA_VERSION));
  }

  private async assertNoLegacyWorkspace(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    const hasDb = await pathExists(paths.researchDbFile);
    if (hasDb) {
      return;
    }

    for (const relativePath of LEGACY_LITHIUM_SENTINELS) {
      if (await pathExists(path.join(paths.root, relativePath))) {
        throw new Error("Legacy Lithium state detected. Clear .lithium and retry with Lithium V3.");
      }
    }

    const rootExists = await pathExists(paths.root);
    if (!rootExists) {
      return;
    }

    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(paths.root, { withFileTypes: true }).catch(() => [])
    );
    const unsupported = entries.find((entry) => !V3_ALLOWED_ROOT_NAMES.has(entry.name));
    if (unsupported) {
      throw new Error("Legacy Lithium state detected. Clear .lithium and retry with Lithium V3.");
    }
  }

  private nextId(workspacePath: string, kind: CounterKind) {
    const db = this.getDb(workspacePath);
    const row = db.prepare("SELECT next_value FROM id_counters WHERE kind = ?").get(kind) as
      | { next_value: number }
      | undefined;
    const nextValue = row?.next_value ?? 1;
    db.prepare(
      `INSERT INTO id_counters(kind, next_value) VALUES(?, ?)
       ON CONFLICT(kind) DO UPDATE SET next_value = excluded.next_value`
    ).run(kind, nextValue + 1);
    return `${COUNTER_PREFIX[kind]}${String(nextValue).padStart(3, "0")}`;
  }

  private writeProjectSync(db: DatabaseSync, project: ProjectRecord) {
    db.prepare(
      `INSERT INTO projects(id, updated_at, payload) VALUES(?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload`
    ).run(project.id, project.updatedAt, JSON.stringify(project));
  }

  private readProjectSync(db: DatabaseSync) {
    const row = db.prepare("SELECT payload FROM projects ORDER BY updated_at DESC LIMIT 1").get() as
      | { payload: string }
      | undefined;
    return row ? safeParse<ProjectRecord>(row.payload) : null;
  }

  private upsertBranchHead(workspacePath: string, branch: ResearchBranchRecord) {
    const db = this.getDb(workspacePath);
    const now = branch.lastUpdatedAt ?? branch.updatedAt;
    db.prepare(
      `INSERT INTO branch_heads(
        branch_id, objective_id, base_commit, git_ref, head_commit, worktree_path, promotion_head_commit,
        created_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(branch_id) DO UPDATE SET
        objective_id = excluded.objective_id,
        base_commit = excluded.base_commit,
        git_ref = excluded.git_ref,
        head_commit = excluded.head_commit,
        worktree_path = excluded.worktree_path,
        promotion_head_commit = excluded.promotion_head_commit,
        updated_at = excluded.updated_at,
        payload = excluded.payload`
    ).run(
      branch.id,
      branch.objectiveId,
      branch.baseCommit ?? null,
      branch.gitRef ?? null,
      branch.headCommit ?? null,
      branch.worktreePath ?? null,
      branch.promotionHeadCommit ?? null,
      branch.createdAt,
      now,
      JSON.stringify({
        branchId: branch.id,
        objectiveId: branch.objectiveId,
        baseCommit: branch.baseCommit ?? null,
        gitRef: branch.gitRef ?? null,
        headCommit: branch.headCommit ?? null,
        worktreePath: branch.worktreePath ?? null,
        promotionHeadCommit: branch.promotionHeadCommit ?? null,
        updatedAt: now
      })
    );
  }

  private upsertRecord(
    workspacePath: string,
    table:
      | "objectives"
      | "branches"
      | "tasks"
      | "runs"
      | "worker_runs"
      | "sources"
      | "source_artifacts"
      | "findings"
      | "hypotheses"
      | "experiment_specs"
      | "experiments"
      | "metrics"
      | "evaluations"
      | "projections"
      | "attachments",
    record: { id: string; objectiveId?: string; branchId?: string; createdAt: string; updatedAt: string },
    metadata: {
      objectiveId?: string | null;
      branchId?: string | null;
      kind?: string | null;
      executor?: string | null;
      status?: string | null;
      locator?: string | null;
      score?: number | null;
      verdict?: string | null;
      taskId?: string | null;
      sourceId?: string | null;
      experimentId?: string | null;
      createdAt?: string | null;
      updatedAt?: string | null;
      importedAt?: string | null;
    } = {}
  ) {
    const db = this.getDb(workspacePath);
    const createdAt = metadata.importedAt ?? metadata.createdAt ?? record.createdAt;
    const updatedAt = metadata.updatedAt ?? record.updatedAt;
    db.prepare(
      `INSERT INTO ${table}(
        id, objective_id, branch_id, status, kind, executor, locator, score, verdict, task_id, experiment_id,
        created_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        objective_id = excluded.objective_id,
        branch_id = excluded.branch_id,
        status = excluded.status,
        kind = excluded.kind,
        executor = excluded.executor,
        locator = excluded.locator,
        score = excluded.score,
        verdict = excluded.verdict,
        task_id = excluded.task_id,
        experiment_id = excluded.experiment_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        payload = excluded.payload`
    ).run(
      record.id,
      metadata.objectiveId ?? record.objectiveId ?? null,
      metadata.branchId ?? record.branchId ?? null,
      metadata.status ?? null,
      metadata.kind ?? null,
      metadata.executor ?? null,
      metadata.locator ?? null,
      metadata.score ?? null,
      metadata.verdict ?? null,
      metadata.taskId ?? null,
      metadata.experimentId ?? null,
      createdAt,
      updatedAt,
      JSON.stringify(record)
    );
  }

  private selectRecords<T>(workspacePath: string, table: string) {
    const db = this.getDb(workspacePath);
    const rows = db.prepare(`SELECT payload FROM ${table} ORDER BY updated_at DESC, created_at DESC, id DESC`).all() as Array<{
      payload: string;
    }>;
    return rows.map((row) => safeParse<T>(row.payload)).filter(Boolean) as T[];
  }

  private selectLatestRecord<T>(workspacePath: string, table: string) {
    const db = this.getDb(workspacePath);
    const row = db.prepare(`SELECT payload FROM ${table} ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1`).get() as
      | { payload: string }
      | undefined;
    return row ? safeParse<T>(row.payload) : null;
  }
}

function safeParse<T>(value: string) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function sortByUpdatedAt<T extends { updatedAt: string; createdAt?: string }>(left: T, right: T) {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    (right.createdAt ?? "").localeCompare(left.createdAt ?? "")
  );
}
