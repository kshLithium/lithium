import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  BranchRecord,
  EvaluationDecisionRecord,
  EventRecord,
  ExperimentRunRecord,
  ExperimentSpecRecord,
  FindingRecord,
  MetricRecord,
  ObjectiveRecord,
  PromotionRecord,
  RunRecord,
  SourceChunkRecord,
  SourceLinkRecord,
  SourceRecord,
  StatusSnapshot,
  TaskRecord,
  WorkerRunRecord,
  WorkspaceProjection,
  WorkspaceRecord,
  WorktreeLeaseRecord
} from "../../shared/types";
import {
  LEGACY_LITHIUM_ROOT_ITEMS,
  PROJECT_SCHEMA_VERSION,
  buildProjectPaths
} from "../services/workspace-layout";
import { createId, nowIso } from "./utils";

type ProjectionKind =
  | "workspace"
  | "objective"
  | "branch"
  | "task"
  | "run"
  | "source"
  | "source_chunk"
  | "source_link"
  | "finding"
  | "evaluation"
  | "experiment_spec"
  | "experiment"
  | "metric"
  | "promotion"
  | "worker_run"
  | "lease";

type TypedProjectionMap = {
  workspace: WorkspaceRecord;
  objective: ObjectiveRecord;
  branch: BranchRecord;
  task: TaskRecord;
  run: RunRecord;
  source: SourceRecord;
  source_chunk: SourceChunkRecord;
  source_link: SourceLinkRecord;
  finding: FindingRecord;
  evaluation: EvaluationDecisionRecord;
  experiment_spec: ExperimentSpecRecord;
  experiment: ExperimentRunRecord;
  metric: MetricRecord;
  promotion: PromotionRecord;
  worker_run: WorkerRunRecord;
  lease: WorktreeLeaseRecord;
};

export type ProjectionMutation<K extends ProjectionKind = ProjectionKind> =
  | {
      type: "upsert";
      kind: K;
      value: TypedProjectionMap[K];
    }
  | {
      type: "delete";
      kind: ProjectionKind;
      id: string;
    }
  | {
      type: "event";
      value: EventRecord;
    };

const requireBuiltin: NodeJS.Require =
  typeof require === "function"
    ? require
    : createRequire(path.join(process.cwd(), "__lithium_store__.cjs"));
const { DatabaseSync } = requireBuiltin(["node", "sqlite"].join(":")) as typeof import("node:sqlite");
type SqliteDatabase = InstanceType<typeof DatabaseSync>;

export class ResearchStore {
  private dbByWorkspace = new Map<string, SqliteDatabase>();

  async initializeWorkspace(workspacePath: string) {
    const paths = buildProjectPaths(workspacePath);
    const legacy = await this.detectLegacyState(workspacePath);
    if (legacy.length > 0) {
      throw new Error(
        `Legacy Lithium state detected (${legacy.join(", ")}). Use 'lithium workspace archive' or 'lithium workspace reset' first.`
      );
    }

    await Promise.all([
      mkdir(paths.root, { recursive: true }),
      mkdir(paths.stateDir, { recursive: true }),
      mkdir(paths.runtimeDir, { recursive: true }),
      mkdir(paths.artifactsDir, { recursive: true }),
      mkdir(paths.indexDir, { recursive: true }),
      mkdir(paths.leasesDir, { recursive: true }),
      mkdir(paths.tempEnvDir, { recursive: true }),
      mkdir(paths.workerRunsDir, { recursive: true }),
      mkdir(paths.strategistRunsDir, { recursive: true }),
      mkdir(paths.evaluatorRunsDir, { recursive: true }),
      mkdir(paths.sourceBodiesDir, { recursive: true }),
      mkdir(paths.sourceTextsDir, { recursive: true }),
      mkdir(paths.sourceChunksDir, { recursive: true }),
      mkdir(paths.experimentDir, { recursive: true }),
      mkdir(paths.patchesDir, { recursive: true }),
      mkdir(paths.attachmentsDir, { recursive: true }),
      mkdir(paths.worktreesDir, { recursive: true })
    ]);

    const workspace = this.getWorkspace(workspacePath);
    if (!workspace) {
      const now = nowIso();
      this.upsertProjection(workspacePath, "workspace", {
        id: "workspace",
        schemaVersion: PROJECT_SCHEMA_VERSION,
        workspacePath,
        createdAt: now,
        updatedAt: now
      });
    }
  }

  async detectLegacyState(workspacePath: string) {
    const paths = buildProjectPaths(workspacePath);
    const found: string[] = [];

    for (const item of LEGACY_LITHIUM_ROOT_ITEMS) {
      if (await pathExists(path.join(paths.root, item))) {
        found.push(item);
      }
    }

    if (await pathExists(paths.legacyResearchDbFile)) {
      found.push("research.db");
    }

    return Array.from(new Set(found));
  }

  async archiveWorkspace(workspacePath: string) {
    const paths = buildProjectPaths(workspacePath);
    if (!(await pathExists(paths.root))) {
      throw new Error("No .lithium directory exists in this workspace.");
    }

    const archivePath = path.join(workspacePath, `.lithium-archive-${Date.now()}`);
    await rename(paths.root, archivePath);
    this.closeWorkspace(workspacePath);
    return {
      archivedPath: archivePath
    };
  }

  async resetWorkspace(workspacePath: string) {
    const paths = buildProjectPaths(workspacePath);
    await rm(paths.root, { recursive: true, force: true });
    this.closeWorkspace(workspacePath);
  }

  closeWorkspace(workspacePath: string) {
    const db = this.dbByWorkspace.get(workspacePath);
    db?.close();
    this.dbByWorkspace.delete(workspacePath);
  }

  appendEvent(workspacePath: string, event: EventRecord) {
    this.applyMutations(workspacePath, [
      {
        type: "event",
        value: event
      }
    ]);
  }

  listEvents(workspacePath: string) {
    const db = this.getDb(workspacePath);
    return db
      .prepare(`SELECT seq, id, type, objective_id, branch_id, run_id, task_id, created_at, payload FROM events ORDER BY seq ASC`)
      .all()
      .map((row: any) => ({
        sequence: Number(row.seq),
        id: String(row.id),
        type: String(row.type),
        objectiveId: readNullableString(row.objective_id),
        branchId: readNullableString(row.branch_id),
        runId: readNullableString(row.run_id),
        taskId: readNullableString(row.task_id),
        createdAt: String(row.created_at),
        payload: safeParse<Record<string, unknown>>(String(row.payload), {})
      }));
  }

  getWorkspace(workspacePath: string) {
    return this.readProjection(workspacePath, "workspace", "workspace");
  }

  readProjection<K extends ProjectionKind>(
    workspacePath: string,
    kind: K,
    id: string
  ): TypedProjectionMap[K] | null {
    const db = this.getDb(workspacePath);
    const row = db.prepare(`SELECT payload FROM ${tableNameForKind(kind)} WHERE id = ?`).get(id) as { payload: string } | undefined;
    return row ? parseNullable<TypedProjectionMap[K]>(row.payload) : null;
  }

  listProjections<K extends ProjectionKind>(workspacePath: string, kind: K): TypedProjectionMap[K][] {
    const db = this.getDb(workspacePath);
    return db
      .prepare(`SELECT payload FROM ${tableNameForKind(kind)}`)
      .all()
      .map((row: any) => parseNullable<TypedProjectionMap[K]>(String(row.payload)))
      .filter((entry: TypedProjectionMap[K] | null): entry is TypedProjectionMap[K] => Boolean(entry));
  }

  upsertProjection<K extends ProjectionKind>(workspacePath: string, kind: K, value: TypedProjectionMap[K]) {
    this.applyMutations(workspacePath, [
      {
        type: "upsert",
        kind,
        value
      }
    ]);
  }

  deleteProjection(workspacePath: string, kind: ProjectionKind, id: string) {
    this.applyMutations(workspacePath, [
      {
        type: "delete",
        kind,
        id
      }
    ]);
  }

  applyMutations(workspacePath: string, operations: ProjectionMutation[]) {
    const db = this.getDb(workspacePath);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const operation of operations) {
        switch (operation.type) {
          case "upsert": {
            const columns = projectionColumns(operation.kind, operation.value);
            db.prepare(columns.sql).run(...columns.values);
            break;
          }
          case "delete": {
            db.prepare(`DELETE FROM ${tableNameForKind(operation.kind)} WHERE id = ?`).run(operation.id);
            break;
          }
          case "event": {
            db.prepare(
              `INSERT INTO events (id, type, objective_id, branch_id, run_id, task_id, created_at, payload)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              operation.value.id,
              operation.value.type,
              operation.value.objectiveId ?? null,
              operation.value.branchId ?? null,
              operation.value.runId ?? null,
              operation.value.taskId ?? null,
              operation.value.createdAt,
              JSON.stringify(operation.value.payload)
            );
            break;
          }
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  getProjection(workspacePath: string): WorkspaceProjection {
    const objectives = this.listProjections(workspacePath, "objective").sort(byUpdatedAtDesc);
    const branches = this.listProjections(workspacePath, "branch").sort(byUpdatedAtDesc);
    const tasks = this.listProjections(workspacePath, "task").sort(byCreatedAtAsc);
    const runs = this.listProjections(workspacePath, "run").sort(byUpdatedAtDesc);
    const sources = this.listProjections(workspacePath, "source").sort(byUpdatedAtDesc);
    const sourceChunks = this.listProjections(workspacePath, "source_chunk").sort(byChunkIndexAsc);
    const sourceLinks = this.listProjections(workspacePath, "source_link").sort(byUpdatedAtDesc);
    const findings = this.listProjections(workspacePath, "finding").sort(byUpdatedAtDesc);
    const evaluations = this.listProjections(workspacePath, "evaluation").sort(byUpdatedAtDesc);
    const experimentSpecs = this.listProjections(workspacePath, "experiment_spec").sort(byUpdatedAtDesc);
    const experiments = this.listProjections(workspacePath, "experiment").sort(byUpdatedAtDesc);
    const metrics = this.listProjections(workspacePath, "metric").sort(byUpdatedAtDesc);
    const promotions = this.listProjections(workspacePath, "promotion").sort(byUpdatedAtDesc);
    const workerRuns = this.listProjections(workspacePath, "worker_run").sort(byUpdatedAtDesc);
    const leases = this.listProjections(workspacePath, "lease").sort(byUpdatedAtDesc);
    const activeObjective =
      objectives.find((entry) => entry.id === runs.find((run) => run.status === "active" || run.status === "paused")?.objectiveId) ??
      objectives.find((entry) => entry.status === "active" || entry.status === "draft") ??
      objectives[0] ??
      null;

    return {
      workspace: this.getWorkspace(workspacePath),
      objectives,
      activeObjective,
      branches,
      tasks,
      runs,
      sources,
      sourceChunks,
      sourceLinks,
      findings,
      evaluations,
      experimentSpecs,
      experiments,
      metrics,
      promotions,
      workerRuns,
      leases
    };
  }

  getStatusSnapshot(workspacePath: string, daemon: { running: boolean; pid?: number; socketPath: string }): StatusSnapshot {
    const projection = this.getProjection(workspacePath);
    const activeObjective = projection.activeObjective;
    const activeRun =
      projection.runs.find((entry) => activeObjective && entry.objectiveId === activeObjective.id && entry.status === "active") ??
      projection.runs.find((entry) => activeObjective && entry.objectiveId === activeObjective.id && entry.status === "paused") ??
      null;
    const activeBranchIds = new Set(
      projection.branches
        .filter((entry) => !activeObjective || entry.objectiveId === activeObjective.id)
        .map((entry) => entry.id)
    );

    return {
      workspacePath,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      daemon,
      activeObjective,
      activeRun,
      branches: projection.branches.filter((entry) => activeBranchIds.has(entry.id)).slice(0, 8),
      queue: projection.tasks.filter((entry) => entry.status === "pending" && (!activeRun || entry.runId === activeRun.id)),
      activeTasks: projection.tasks.filter((entry) => entry.status === "running" && (!activeRun || entry.runId === activeRun.id)),
      recentEvaluations: projection.evaluations.slice(0, 5),
      recentFindings: projection.findings.slice(0, 5)
    };
  }

  createEvent(input: Omit<EventRecord, "id" | "createdAt"> & Partial<Pick<EventRecord, "id" | "createdAt">>): EventRecord {
    return {
      id: input.id ?? createId("evt"),
      createdAt: input.createdAt ?? nowIso(),
      type: input.type,
      objectiveId: input.objectiveId,
      branchId: input.branchId,
      runId: input.runId,
      taskId: input.taskId,
      payload: input.payload
    };
  }

  private getDb(workspacePath: string) {
    const existing = this.dbByWorkspace.get(workspacePath);
    if (existing) {
      return existing;
    }

    const paths = buildProjectPaths(workspacePath);
    const db = new DatabaseSync(paths.researchDbFile);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    initializeSchema(db);
    this.dbByWorkspace.set(workspacePath, db);
    return db;
  }
}

function initializeSchema(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      objective_id TEXT,
      branch_id TEXT,
      run_id TEXT,
      task_id TEXT,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_projection (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS objectives (
      id TEXT PRIMARY KEY,
      status TEXT,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      status TEXT,
      score REAL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_chunks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      objective_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      text TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_links (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      branch_id TEXT,
      scope TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS experiment_specs (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metrics (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS promotions (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_runs (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leases (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
}

function projectionColumns(kind: ProjectionKind, value: any) {
  const payload = JSON.stringify(value);
  switch (kind) {
    case "workspace":
      return {
        sql: `INSERT OR REPLACE INTO workspace_projection (id, updated_at, payload) VALUES (?, ?, ?)`,
        values: [value.id, value.updatedAt, payload]
      };
    case "objective":
      return {
        sql: `INSERT OR REPLACE INTO objectives (id, status, updated_at, payload) VALUES (?, ?, ?, ?)`,
        values: [value.id, value.status, value.updatedAt, payload]
      };
    case "branch":
      return {
        sql: `INSERT OR REPLACE INTO branches (id, objective_id, status, score, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.status, value.score, value.updatedAt, payload]
      };
    case "task":
      return {
        sql: `INSERT OR REPLACE INTO tasks (id, objective_id, branch_id, run_id, kind, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.branchId, value.runId, value.kind, value.status, value.createdAt, value.updatedAt, payload]
      };
    case "run":
      return {
        sql: `INSERT OR REPLACE INTO runs (id, objective_id, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.status, value.createdAt, value.updatedAt, payload]
      };
    case "source":
      return {
        sql: `INSERT OR REPLACE INTO sources (id, objective_id, kind, updated_at, payload) VALUES (?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.kind, value.updatedAt, payload]
      };
    case "source_chunk":
      return {
        sql: `INSERT OR REPLACE INTO source_chunks (id, source_id, objective_id, chunk_index, updated_at, text, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        values: [value.id, value.sourceId, value.objectiveId, value.chunkIndex, value.updatedAt, value.text, payload]
      };
    case "source_link":
      return {
        sql: `INSERT OR REPLACE INTO source_links (id, objective_id, source_id, branch_id, scope, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.sourceId, value.branchId ?? null, value.scope, value.updatedAt, payload]
      };
    case "finding":
      return {
        sql: `INSERT OR REPLACE INTO findings (id, objective_id, branch_id, updated_at, payload) VALUES (?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.branchId, value.updatedAt, payload]
      };
    case "evaluation":
      return {
        sql: `INSERT OR REPLACE INTO evaluations (id, objective_id, branch_id, verdict, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.branchId, value.verdict, value.updatedAt, payload]
      };
    case "experiment_spec":
      return {
        sql: `INSERT OR REPLACE INTO experiment_specs (id, objective_id, branch_id, updated_at, payload) VALUES (?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.branchId, value.updatedAt, payload]
      };
    case "experiment":
      return {
        sql: `INSERT OR REPLACE INTO experiments (id, objective_id, branch_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.branchId, value.status, value.updatedAt, payload]
      };
    case "metric":
      return {
        sql: `INSERT OR REPLACE INTO metrics (id, objective_id, branch_id, updated_at, payload) VALUES (?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.branchId, value.updatedAt, payload]
      };
    case "promotion":
      return {
        sql: `INSERT OR REPLACE INTO promotions (id, objective_id, branch_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.branchId, value.status, value.updatedAt, payload]
      };
    case "worker_run":
      return {
        sql: `INSERT OR REPLACE INTO worker_runs (id, objective_id, branch_id, run_id, task_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [value.id, value.objectiveId, value.branchId, value.runId, value.taskId, value.status, value.updatedAt, payload]
      };
    case "lease":
      return {
        sql: `INSERT OR REPLACE INTO leases (id, branch_id, task_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)`,
        values: [value.id, value.branchId, value.taskId, value.status, value.updatedAt, payload]
      };
  }
}

function tableNameForKind(kind: ProjectionKind) {
  switch (kind) {
    case "workspace":
      return "workspace_projection";
    case "objective":
      return "objectives";
    case "branch":
      return "branches";
    case "task":
      return "tasks";
    case "run":
      return "runs";
    case "source":
      return "sources";
    case "source_chunk":
      return "source_chunks";
    case "source_link":
      return "source_links";
    case "finding":
      return "findings";
    case "evaluation":
      return "evaluations";
    case "experiment_spec":
      return "experiment_specs";
    case "experiment":
      return "experiments";
    case "metric":
      return "metrics";
    case "promotion":
      return "promotions";
    case "worker_run":
      return "worker_runs";
    case "lease":
      return "leases";
  }
}

function parseNullable<T>(value: string) {
  return safeParse<T | null>(value, null);
}

function safeParse<T>(value: string, fallback: T) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readNullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function byUpdatedAtDesc<T extends { updatedAt: string }>(left: T, right: T) {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function byCreatedAtAsc<T extends { createdAt: string }>(left: T, right: T) {
  return left.createdAt.localeCompare(right.createdAt);
}

function byChunkIndexAsc<T extends { chunkIndex: number; updatedAt: string }>(left: T, right: T) {
  return left.chunkIndex - right.chunkIndex || left.updatedAt.localeCompare(right.updatedAt);
}

async function pathExists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
