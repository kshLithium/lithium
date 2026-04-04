import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AttachmentKind,
  AttachmentRecord,
  EvaluationRecord,
  ExperimentMetricExpectation,
  ExperimentResultRecord,
  ExperimentSpecRecord,
  LithiumHandoff,
  MetricRecord,
  ResearchBranchRecord,
  ResearchFindingRecord,
  ResearchObjectiveRecord,
  ResearchProjectionRecord,
  ResearchRunRecord,
  ResearchSourceKind,
  ResearchSourceRecord,
  ResearchWorkItemKind,
  ResearchWorkItemRecord,
  WorkerRunRecord,
  SourceArtifactRecord
} from "../../shared/types";
import { buildProjectPaths } from "../services/workspace-layout";
import { ArtifactService } from "./artifact-service";
import { ChatProjectionService } from "./chat-projection-service";
import type { ResearchStateSnapshot } from "./state-store";
import { ResearchStateStore } from "./state-store";
import { createBuildPayload, createEvaluatePayload, createExperimentPayload, createTaskRecord, isTerminalTaskStatus, normalizeTaskContract } from "./task-contracts";
import { WorkerGateway, type WorkerDispatchResult } from "./worker-gateway";

export class ResearchResultProcessor {
  private readonly projectionService: ChatProjectionService;

  constructor(
    private readonly deps: {
      stateStore: ResearchStateStore;
      artifactService: ArtifactService;
      workerGateway: WorkerGateway;
      chatProjectionService?: ChatProjectionService;
    }
  ) {
    this.projectionService = deps.chatProjectionService ?? new ChatProjectionService();
  }

  async recoverInterruptedRuns(workspacePath: string) {
    const state = await this.deps.stateStore.readState(workspacePath);
    const now = new Date().toISOString();

    for (const run of state.runs.filter((entry) => entry.status === "active" && entry.activeWorkItemIds.length > 0)) {
      await this.deps.stateStore.writeRun(workspacePath, {
        ...run,
        status: "blocked",
        blockedReason: "The application restarted while work was still in flight.",
        activeWorkItemIds: [],
        oracleSessionSlugs: [],
        updatedAt: now
      });
      await this.deps.stateStore.appendActivity(workspacePath, `run blocked ${run.id}: interrupted process recovery`);
    }
  }

  async materializeProjection(workspacePath: string, objectiveId: string) {
    const state = await this.deps.stateStore.readState(workspacePath, objectiveId);
    const objective = state.latestObjective;
    if (!objective) {
      return null;
    }

    const projectionId = (await this.deps.stateStore.allocateProjection(workspacePath)).id;
    const projection = this.projectionService.buildProjection({
      projectionId,
      objective,
      branches: state.branches,
      findings: state.findings,
      workItems: state.workItems,
      evaluations: state.evaluations,
      run: state.runs.find((entry) => entry.id === objective.activeRunId) ?? state.latestRun
    });
    await this.deps.stateStore.writeProjection(workspacePath, projection);
    return projection;
  }

  async processCompletion(input: {
    workspacePath: string;
    objectiveId: string;
    runId: string;
    taskId: string;
    result: WorkerDispatchResult;
  }) {
    const now = new Date().toISOString();
    const state = await this.deps.stateStore.readState(input.workspacePath, input.objectiveId);
    const objective = state.latestObjective;
    const run = state.runs.find((entry) => entry.id === input.runId) ?? null;
    const task = state.workItems.find((entry) => entry.id === input.taskId) ?? null;

    if (!objective || !run || !task) {
      return;
    }

    if (run.status === "failed" && run.stopReason === "Run stopped by the user.") {
      await this.discardLateCompletion({
        workspacePath: input.workspacePath,
        objective,
        run,
        task
      });
      await this.materializeProjection(input.workspacePath, objective.id);
      return;
    }

    const branch = input.result.branch ?? state.branches.find((entry) => entry.id === task.branchId) ?? null;
    if (input.result.branch) {
      await this.deps.stateStore.writeBranch(input.workspacePath, input.result.branch);
    }
    if (input.result.runRecord) {
      await this.persistWorkerRun(input.workspacePath, objective.id, task.branchId, input.result.runRecord);
    }

    const completedTask: ResearchWorkItemRecord = {
      ...task,
      ...normalizeTaskContract(task.kind, task.executor, task.isolation),
      status: input.result.status,
      runId: input.result.runId ?? task.runId,
      oracleSessionSlug: input.result.oracleSessionSlug ?? task.oracleSessionSlug,
      worktreePath: input.result.worktreePath ?? task.worktreePath,
      patchArtifactPath: input.result.patchArtifactPath ?? task.patchArtifactPath,
      completedAt: now,
      updatedAt: now
    };
    await this.deps.stateStore.writeWorkItem(input.workspacePath, completedTask);
    await this.deps.stateStore.appendActivity(
      input.workspacePath,
      `task ${completedTask.id} ${completedTask.status}: ${completedTask.title}`
    );

    const runAfterCompletion = await this.clearTaskFromRun(input.workspacePath, run, completedTask, input.result);

    switch (completedTask.kind) {
      case "plan":
        await this.applyPlannerHandoff({
          workspacePath: input.workspacePath,
          objective,
          run: runAfterCompletion,
          task: completedTask,
          handoff: input.result.handoff
        });
        break;
      case "discover":
        await this.applyDiscoverOutcome({
          workspacePath: input.workspacePath,
          objective,
          branch,
          task: completedTask,
          discoveredSources: input.result.discoveredSources ?? []
        });
        break;
      case "read_synthesize":
        await this.applySynthesisOutcome({
          workspacePath: input.workspacePath,
          objective,
          branch,
          task: completedTask,
          synthesizedFindings: input.result.synthesizedFindings ?? []
        });
        break;
      case "build_change":
        await this.applyBuildOutcome({
          workspacePath: input.workspacePath,
          objective,
          branch,
          task: completedTask
        });
        break;
      case "run_experiment":
        await this.applyExperimentOutcome({
          workspacePath: input.workspacePath,
          objective,
          branch,
          task: completedTask,
          result: input.result
        });
        break;
      case "evaluate_branch":
        await this.applyEvaluationOutcome({
          workspacePath: input.workspacePath,
          objective,
          branch,
          task: completedTask,
          result: input.result
        });
        break;
      case "arbitrate_branch":
        await this.applyArbiterOutcome({
          workspacePath: input.workspacePath,
          objective,
          run: runAfterCompletion,
          branch,
          task: completedTask
        });
        break;
      default:
        break;
    }

    await this.materializeProjection(input.workspacePath, objective.id);
  }

  async importAttachments(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    filePaths: string[];
  }) {
    const paths = buildProjectPaths(input.workspacePath);
    await mkdir(paths.workspaceAttachmentsDir, { recursive: true });
    const createdAttachments: AttachmentRecord[] = [];

    for (const filePath of input.filePaths) {
      const attachmentId = (await this.deps.stateStore.allocateAttachment(input.workspacePath)).id;
      const fileName = path.basename(filePath);
      const relativePath = await copyAttachmentIntoWorkspace(
        input.workspacePath,
        paths.workspaceAttachmentsDir,
        attachmentId,
        filePath
      );
      const destinationPath = path.join(input.workspacePath, relativePath);
      const stat = await import("node:fs/promises").then((fs) => fs.stat(destinationPath));
      const excerpt = await extractAttachmentExcerpt(destinationPath);
      const now = new Date().toISOString();
      const attachment: AttachmentRecord = {
        id: attachmentId,
        objectiveId: input.objective.id,
        name: fileName,
        relativePath,
        sourcePath: filePath,
        kind: classifyAttachment(fileName, excerpt),
        sizeBytes: stat.size,
        excerpt,
        importedAt: now,
        updatedAt: now
      };
      await this.deps.stateStore.writeAttachment(input.workspacePath, attachment);

      const sourceId = (await this.deps.stateStore.allocateSource(input.workspacePath)).id;
      const bytes = await import("node:fs/promises").then((fs) => fs.readFile(destinationPath));
      const artifact = await this.deps.artifactService.captureSourceArtifact({
        workspacePath: input.workspacePath,
        objectiveId: input.objective.id,
        sourceId,
        fileName,
        body: bytes
      });
      const source: ResearchSourceRecord = {
        id: sourceId,
        objectiveId: input.objective.id,
        branchId: input.branch?.id,
        kind: "attachment",
        title: fileName,
        locator: destinationPath,
        provenance: `attachment:${attachment.id}`,
        summary: excerpt || `Imported attachment ${fileName}`,
        excerpt: excerpt || undefined,
        attachmentId: attachment.id,
        artifactPath: artifact.path,
        artifactHash: artifact.hash,
        readAt: now,
        sourceArtifactId: artifact.id,
        createdAt: now,
        updatedAt: now
      };
      await this.deps.stateStore.writeSource(input.workspacePath, source);
      await this.linkSourceToObjectiveAndBranch(input.workspacePath, input.objective, input.branch, source.id, now);
      createdAttachments.push(attachment);
    }

    return createdAttachments;
  }

  private async applyPlannerHandoff(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    run: ResearchRunRecord;
    task: ResearchWorkItemRecord;
    handoff?: LithiumHandoff;
  }) {
    const now = new Date().toISOString();
    const handoff = input.handoff;
    const state = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const branchesByTitle = new Map(state.branches.map((branch) => [branch.title.trim().toLowerCase(), branch]));
    const branchesById = new Map(state.branches.map((branch) => [branch.id, branch]));
    let objective = input.objective;

    for (const proposedBranch of handoff?.proposedBranches ?? []) {
      const title = proposedBranch.title.trim();
      const hypothesis = proposedBranch.hypothesis.trim();
      if (!title || !hypothesis || branchesByTitle.has(title.toLowerCase())) {
        continue;
      }

      const branchId = (await this.deps.stateStore.allocateBranch(input.workspacePath)).id;
      const branch: ResearchBranchRecord = {
        id: branchId,
        objectiveId: input.objective.id,
        title,
        hypothesis,
        status: "candidate",
        score: 0.55,
        evidenceIds: [],
        sourceIds: [],
        findingIds: [],
        workItemIds: [],
        createdAt: now,
        updatedAt: now,
        lastUpdatedAt: now
      };
      await this.deps.stateStore.writeBranch(input.workspacePath, branch);
      branchesByTitle.set(title.toLowerCase(), branch);
      branchesById.set(branch.id, branch);
      objective = {
        ...objective,
        branchIds: Array.from(new Set([...objective.branchIds, branch.id])),
        updatedAt: now
      };
    }

    for (const suggested of handoff?.researchWorkItems ?? []) {
      const branch =
        (suggested.branchTitle && branchesByTitle.get(suggested.branchTitle.trim().toLowerCase())) ??
        branchesById.get(objective.activeBranchId ?? "") ??
        [...branchesById.values()].sort((left, right) => right.score - left.score)[0] ??
        null;
      if (!branch) {
        continue;
      }

      const normalized = normalizeTaskContract(suggested.kind, suggested.executor, suggested.isolation);
      const duplicate = state.workItems.some(
        (task) =>
          task.branchId === branch.id &&
          task.status === "pending" &&
          task.title.trim().toLowerCase() === suggested.title.trim().toLowerCase()
      );
      if (duplicate) {
        continue;
      }

      const taskId = (await this.deps.stateStore.allocateWorkItem(input.workspacePath)).id;
      const workItem = createTaskRecord({
        id: taskId,
        objectiveId: input.objective.id,
        branchId: branch.id,
        title: suggested.title.trim(),
        prompt: suggested.prompt.trim(),
        kind: normalized.kind,
        executor: normalized.executor,
        isolation: normalized.isolation,
        payload: buildPayloadForSuggestedTask(normalized.kind, branch.id, suggested.prompt.trim(), objective.successCriteria),
        now
      });
      await this.deps.stateStore.writeWorkItem(input.workspacePath, workItem);
      await this.deps.stateStore.writeBranch(input.workspacePath, {
        ...branch,
        workItemIds: Array.from(new Set([...branch.workItemIds, workItem.id])),
        nextWorkItemId: branch.nextWorkItemId ?? workItem.id,
        updatedAt: now,
        lastUpdatedAt: now
      });
    }

    const refreshed = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const bestBranch =
      refreshed.branches.find((branch) => branch.id === objective.activeBranchId) ??
      [...refreshed.branches].sort((left, right) => right.score - left.score)[0] ??
      null;
    const completedCount = refreshed.workItems.filter((task) => isTerminalTaskStatus(task.status)).length;
    const topScore = [...refreshed.branches].sort((left, right) => right.score - left.score)[0]?.score ?? 0;

    await this.deps.stateStore.writeObjective(input.workspacePath, {
      ...objective,
      activeBranchId: bestBranch?.id ?? objective.activeBranchId,
      summary: handoff?.summary?.trim() || objective.summary,
      updatedAt: now
    });
    await this.deps.stateStore.writeRun(input.workspacePath, {
      ...input.run,
      lastPlanTaskId: input.task.id,
      lastPlanAt: now,
      lastPlanSourceCount: refreshed.sources.length,
      lastPlanCompletedCount: completedCount,
      lastPlanBranchScore: topScore,
      updatedAt: now
    });
  }

  private async applyDiscoverOutcome(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    task: ResearchWorkItemRecord;
    discoveredSources: NonNullable<WorkerDispatchResult["discoveredSources"]>;
  }) {
    if (!input.branch || input.discoveredSources.length === 0) {
      return;
    }

    const state = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const existingByLocator = new Map(state.sources.map((source) => [source.locator, source]));
    const now = new Date().toISOString();
    const sourceIds: string[] = [];

    for (const discovered of input.discoveredSources) {
      const existing = existingByLocator.get(discovered.locator);
      if (existing) {
        sourceIds.push(existing.id);
        continue;
      }

      const sourceId = (await this.deps.stateStore.allocateSource(input.workspacePath)).id;
      let source: ResearchSourceRecord = {
        id: sourceId,
        objectiveId: input.objective.id,
        branchId: input.branch.id,
        kind: discovered.kind,
        title: discovered.title,
        locator: discovered.locator,
        provenance: input.task.oracleSessionSlug
          ? `oracle-session:${input.task.oracleSessionSlug}`
          : `work-item:${input.task.id}`,
        summary: discovered.summary,
        excerpt: discovered.excerpt,
        oracleSessionSlug: input.task.oracleSessionSlug,
        readAt: now,
        createdAt: now,
        updatedAt: now
      };
      const artifact = await this.deps.artifactService.fetchRemoteSourceArtifact({
        workspacePath: input.workspacePath,
        objectiveId: input.objective.id,
        sourceId,
        locator: discovered.locator
      });
      if (artifact) {
        source = {
          ...source,
          artifactPath: artifact.path,
          artifactHash: artifact.hash,
          sourceArtifactId: artifact.id
        };
      }
      await this.deps.stateStore.writeSource(input.workspacePath, source);
      await this.linkSourceToObjectiveAndBranch(input.workspacePath, input.objective, input.branch, source.id, now);
      sourceIds.push(source.id);
    }

    if (sourceIds.length === 0) {
      return;
    }

    await this.enqueueTask({
      workspacePath: input.workspacePath,
      objective: input.objective,
      branch: input.branch,
      title: `Read and synthesize ${input.branch.title} evidence`,
      prompt: `Read the newly discovered sources for "${input.branch.title}" and extract claims with citations.`,
      kind: "read_synthesize",
      dependsOnIds: [input.task.id],
      sourceIds,
      payload: {
        branchId: input.branch.id,
        sourceIds,
        questions: [input.task.prompt]
      }
    });
  }

  private async applySynthesisOutcome(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    task: ResearchWorkItemRecord;
    synthesizedFindings: NonNullable<WorkerDispatchResult["synthesizedFindings"]>;
  }) {
    if (!input.branch || input.synthesizedFindings.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const sources = await this.deps.stateStore.listSources(input.workspacePath);
    const findings: ResearchFindingRecord[] = [];

    for (const synthesized of input.synthesizedFindings) {
      const source = sources.find((entry) => entry.locator === synthesized.sourceLocator);
      const findingId = (await this.deps.stateStore.allocateFinding(input.workspacePath)).id;
      const finding: ResearchFindingRecord = {
        id: findingId,
        objectiveId: input.objective.id,
        branchId: input.branch.id,
        sourceId: source?.id,
        sourceArtifactId: source?.sourceArtifactId,
        kind: "evidence",
        summary: synthesized.summary,
        detail: synthesized.detail,
        evidence: [synthesized.citationText ?? synthesized.sourceLocator].filter(Boolean),
        createdAt: now,
        updatedAt: now
      };
      await this.deps.stateStore.writeFinding(input.workspacePath, finding);
      findings.push(finding);
    }

    if (findings.length > 0) {
      await this.deps.stateStore.writeBranch(input.workspacePath, {
        ...input.branch,
        findingIds: Array.from(new Set([...input.branch.findingIds, ...findings.map((finding) => finding.id)])),
        evidenceIds: Array.from(new Set([...input.branch.evidenceIds, ...findings.map((finding) => finding.id)])),
        updatedAt: now,
        lastUpdatedAt: now
      });
    }

    await this.enqueueTask({
      workspacePath: input.workspacePath,
      objective: input.objective,
      branch: input.branch,
      title: `Evaluate ${input.branch.title} evidence`,
      prompt: `Evaluate whether the latest synthesized evidence improves confidence in "${input.branch.title}".`,
      kind: "evaluate_branch",
      dependsOnIds: [input.task.id],
      payload: createEvaluatePayload({
        branchId: input.branch.id,
        focus: input.task.prompt
      })
    });
  }

  private async applyBuildOutcome(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    task: ResearchWorkItemRecord;
  }) {
    if (!input.branch) {
      return;
    }

    const payload = input.task.payload;
    const buildPayload = payload && "verificationCommands" in payload ? payload : null;
    const verificationCommands = buildPayload?.verificationCommands ?? [];

    if (input.task.status === "completed" && verificationCommands.length > 0) {
      await this.enqueueTask({
        workspacePath: input.workspacePath,
        objective: input.objective,
        branch: input.branch,
        title: `Run verification for ${input.branch.title}`,
        prompt: verificationCommands.join("\n"),
        kind: "run_experiment",
        dependsOnIds: [input.task.id],
        payload: createExperimentPayload({
          branchId: input.branch.id,
          commands: verificationCommands,
          expectedMetrics: []
        })
      });
      return;
    }

    await this.enqueueTask({
      workspacePath: input.workspacePath,
      objective: input.objective,
      branch: input.branch,
      title: `Evaluate ${input.branch.title} build result`,
      prompt: `Evaluate the latest code change for "${input.branch.title}".`,
      kind: "evaluate_branch",
      dependsOnIds: [input.task.id],
      payload: createEvaluatePayload({
        branchId: input.branch.id,
        focus: input.task.prompt
      })
    });
  }

  private async applyExperimentOutcome(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    task: ResearchWorkItemRecord;
    result: WorkerDispatchResult;
  }) {
    if (!input.branch || !input.result.experimentManifest) {
      return;
    }

    const now = new Date().toISOString();
    const specId = (await this.deps.stateStore.allocateExperimentSpec(input.workspacePath)).id;
    const spec: ExperimentSpecRecord = {
      id: specId,
      objectiveId: input.objective.id,
      branchId: input.branch.id,
      workItemId: input.task.id,
      title: input.task.title,
      prompt: input.task.prompt,
      executor: "experimenter",
      isolation: input.task.isolation ?? "worktree",
      worktreePath: input.result.worktreePath,
      createdAt: now,
      updatedAt: now
    };
    await this.deps.stateStore.writeExperimentSpec(input.workspacePath, spec);
    const experimentId = (await this.deps.stateStore.allocateExperimentResult(input.workspacePath)).id;
    const manifestPath = await this.deps.artifactService.writeExperimentManifest(
      input.workspacePath,
      experimentId,
      input.result.experimentManifest
    );
    const experiment: ExperimentResultRecord = {
      id: experimentId,
      objectiveId: input.objective.id,
      branchId: input.branch.id,
      workItemId: input.task.id,
      experimentSpecId: spec.id,
      runId: input.result.runId,
      status: input.result.experimentManifest.status,
      summary: input.result.summary,
      command: input.result.experimentManifest.commands.join(" && "),
      stdoutPath: input.result.experimentManifest.stdoutPath,
      stderrPath: input.result.experimentManifest.stderrPath,
      outputPath: input.result.experimentManifest.outputPath,
      worktreePath: input.result.worktreePath,
      changedFiles: input.result.changedFiles,
      patchArtifactPath: input.result.patchArtifactPath,
      manifestPath,
      manifest: input.result.experimentManifest,
      createdAt: now,
      updatedAt: now
    };
    await this.deps.stateStore.writeExperimentResult(input.workspacePath, experiment);

    for (const metric of input.result.experimentManifest.metrics) {
      const metricId = (await this.deps.stateStore.allocateMetric(input.workspacePath)).id;
      const record: MetricRecord = {
        id: metricId,
        objectiveId: input.objective.id,
        branchId: input.branch.id,
        workItemId: input.task.id,
        experimentResultId: experiment.id,
        name: metric.name,
        value: metric.value,
        unit: metric.unit,
        createdAt: now,
        updatedAt: now
      };
      await this.deps.stateStore.writeMetric(input.workspacePath, record);
    }

    await this.enqueueTask({
      workspacePath: input.workspacePath,
      objective: input.objective,
      branch: input.branch,
      title: `Evaluate ${input.branch.title} experiment`,
      prompt: `Evaluate the latest experiment metrics for "${input.branch.title}".`,
      kind: "evaluate_branch",
      dependsOnIds: [input.task.id],
      payload: createEvaluatePayload({
        branchId: input.branch.id,
        focus: input.task.prompt
      })
    });
  }

  private async applyEvaluationOutcome(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    task: ResearchWorkItemRecord;
    result: WorkerDispatchResult;
  }) {
    if (!input.branch) {
      return;
    }

    const now = new Date().toISOString();
    const decision = input.result.evaluatorDecision ?? fallbackEvaluationDecision(input.result.summary);
    const evaluationId = (await this.deps.stateStore.allocateEvaluation(input.workspacePath)).id;
    const evaluation: EvaluationRecord = {
      id: evaluationId,
      objectiveId: input.objective.id,
      branchId: input.branch.id,
      workItemId: input.task.id,
      verdict: input.result.status === "failed" ? "kill" : decision.verdict,
      scoreDelta: input.result.status === "failed" ? Math.min(decision.scoreDelta, -0.1) : decision.scoreDelta,
      summary: decision.summary,
      rationale: decision.rationale,
      followupPrompt: decision.followupPrompt,
      createdAt: now,
      updatedAt: now
    };
    await this.deps.stateStore.writeEvaluation(input.workspacePath, evaluation);
    await this.deps.stateStore.writeWorkItem(input.workspacePath, {
      ...input.task,
      resultEvaluationId: evaluation.id,
      updatedAt: now
    });

    const updatedBranch: ResearchBranchRecord = {
      ...input.branch,
      score: roundScore(input.branch.score + evaluation.scoreDelta),
      status: deriveBranchStatus(input.branch, evaluation.verdict, input.task.status),
      lastFailureReason: input.task.status === "failed" ? input.result.summary : input.branch.lastFailureReason,
      updatedAt: now,
      lastUpdatedAt: now
    };
    await this.deps.stateStore.writeBranch(input.workspacePath, updatedBranch);
    await this.updateHypothesisFromEvaluation(input.workspacePath, updatedBranch, evaluation);

    const refreshed = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const topBranch = selectTopBranch(refreshed.branches) ?? updatedBranch;
    await this.deps.stateStore.writeObjective(input.workspacePath, {
      ...input.objective,
      activeBranchId: topBranch.id,
      summary: evaluation.summary,
      status: evaluation.verdict === "complete" ? "completed" : input.objective.status,
      updatedAt: now
    });

    await this.enqueueTask({
      workspacePath: input.workspacePath,
      objective: {
        ...input.objective,
        activeBranchId: topBranch.id
      },
      branch: updatedBranch,
      title: `Arbitrate ${updatedBranch.title}`,
      prompt: `Apply the promotion and branch policy for "${updatedBranch.title}".`,
      kind: "arbitrate_branch",
      dependsOnIds: [input.task.id],
      payload: {
        branchId: updatedBranch.id,
        evaluationId: evaluation.id,
        candidateTaskId: input.task.dependsOnIds.at(-1)
      }
    });
  }

  private async applyArbiterOutcome(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    run: ResearchRunRecord;
    branch: ResearchBranchRecord | null;
    task: ResearchWorkItemRecord;
  }) {
    if (!input.branch || !input.task.payload || !("evaluationId" in input.task.payload)) {
      return;
    }

    const payload = input.task.payload;
    const state = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const evaluation = state.evaluations.find((entry) => entry.id === payload.evaluationId) ?? null;
    if (!evaluation) {
      return;
    }

    const now = new Date().toISOString();
    let branch = input.branch;
    let objective = input.objective;
    let run = input.run;

    if (payload.candidateTaskId) {
      const candidateTask = state.workItems.find((entry) => entry.id === payload.candidateTaskId) ?? null;
      if (candidateTask) {
        const promotion = await this.deps.workerGateway.promotePatchArtifact({
          workspacePath: input.workspacePath,
          workItem: candidateTask,
          evaluation,
          branch
        });
        if (promotion.promotionStatus !== "skipped") {
          await this.deps.stateStore.writeWorkItem(input.workspacePath, {
            ...candidateTask,
            promotionStatus: promotion.promotionStatus,
            promotionError: promotion.promotionError,
            updatedAt: now
          });
          if (promotion.promotionStatus === "promoted") {
            branch = {
              ...branch,
              promotionHeadCommit: branch.headCommit,
              updatedAt: now,
              lastUpdatedAt: now
            };
          }
        }
      }
    }

    if (evaluation.verdict === "complete") {
      objective = {
        ...objective,
        status: "completed",
        summary: evaluation.summary,
        updatedAt: now
      };
      run = {
        ...run,
        status: "completed",
        stopReason: undefined,
        endedAt: now,
        updatedAt: now
      };
    } else if (evaluation.verdict === "kill") {
      branch = {
        ...branch,
        status: "killed",
        updatedAt: now,
        lastUpdatedAt: now
      };
    } else if (evaluation.verdict === "pivot") {
      branch = {
        ...branch,
        status: "pivoted",
        updatedAt: now,
        lastUpdatedAt: now
      };
    } else {
      branch = {
        ...branch,
        status: branch.status === "completed" ? "completed" : "active",
        updatedAt: now,
        lastUpdatedAt: now
      };
    }

    await this.deps.stateStore.writeBranch(input.workspacePath, branch);
    await this.deps.stateStore.writeObjective(input.workspacePath, objective);
    await this.deps.stateStore.writeRun(input.workspacePath, run);
  }

  private async clearTaskFromRun(
    workspacePath: string,
    run: ResearchRunRecord,
    task: ResearchWorkItemRecord,
    result: WorkerDispatchResult
  ) {
    const now = new Date().toISOString();
    const completedWorkItems = run.slotBudget.completedWorkItems + 1;
    const nextRun: ResearchRunRecord = {
      ...run,
      activeWorkItemIds: run.activeWorkItemIds.filter((id) => id !== task.id),
      oracleSessionSlugs: run.oracleSessionSlugs.filter(
        (slug) => slug !== task.oracleSessionSlug && slug !== result.oracleSessionSlug
      ),
      slotBudget: {
        ...run.slotBudget,
        completedWorkItems
      },
      status:
        run.status === "active" && completedWorkItems >= run.slotBudget.maxTotalWorkItems
          ? "paused"
          : run.status,
      stopReason:
        run.status === "active" && completedWorkItems >= run.slotBudget.maxTotalWorkItems
          ? "Reached the default work item budget for this run."
          : run.stopReason,
      updatedAt: now
    };
    await this.deps.stateStore.writeRun(workspacePath, nextRun);
    return nextRun;
  }

  private async discardLateCompletion(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    run: ResearchRunRecord;
    task: ResearchWorkItemRecord;
  }) {
    const now = new Date().toISOString();
    await this.deps.stateStore.writeWorkItem(input.workspacePath, {
      ...input.task,
      status: input.task.status === "running" ? "cancelled" : input.task.status,
      completedAt: input.task.completedAt ?? now,
      updatedAt: now
    });
    await this.deps.stateStore.appendEvent(input.workspacePath, {
      id: `${input.task.id}-discarded`,
      objectiveId: input.objective.id,
      branchId: input.task.branchId,
      workItemId: input.task.id,
      type: "work-item.discarded",
      payload: {
        runId: input.run.id,
        reason: "Late completion arrived after stop."
      },
      createdAt: now
    });
  }

  private async persistWorkerRun(
    workspacePath: string,
    objectiveId: string,
    branchId: string,
    runRecord: WorkerRunRecord
  ) {
    await this.deps.stateStore.writeWorkerRun(workspacePath, {
      ...runRecord,
      objectiveId,
      branchId,
      updatedAt: runRecord.endedAt ?? runRecord.startedAt
    }, {
      status: runRecord.status,
      kind: "builder-run",
      executor: "builder",
      taskId: runRecord.taskId
    });
  }

  private async linkSourceToObjectiveAndBranch(
    workspacePath: string,
    objective: ResearchObjectiveRecord,
    branch: ResearchBranchRecord | null,
    sourceId: string,
    now: string
  ) {
    await this.deps.stateStore.writeObjective(workspacePath, {
      ...objective,
      sourceIds: Array.from(new Set([...objective.sourceIds, sourceId])),
      updatedAt: now
    });
    if (branch) {
      await this.deps.stateStore.writeBranch(workspacePath, {
        ...branch,
        sourceIds: Array.from(new Set([...branch.sourceIds, sourceId])),
        updatedAt: now,
        lastUpdatedAt: now
      });
    }
  }

  private async enqueueTask(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord;
    title: string;
    prompt: string;
    kind: ResearchWorkItemKind;
    dependsOnIds?: string[];
    sourceIds?: string[];
    payload?: ResearchWorkItemRecord["payload"];
  }) {
    const allocation = await this.deps.stateStore.allocateWorkItem(input.workspacePath);
    const task = createTaskRecord({
      id: allocation.id,
      objectiveId: input.objective.id,
      branchId: input.branch.id,
      title: input.title,
      prompt: input.prompt,
      kind: input.kind,
      dependsOnIds: input.dependsOnIds,
      sourceIds: input.sourceIds,
      payload: input.payload
    });
    await this.deps.stateStore.writeWorkItem(input.workspacePath, task);
    await this.deps.stateStore.writeBranch(input.workspacePath, {
      ...input.branch,
      workItemIds: Array.from(new Set([...input.branch.workItemIds, task.id])),
      nextWorkItemId: input.branch.nextWorkItemId ?? task.id,
      updatedAt: task.updatedAt,
      lastUpdatedAt: task.updatedAt
    });
    return task;
  }

  private async updateHypothesisFromEvaluation(
    workspacePath: string,
    branch: ResearchBranchRecord,
    evaluation: EvaluationRecord
  ) {
    const state = await this.deps.stateStore.readState(workspacePath, branch.objectiveId);
    const hypothesis = state.hypotheses.find((entry) => entry.branchId === branch.id) ?? null;
    if (!hypothesis) {
      return;
    }

    const nextStatus =
      evaluation.verdict === "kill"
        ? "unsupported"
        : evaluation.verdict === "pivot"
        ? "revised"
        : "supported";
    const nextConfidence = Math.max(
      0,
      Math.min(1, roundScore(hypothesis.confidence + evaluation.scoreDelta + (nextStatus === "supported" ? 0.05 : 0)))
    );
    await this.deps.stateStore.writeHypothesis(workspacePath, {
      ...hypothesis,
      status: nextStatus,
      confidence: nextConfidence,
      evidenceIds: Array.from(new Set([...hypothesis.evidenceIds, evaluation.id])),
      lastEvaluationId: evaluation.id,
      updatedAt: new Date().toISOString()
    });
  }
}

function fallbackEvaluationDecision(summary: string) {
  return {
    verdict: "continue" as const,
    scoreDelta: 0,
    summary: summary || "Evaluated the latest result.",
    rationale: "Fallback evaluation was used because no evaluator decision was returned.",
    followupPrompt: undefined
  };
}

function buildPayloadForSuggestedTask(
  kind: ResearchWorkItemKind,
  branchId: string,
  prompt: string,
  successCriteria: string[]
) {
  switch (kind) {
    case "discover":
      return {
        branchId,
        goal: prompt,
        maxResults: 5
      };
    case "read_synthesize":
      return {
        branchId,
        sourceIds: [],
        questions: [prompt]
      };
    case "build_change":
      return createBuildPayload({
        branchId,
        goal: prompt,
        successCriteria
      });
    case "run_experiment":
      return createExperimentPayload({
        branchId,
        commands: [prompt]
      });
    case "evaluate_branch":
      return createEvaluatePayload({
        branchId,
        focus: prompt
      });
    default:
      return undefined;
  }
}

function deriveBranchStatus(
  branch: ResearchBranchRecord,
  verdict: EvaluationRecord["verdict"],
  taskStatus: ResearchWorkItemRecord["status"]
): ResearchBranchRecord["status"] {
  if (verdict === "complete") {
    return "completed";
  }
  if (verdict === "kill") {
    return "killed";
  }
  if (verdict === "pivot" || taskStatus === "cancelled") {
    return "pivoted";
  }
  if (taskStatus === "failed") {
    return "blocked";
  }
  return branch.status === "candidate" ? "active" : branch.status === "completed" ? "completed" : "active";
}

function selectTopBranch(branches: ResearchBranchRecord[]) {
  return [...branches]
    .filter((branch) => branch.status !== "killed")
    .sort((left, right) => right.score - left.score || right.lastUpdatedAt.localeCompare(left.lastUpdatedAt))[0] ?? null;
}

function roundScore(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

async function copyAttachmentIntoWorkspace(
  workspacePath: string,
  attachmentDir: string,
  attachmentId: string,
  sourcePath: string
) {
  const fileName = path.basename(sourcePath).replace(/[^A-Za-z0-9._-]+/g, "-");
  const relativePath = path.relative(workspacePath, path.join(attachmentDir, `${attachmentId}-${fileName}`));
  const targetPath = path.join(workspacePath, relativePath);
  await copyFile(sourcePath, targetPath);
  return relativePath;
}

async function extractAttachmentExcerpt(filePath: string) {
  try {
    const content = await readFile(filePath, "utf8");
    return content.replace(/\s+/g, " ").trim().slice(0, 500);
  } catch {
    return "";
  }
}

function classifyAttachment(fileName: string, excerpt: string): AttachmentKind {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".csv" || extension === ".tsv") {
    return "csv";
  }
  if ([".txt", ".md", ".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".go", ".java", ".rs", ".c", ".cpp", ".h"].includes(extension)) {
    return "text";
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) {
    return "image";
  }
  if ([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"].includes(extension)) {
    return "document";
  }
  return excerpt ? "text" : "other";
}
