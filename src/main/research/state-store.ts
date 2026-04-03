import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AutomationCheckpointRecord,
  AutomationSessionRecord,
  DecisionRecord,
  EvaluationRecord,
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
  RunRecord
} from "../../shared/types";
import { DEFAULT_PROJECT_RESEARCH_GOAL, PROJECT_SCHEMA_VERSION } from "../../shared/types";
import { pathExists } from "../services/fs-utils";
import { RecordStore } from "../services/record-store";
import { buildProjectPaths } from "../services/workspace-layout";

export type ResearchStateSnapshot = {
  objectives: ResearchObjectiveRecord[];
  branches: ResearchBranchRecord[];
  sources: ResearchSourceRecord[];
  findings: ResearchFindingRecord[];
  hypotheses: ResearchHypothesisRecord[];
  workItems: ResearchWorkItemRecord[];
  evaluations: EvaluationRecord[];
  runs: ResearchRunRecord[];
  latestObjective: ResearchObjectiveRecord | null;
  latestBranch: ResearchBranchRecord | null;
  latestSource: ResearchSourceRecord | null;
  latestFinding: ResearchFindingRecord | null;
  latestHypothesis: ResearchHypothesisRecord | null;
  latestWorkItem: ResearchWorkItemRecord | null;
  latestEvaluation: EvaluationRecord | null;
  latestProjection: ResearchProjectionRecord | null;
  latestRun: ResearchRunRecord | null;
};

export type LegacyMigrationResult = {
  migrated: boolean;
  objectiveId?: string;
  runId?: string;
};

type LegacySeed = {
  session: AutomationSessionRecord | null;
  checkpoint: AutomationCheckpointRecord | null;
  decision: DecisionRecord | null;
  run: RunRecord | null;
  threadTitle: string;
};

const LEGACY_DIR_NAMES = ["automation", "conversation", "threads", "routes", "decisions", "tasks"] as const;

export class ResearchStateStore {
  private readonly records = new RecordStore();

  buildPaths(workspacePath: string) {
    return buildProjectPaths(workspacePath);
  }

  async ensureLayout(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    await Promise.all([
      mkdir(paths.root, { recursive: true }),
      mkdir(paths.researchDir, { recursive: true }),
      mkdir(paths.researchObjectivesDir, { recursive: true }),
      mkdir(paths.researchBranchesDir, { recursive: true }),
      mkdir(paths.researchSourcesDir, { recursive: true }),
      mkdir(paths.researchFindingsDir, { recursive: true }),
      mkdir(paths.researchHypothesesDir, { recursive: true }),
      mkdir(paths.researchWorkItemsDir, { recursive: true }),
      mkdir(paths.researchEvaluationsDir, { recursive: true }),
      mkdir(paths.researchProjectionsDir, { recursive: true }),
      mkdir(paths.researchRunsDir, { recursive: true }),
      mkdir(paths.researchOracleSessionsDir, { recursive: true }),
      mkdir(paths.worktreesDir, { recursive: true }),
      mkdir(paths.legacyV2Dir, { recursive: true })
    ]);
  }

  async readProject(workspacePath: string) {
    return await this.records.readJson<ProjectRecord>(this.buildPaths(workspacePath).projectFile);
  }

  async initWorkspace(workspacePath: string) {
    await this.ensureLayout(workspacePath);
    const existing = await this.readProject(workspacePath);
    const now = new Date().toISOString();

    const project: ProjectRecord = existing ?? {
      id: `project-${path.basename(workspacePath)}`,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name: path.basename(workspacePath) || "lithium",
      workspacePath,
      oracleModel: "gpt-5.4-pro",
      codexModel: "gpt-5.4",
      defaultThreadId: "",
      activeThreadId: "",
      createdAt: now,
      updatedAt: now
    };

    const normalized: ProjectRecord = {
      ...project,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      workspacePath,
      updatedAt: now
    };
    await this.records.writeJson(this.buildPaths(workspacePath).projectFile, normalized);
    return normalized;
  }

  async writeProject(workspacePath: string, project: ProjectRecord) {
    await this.ensureLayout(workspacePath);
    await this.records.writeJson(this.buildPaths(workspacePath).projectFile, project);
  }

  async allocateObjective(workspacePath: string) {
    return await this.allocateRecord(workspacePath, "objective");
  }

  async allocateBranch(workspacePath: string) {
    return await this.allocateRecord(workspacePath, "branch");
  }

  async allocateSource(workspacePath: string) {
    return await this.allocateRecord(workspacePath, "source");
  }

  async allocateFinding(workspacePath: string) {
    return await this.allocateRecord(workspacePath, "finding");
  }

  async allocateHypothesis(workspacePath: string) {
    return await this.allocateRecord(workspacePath, "hypothesis");
  }

  async allocateWorkItem(workspacePath: string) {
    return await this.allocateRecord(workspacePath, "work-item");
  }

  async allocateEvaluation(workspacePath: string) {
    return await this.allocateRecord(workspacePath, "evaluation");
  }

  async allocateProjection(workspacePath: string) {
    return await this.allocateRecord(workspacePath, "projection");
  }

  async allocateRun(workspacePath: string) {
    return await this.allocateRecord(workspacePath, "run");
  }

  async writeObjective(workspacePath: string, record: ResearchObjectiveRecord) {
    await this.writeScopedRecord(workspacePath, this.buildPaths(workspacePath).researchObjectivesDir, record.id, record);
  }

  async writeBranch(workspacePath: string, record: ResearchBranchRecord) {
    await this.writeScopedRecord(workspacePath, this.buildPaths(workspacePath).researchBranchesDir, record.id, record);
  }

  async writeSource(workspacePath: string, record: ResearchSourceRecord) {
    await this.writeScopedRecord(workspacePath, this.buildPaths(workspacePath).researchSourcesDir, record.id, record);
  }

  async writeFinding(workspacePath: string, record: ResearchFindingRecord) {
    await this.writeScopedRecord(workspacePath, this.buildPaths(workspacePath).researchFindingsDir, record.id, record);
  }

  async writeHypothesis(workspacePath: string, record: ResearchHypothesisRecord) {
    await this.writeScopedRecord(workspacePath, this.buildPaths(workspacePath).researchHypothesesDir, record.id, record);
  }

  async writeWorkItem(workspacePath: string, record: ResearchWorkItemRecord) {
    await this.writeScopedRecord(workspacePath, this.buildPaths(workspacePath).researchWorkItemsDir, record.id, record);
  }

  async writeEvaluation(workspacePath: string, record: EvaluationRecord) {
    await this.writeScopedRecord(workspacePath, this.buildPaths(workspacePath).researchEvaluationsDir, record.id, record);
  }

  async writeRun(workspacePath: string, record: ResearchRunRecord) {
    const paths = this.buildPaths(workspacePath);
    await this.writeScopedRecord(workspacePath, paths.researchRunsDir, record.id, record);
    await this.records.writeJson(paths.researchCurrentRunFile, record);
  }

  async writeProjection(workspacePath: string, record: ResearchProjectionRecord) {
    const paths = this.buildPaths(workspacePath);
    await this.writeScopedRecord(workspacePath, paths.researchProjectionsDir, record.id, record);
    await this.records.writeJson(paths.researchCurrentProjectionFile, record);
  }

  async appendEvent(workspacePath: string, record: ResearchEventRecord) {
    await this.ensureLayout(workspacePath);
    await appendFile(this.buildPaths(workspacePath).researchEventsFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  async listObjectives(workspacePath: string) {
    return await this.records.readRecordDirectory<ResearchObjectiveRecord>(this.buildPaths(workspacePath).researchObjectivesDir);
  }

  async listBranches(workspacePath: string) {
    return await this.records.readRecordDirectory<ResearchBranchRecord>(this.buildPaths(workspacePath).researchBranchesDir);
  }

  async listSources(workspacePath: string) {
    return await this.records.readRecordDirectory<ResearchSourceRecord>(this.buildPaths(workspacePath).researchSourcesDir);
  }

  async listFindings(workspacePath: string) {
    return await this.records.readRecordDirectory<ResearchFindingRecord>(this.buildPaths(workspacePath).researchFindingsDir);
  }

  async listHypotheses(workspacePath: string) {
    return await this.records.readRecordDirectory<ResearchHypothesisRecord>(this.buildPaths(workspacePath).researchHypothesesDir);
  }

  async listWorkItems(workspacePath: string) {
    return await this.records.readRecordDirectory<ResearchWorkItemRecord>(this.buildPaths(workspacePath).researchWorkItemsDir);
  }

  async listEvaluations(workspacePath: string) {
    return await this.records.readRecordDirectory<EvaluationRecord>(this.buildPaths(workspacePath).researchEvaluationsDir);
  }

  async listRuns(workspacePath: string) {
    const runs = await this.records.readRecordDirectory<ResearchRunRecord>(this.buildPaths(workspacePath).researchRunsDir);
    const deduped = new Map<string, ResearchRunRecord>();

    for (const run of runs) {
      if (!run?.id || run.id === "current") {
        continue;
      }

      if (!deduped.has(run.id)) {
        deduped.set(run.id, run);
      }
    }

    return [...deduped.values()];
  }

  async readCurrentProjection(workspacePath: string) {
    return await this.records.readJson<ResearchProjectionRecord>(this.buildPaths(workspacePath).researchCurrentProjectionFile);
  }

  async readCurrentRun(workspacePath: string) {
    return await this.records.readJson<ResearchRunRecord>(this.buildPaths(workspacePath).researchCurrentRunFile);
  }

  async readEvents(workspacePath: string) {
    const content = await readFile(this.buildPaths(workspacePath).researchEventsFile, "utf8").catch(() => "");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ResearchEventRecord];
        } catch {
          return [];
        }
      });
  }

  async readState(workspacePath: string, scopeId?: string | null): Promise<ResearchStateSnapshot> {
    const [
      objectives,
      branches,
      sources,
      findings,
      hypotheses,
      workItems,
      evaluations,
      runs,
      latestProjection,
      latestRunFile
    ] = await Promise.all([
      this.listObjectives(workspacePath),
      this.listBranches(workspacePath),
      this.listSources(workspacePath),
      this.listFindings(workspacePath),
      this.listHypotheses(workspacePath),
      this.listWorkItems(workspacePath),
      this.listEvaluations(workspacePath),
      this.listRuns(workspacePath),
      this.readCurrentProjection(workspacePath),
      this.readCurrentRun(workspacePath)
    ]);

    const scopedObjectives = objectives.filter((record) => matchesScope(record, scopeId)).sort(sortByUpdatedAt);
    const objectiveIds = new Set(scopedObjectives.map((record) => record.id));
    const scopedBranches = branches
      .filter((record) => matchesScope(record, scopeId) || objectiveIds.has(record.objectiveId))
      .sort(sortByUpdatedAt);
    const branchIds = new Set(scopedBranches.map((record) => record.id));
    const scopedSources = sources
      .filter((record) => matchesScope(record, scopeId) || objectiveIds.has(record.objectiveId) || (record.branchId ? branchIds.has(record.branchId) : false))
      .sort(sortByUpdatedAt);
    const scopedFindings = findings
      .filter((record) => matchesScope(record, scopeId) || objectiveIds.has(record.objectiveId) || (record.branchId ? branchIds.has(record.branchId) : false))
      .sort(sortByUpdatedAt);
    const scopedHypotheses = hypotheses
      .filter((record) => matchesScope(record, scopeId) || objectiveIds.has(record.objectiveId) || branchIds.has(record.branchId))
      .sort(sortByUpdatedAt);
    const scopedWorkItems = workItems
      .filter((record) => matchesScope(record, scopeId) || objectiveIds.has(record.objectiveId) || branchIds.has(record.branchId))
      .sort(sortByUpdatedAt);
    const scopedEvaluations = evaluations
      .filter((record) => matchesScope(record, scopeId) || objectiveIds.has(record.objectiveId) || branchIds.has(record.branchId))
      .sort(sortByUpdatedAt);
    const scopedRuns = runs
      .filter((record) => matchesScope(record, scopeId) || objectiveIds.has(record.objectiveId))
      .sort(sortByUpdatedAt);

    return {
      objectives: scopedObjectives,
      branches: scopedBranches,
      sources: scopedSources,
      findings: scopedFindings,
      hypotheses: scopedHypotheses,
      workItems: scopedWorkItems,
      evaluations: scopedEvaluations,
      runs: scopedRuns,
      latestObjective: scopedObjectives[0] ?? null,
      latestBranch: scopedBranches[0] ?? null,
      latestSource: scopedSources[0] ?? null,
      latestFinding: scopedFindings[0] ?? null,
      latestHypothesis: scopedHypotheses[0] ?? null,
      latestWorkItem: scopedWorkItems[0] ?? null,
      latestEvaluation: scopedEvaluations[0] ?? null,
      latestProjection: latestProjection && (!scopeId || matchesScope(latestProjection, scopeId) || objectiveIds.has(latestProjection.objectiveId))
        ? latestProjection
        : null,
      latestRun: latestRunFile && (!scopeId || matchesScope(latestRunFile, scopeId) || objectiveIds.has(latestRunFile.objectiveId))
        ? latestRunFile
        : scopedRuns[0] ?? null
    };
  }

  async migrateLegacyWorkspace(workspacePath: string): Promise<LegacyMigrationResult> {
    await this.ensureLayout(workspacePath);
    const paths = this.buildPaths(workspacePath);
    const migrationMarkerPath = path.join(paths.legacyV2Dir, "migration.json");

    if (await pathExists(migrationMarkerPath)) {
      const existing = await this.records.readJson<LegacyMigrationResult>(migrationMarkerPath);
      return existing ?? { migrated: true };
    }

    const legacySeed = await this.readLegacySeed(workspacePath);
    const hasLegacyRecords = Boolean(
      legacySeed.session || legacySeed.checkpoint || legacySeed.decision || legacySeed.run || legacySeed.threadTitle
    );
    const currentState = await this.readState(workspacePath);

    if (!hasLegacyRecords) {
      await this.records.writeJson(migrationMarkerPath, { migrated: false });
      return { migrated: false };
    }

    let objective = currentState.latestObjective;
    let run = currentState.latestRun;

    if (!objective) {
      const now = new Date().toISOString();
      const objectiveAllocation = await this.allocateObjective(workspacePath);
      const branchAllocation = await this.allocateBranch(workspacePath);
      const hypothesisAllocation = await this.allocateHypothesis(workspacePath);
      const runAllocation = await this.allocateRun(workspacePath);
      const objectiveText =
        legacySeed.session?.displayObjective?.trim() ||
        legacySeed.session?.objective?.trim() ||
        legacySeed.threadTitle ||
        DEFAULT_PROJECT_RESEARCH_GOAL;
      const objectiveId = objectiveAllocation.id;

      objective = {
        id: objectiveId,
        threadId: objectiveId,
        automationSessionId: legacySeed.session?.id,
        title: objectiveText,
        objective: objectiveText,
        summary: legacySeed.checkpoint?.summary || legacySeed.decision?.summary || legacySeed.run?.finalMessage || objectiveText,
        status: legacySeed.session?.status === "running" ? "paused" : "pending",
        successCriteria: [
          "Advance the highest-value branch with bounded evidence-generating work.",
          "Capture findings, evaluations, and reproducible execution artifacts."
        ],
        activeBranchId: branchAllocation.id,
        activeRunId: runAllocation.id,
        sourceIds: [],
        branchIds: [branchAllocation.id],
        createdAt: now,
        updatedAt: now
      };
      const branch: ResearchBranchRecord = {
        id: branchAllocation.id,
        objectiveId,
        threadId: objectiveId,
        title: "Primary branch",
        hypothesis: objectiveText,
        status: "active",
        score: 0.6,
        evidenceIds: [],
        sourceIds: [],
        findingIds: [],
        workItemIds: [],
        createdAt: now,
        updatedAt: now,
        lastUpdatedAt: now
      };
      const hypothesis: ResearchHypothesisRecord = {
        id: hypothesisAllocation.id,
        objectiveId,
        branchId: branch.id,
        threadId: objectiveId,
        statement: objectiveText,
        status: "open",
        confidence: 0.5,
        evidenceIds: [],
        createdAt: now,
        updatedAt: now
      };
      run = {
        id: runAllocation.id,
        objectiveId,
        threadId: objectiveId,
        status: legacySeed.session?.status === "running" ? "paused" : "pending",
        blockedReason: undefined,
        slotBudget: {
          codexSlots: 1,
          oracleSlots: 2,
          maxTotalWorkItems: Math.max(legacySeed.session?.budget.maxSteps ?? 12, 1),
          completedWorkItems: 0
        },
        activeWorkItemIds: [],
        oracleSessionSlugs: [],
        worktreeLeases: [],
        createdAt: now,
        updatedAt: now
      };

      await this.writeObjective(workspacePath, objective);
      await this.writeBranch(workspacePath, branch);
      await this.writeHypothesis(workspacePath, hypothesis);
      await this.writeRun(workspacePath, run);

      if (legacySeed.decision) {
        await this.importLegacyDecision(workspacePath, objective, branch, legacySeed.decision);
      }

      if (legacySeed.run) {
        await this.importLegacyRun(workspacePath, objective, branch, legacySeed.run);
      }

      if (legacySeed.checkpoint) {
        const evaluationAllocation = await this.allocateEvaluation(workspacePath);
        const nowEvaluation = new Date().toISOString();
        await this.writeEvaluation(workspacePath, {
          id: evaluationAllocation.id,
          objectiveId,
          branchId: branch.id,
          threadId: objectiveId,
          workItemId: "",
          verdict: legacySeed.checkpoint.status === "approved" ? "continue" : "pivot",
          scoreDelta: legacySeed.checkpoint.status === "approved" ? 0.05 : -0.02,
          summary: legacySeed.checkpoint.summary,
          rationale: legacySeed.checkpoint.whatChanged.join(" ") || legacySeed.checkpoint.summary,
          followupPrompt: legacySeed.checkpoint.nextActions[0],
          createdAt: nowEvaluation,
          updatedAt: nowEvaluation
        });
      }

      await this.appendEvent(workspacePath, {
        id: `${objective.id}-legacy-migration`,
        threadId: objective.id,
        objectiveId: objective.id,
        branchId: objective.activeBranchId,
        type: "legacy.migrated",
        payload: {
          automationSessionId: legacySeed.session?.id ?? null,
          decisionId: legacySeed.decision?.id ?? null,
          runId: legacySeed.run?.id ?? null
        },
        createdAt: now
      });
    }

    await this.archiveLegacyDirectories(workspacePath);
    const result: LegacyMigrationResult = {
      migrated: true,
      objectiveId: objective?.id,
      runId: run?.id
    };
    await this.records.writeJson(migrationMarkerPath, result);
    return result;
  }

  private async readLegacySeed(workspacePath: string): Promise<LegacySeed> {
    const paths = this.buildPaths(workspacePath);
    const [sessions, checkpoints, decisions, runs, threads] = await Promise.all([
      this.records.readRecordDirectory<AutomationSessionRecord>(paths.automationSessionsDir),
      this.records.readRecordDirectory<AutomationCheckpointRecord>(paths.automationCheckpointsDir),
      this.records.readRecordDirectory<DecisionRecord>(paths.decisionsDir),
      this.records.readRecordDirectory<RunRecord>(paths.runsDir),
      this.records.readRecordDirectory<{ title?: string }>(paths.threadsDir)
    ]);

    return {
      session: [...sessions].sort(sortByUpdatedAt)[0] ?? null,
      checkpoint: [...checkpoints].sort(sortByUpdatedAt)[0] ?? null,
      decision: [...decisions].sort(sortByCreatedAt)[0] ?? null,
      run: [...runs].sort(sortByRunRecency)[0] ?? null,
      threadTitle: threads[0]?.title?.trim() || ""
    };
  }

  private async archiveLegacyDirectories(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    await mkdir(paths.legacyV2Dir, { recursive: true });

    for (const name of LEGACY_DIR_NAMES) {
      const source = path.join(paths.root, name);
      const destination = path.join(paths.legacyV2Dir, name);

      if (!(await pathExists(source))) {
        continue;
      }

      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      await rename(source, destination).catch(() => undefined);
    }
  }

  private async importLegacyDecision(
    workspacePath: string,
    objective: ResearchObjectiveRecord,
    branch: ResearchBranchRecord,
    decision: DecisionRecord
  ) {
    const sourceAllocation = await this.allocateSource(workspacePath);
    const findingAllocation = await this.allocateFinding(workspacePath);
    const now = new Date().toISOString();
    const source: ResearchSourceRecord = {
      id: sourceAllocation.id,
      objectiveId: objective.id,
      threadId: objective.threadId,
      branchId: branch.id,
      kind: "decision",
      title: decision.displayPrompt ?? decision.prompt,
      locator: decision.id,
      summary: decision.summary,
      metadata: {
        model: decision.model,
        engine: decision.engine
      },
      createdAt: decision.createdAt,
      updatedAt: now
    };
    const finding: ResearchFindingRecord = {
      id: findingAllocation.id,
      objectiveId: objective.id,
      threadId: objective.threadId,
      branchId: branch.id,
      sourceId: source.id,
      kind: "claim",
      summary: decision.summary,
      detail: decision.rationale,
      evidence: [decision.id, ...(decision.handoff?.openQuestions ?? []), ...(decision.handoff?.runActions ?? [])],
      createdAt: decision.createdAt,
      updatedAt: now
    };

    await this.writeSource(workspacePath, source);
    await this.writeFinding(workspacePath, finding);
    await this.writeObjective(workspacePath, {
      ...objective,
      sourceIds: Array.from(new Set([...objective.sourceIds, source.id])),
      updatedAt: now
    });
    await this.writeBranch(workspacePath, {
      ...branch,
      sourceIds: Array.from(new Set([...branch.sourceIds, source.id])),
      findingIds: Array.from(new Set([...branch.findingIds, finding.id])),
      evidenceIds: Array.from(new Set([...branch.evidenceIds, finding.id])),
      updatedAt: now,
      lastUpdatedAt: now
    });
  }

  private async importLegacyRun(
    workspacePath: string,
    objective: ResearchObjectiveRecord,
    branch: ResearchBranchRecord,
    run: RunRecord
  ) {
    const sourceAllocation = await this.allocateSource(workspacePath);
    const findingAllocation = await this.allocateFinding(workspacePath);
    const now = new Date().toISOString();
    const source: ResearchSourceRecord = {
      id: sourceAllocation.id,
      objectiveId: objective.id,
      threadId: objective.threadId,
      branchId: branch.id,
      kind: "run",
      title: run.displayPrompt ?? run.prompt,
      locator: run.id,
      summary: run.handoff?.machineSummary ?? run.finalMessage,
      metadata: {
        status: run.status,
        model: run.model
      },
      createdAt: run.createdAt,
      updatedAt: now
    };
    const finding: ResearchFindingRecord = {
      id: findingAllocation.id,
      objectiveId: objective.id,
      threadId: objective.threadId,
      branchId: branch.id,
      sourceId: source.id,
      kind: "observation",
      summary: run.handoff?.machineSummary ?? run.finalMessage,
      detail: run.handoff?.summary ?? undefined,
      evidence: [...(run.changedFiles ?? []), ...(run.handoff?.risks ?? [])],
      createdAt: run.createdAt,
      updatedAt: now
    };

    await this.writeSource(workspacePath, source);
    await this.writeFinding(workspacePath, finding);
    await this.writeObjective(workspacePath, {
      ...objective,
      sourceIds: Array.from(new Set([...objective.sourceIds, source.id])),
      updatedAt: now
    });
    await this.writeBranch(workspacePath, {
      ...branch,
      sourceIds: Array.from(new Set([...branch.sourceIds, source.id])),
      findingIds: Array.from(new Set([...branch.findingIds, finding.id])),
      evidenceIds: Array.from(new Set([...branch.evidenceIds, finding.id])),
      updatedAt: now,
      lastUpdatedAt: now
    });
  }

  private async allocateRecord(
    workspacePath: string,
    kind: "objective" | "branch" | "source" | "finding" | "hypothesis" | "work-item" | "evaluation" | "projection" | "run"
  ) {
    const paths = this.buildPaths(workspacePath);
    const resolved = {
      objective: [paths.researchObjectivesDir, "RO"],
      branch: [paths.researchBranchesDir, "RB"],
      source: [paths.researchSourcesDir, "RS"],
      finding: [paths.researchFindingsDir, "RF"],
      hypothesis: [paths.researchHypothesesDir, "RH"],
      "work-item": [paths.researchWorkItemsDir, "RW"],
      evaluation: [paths.researchEvaluationsDir, "RE"],
      projection: [paths.researchProjectionsDir, "RP"],
      run: [paths.researchRunsDir, "RR"]
    } as const;
    const [directory, prefix] = resolved[kind];
    const id = await this.records.nextId(directory, prefix);
    return {
      id,
      jsonPath: path.join(directory, `${id}.json`)
    };
  }

  private async writeScopedRecord<T>(workspacePath: string, directory: string, id: string, record: T) {
    await this.ensureLayout(workspacePath);
    await this.records.writeJson(path.join(directory, `${id}.json`), record);
  }
}

function matchesScope(record: { id?: string; objectiveId?: string; threadId?: string }, scopeId?: string | null) {
  if (!scopeId) {
    return true;
  }

  return record.id === scopeId || record.objectiveId === scopeId || record.threadId === scopeId;
}

function sortByUpdatedAt<T extends { updatedAt: string }>(left: T, right: T) {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    ("id" in right && "id" in left ? String((right as { id?: string }).id).localeCompare(String((left as { id?: string }).id)) : 0)
  );
}

function sortByCreatedAt<T extends { createdAt: string }>(left: T, right: T) {
  return (
    right.createdAt.localeCompare(left.createdAt) ||
    ("id" in right && "id" in left ? String((right as { id?: string }).id).localeCompare(String((left as { id?: string }).id)) : 0)
  );
}

function sortByRunRecency(left: RunRecord, right: RunRecord) {
  return (
    (right.endedAt ?? right.startedAt ?? right.createdAt).localeCompare(left.endedAt ?? left.startedAt ?? left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}
