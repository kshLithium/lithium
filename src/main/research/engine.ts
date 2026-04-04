import type {
  EvaluationRecord,
  LithiumHandoff,
  ResearchBranchRecord,
  ResearchHypothesisRecord,
  ResearchObjectiveRecord,
  ResearchProjectionRecord,
  ResearchRunRecord,
  ResearchWorktreeLeaseRecord,
  ResearchWorkItemRecord
} from "../../shared/types";
import { ChatProjectionService } from "./chat-projection-service";
import { normalizeSuggestedExecutor } from "./oracle-worker-pool";
import { collectResearchReplanTriggers, shouldReplanResearchQueue } from "./policy/replan-policy";
import { buildResearchPriorityScore, rankRunnableWorkItems } from "./policy/scheduler-policy";
import { ResearchStateStore } from "./state-store";

export type ResearchDispatchBatch = {
  objective: ResearchObjectiveRecord;
  run: ResearchRunRecord;
  oracleWorkItems: ResearchWorkItemRecord[];
  codexWorkItems: ResearchWorkItemRecord[];
  replanTriggers: string[];
};

export type ResearchOutcomeInput = {
  workspacePath: string;
  objective: ResearchObjectiveRecord;
  run: ResearchRunRecord;
  workItem: ResearchWorkItemRecord;
  summary: string;
  status: "completed" | "failed" | "cancelled";
  evaluation: EvaluationRecord;
  changedFiles?: string[];
  risks?: string[];
  openQuestions?: string[];
  runActions?: string[];
  handoff?: LithiumHandoff;
  runId?: string;
  worktreePath?: string;
  oracleSessionSlug?: string;
  patchArtifactPath?: string;
  promotionStatus?: ResearchWorkItemRecord["promotionStatus"];
  promotionError?: string;
  lease?: ResearchWorktreeLeaseRecord;
};

export class ResearchEngine {
  constructor(
    private readonly deps: {
      stateStore: ResearchStateStore;
      chatProjectionService?: ChatProjectionService;
    }
  ) {}

  async ensureRunnableQueue(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    run: ResearchRunRecord;
    runtimeContext: string;
  }) {
    const state = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const replanTriggers = collectResearchReplanTriggers({
      runnableQueueDepth: state.workItems.filter((entry) => entry.status === "pending").length,
      latestEvaluation: state.latestEvaluation,
      latestBranch: state.latestBranch,
      latestSource: state.latestSource,
      latestWorkItem: state.latestWorkItem,
      budgetBoundary: input.run.slotBudget.completedWorkItems >= input.run.slotBudget.maxTotalWorkItems
    });
    const shouldReplan = shouldReplanResearchQueue({
      runnableQueueDepth: state.workItems.filter((entry) => entry.status === "pending").length,
      latestEvaluation: state.latestEvaluation,
      latestBranch: state.latestBranch,
      latestSource: state.latestSource,
      latestWorkItem: state.latestWorkItem,
      budgetBoundary: input.run.slotBudget.completedWorkItems >= input.run.slotBudget.maxTotalWorkItems
    });

    if (shouldReplan) {
      const hasPendingPlanner = state.workItems.some(
        (entry) => entry.status === "pending" && entry.executor === "oracle-planner"
      );
      if (!hasPendingPlanner) {
        await this.createPlannerWorkItem(input.workspacePath, input.objective, state.latestBranch ?? null, input.runtimeContext);
      }
    } else if (!state.workItems.some((entry) => entry.status === "pending" && entry.executor === "oracle-research")) {
      const branch =
        state.branches.find((entry) => entry.id === input.objective.activeBranchId) ??
        state.latestBranch ??
        null;
      if (branch) {
        await this.createResearchFanoutItem(input.workspacePath, input.objective, branch, input.runtimeContext);
      }
    }

    return replanTriggers;
  }

  async pickDispatchBatch(input: {
    workspacePath: string;
    objectiveId: string;
    runId: string;
  }): Promise<ResearchDispatchBatch | null> {
    const state = await this.deps.stateStore.readState(input.workspacePath, input.objectiveId);
    const objective = state.latestObjective;
    const run = state.runs.find((entry) => entry.id === input.runId) ?? state.latestRun;

    if (!objective || !run) {
      return null;
    }

    const replanTriggers = collectResearchReplanTriggers({
      runnableQueueDepth: state.workItems.filter((entry) => entry.status === "pending").length,
      latestEvaluation: state.latestEvaluation,
      latestBranch: state.latestBranch,
      latestSource: state.latestSource,
      latestWorkItem: state.latestWorkItem,
      budgetBoundary: run.slotBudget.completedWorkItems >= run.slotBudget.maxTotalWorkItems,
      metricShift: state.metrics.length > 1
    });
    const branchesById = new Map(state.branches.map((entry) => [entry.id, entry]));
    const ranked = rankRunnableWorkItems(state.workItems, branchesById);
    const oraclePending = ranked.filter(
      (entry) => entry.executor === "oracle-planner" || entry.executor === "oracle-research"
    );
    const codexPending = ranked.filter(
      (entry) => entry.executor === "builder-edit" || entry.executor === "experiment-run" || entry.executor === "evaluator"
    );
    const plannerCandidate = oraclePending.find((entry) => entry.executor === "oracle-planner") ?? null;
    const oracleResearchCandidates = oraclePending.filter((entry) => entry.executor === "oracle-research");
    const reservedPlannerSlots = plannerCandidate ? 1 : 0;
    const oracleWorkItems = [
      ...(reservedPlannerSlots ? [plannerCandidate] : []),
      ...oracleResearchCandidates.slice(0, Math.max(run.slotBudget.oracleSlots - reservedPlannerSlots, 0))
    ]
      .filter((entry): entry is ResearchWorkItemRecord => Boolean(entry))
      .slice(0, run.slotBudget.oracleSlots);
    const codexWorkItems = codexPending.slice(0, Math.max(run.slotBudget.codexSlots, 0));

    return {
      objective,
      run,
      oracleWorkItems,
      codexWorkItems,
      replanTriggers
    };
  }

  async markWorkItemsRunning(input: {
    workspacePath: string;
    run: ResearchRunRecord;
    workItems: ResearchWorkItemRecord[];
  }) {
    const now = new Date().toISOString();
    for (const workItem of input.workItems) {
      await this.deps.stateStore.writeWorkItem(input.workspacePath, {
        ...workItem,
        status: "running",
        startedAt: now,
        updatedAt: now
      });
      await this.deps.stateStore.appendEvent(input.workspacePath, {
        id: `${workItem.id}-started`,
        threadId: workItem.threadId,
        objectiveId: workItem.objectiveId,
        branchId: workItem.branchId,
        workItemId: workItem.id,
        type: "work-item.started",
        payload: {
          executor: workItem.executor,
          title: workItem.title
        },
        createdAt: now
      });
    }

    await this.deps.stateStore.writeRun(input.workspacePath, {
      ...input.run,
      activeWorkItemIds: Array.from(new Set([...input.run.activeWorkItemIds, ...input.workItems.map((entry) => entry.id)])),
      updatedAt: now
    });
  }

  async applyPlannerHandoff(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    run: ResearchRunRecord;
    workItem: ResearchWorkItemRecord;
    handoff: LithiumHandoff;
    oracleSessionSlug: string;
  }) {
    const state = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const branchesByTitle = new Map(state.branches.map((entry) => [entry.title.toLowerCase(), entry]));
    const branchesById = new Map(state.branches.map((entry) => [entry.id, entry]));
    const now = new Date().toISOString();
    const nextObjective: ResearchObjectiveRecord = {
      ...input.objective,
      branchIds: [...input.objective.branchIds],
      updatedAt: now
    };
    const branchWrites = new Map<string, ResearchBranchRecord>();
    const newHypotheses: ResearchHypothesisRecord[] = [];

    for (const proposedBranch of input.handoff.proposedBranches ?? []) {
      const normalizedTitle = proposedBranch.title.trim().toLowerCase();
      const existing = branchesByTitle.get(normalizedTitle);
      if (existing) {
        continue;
      }

      const allocation = await this.deps.stateStore.allocateBranch(input.workspacePath);
      const hypothesisAllocation = await this.deps.stateStore.allocateHypothesis(input.workspacePath);
      const branch: ResearchBranchRecord = {
        id: allocation.id,
        objectiveId: input.objective.id,
        threadId: input.objective.threadId,
        title: proposedBranch.title.trim(),
        hypothesis: proposedBranch.hypothesis.trim(),
        status: "candidate",
        score: 0.55,
        blocker: undefined,
        nextWorkItemId: undefined,
        lastFailureReason: undefined,
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
        objectiveId: input.objective.id,
        branchId: branch.id,
        threadId: input.objective.threadId,
        statement: proposedBranch.hypothesis.trim(),
        status: "open",
        confidence: 0.5,
        evidenceIds: [],
        createdAt: now,
        updatedAt: now
      };
      branchesByTitle.set(normalizedTitle, branch);
      branchesById.set(branch.id, branch);
      branchWrites.set(branch.id, branch);
      newHypotheses.push(hypothesis);
      nextObjective.branchIds = Array.from(new Set([...nextObjective.branchIds, branch.id]));
    }

    for (const suggested of input.handoff.researchWorkItems ?? []) {
      const branch =
        (suggested.branchTitle && branchesByTitle.get(suggested.branchTitle.trim().toLowerCase())) ??
        branchesById.get(input.objective.activeBranchId ?? "") ??
        state.latestBranch;
      if (!branch) {
        continue;
      }

      const allocation = await this.deps.stateStore.allocateWorkItem(input.workspacePath);
      const normalized = normalizeSuggestedExecutor(
        suggested.kind,
        suggested.executor,
        suggested.isolation
      );
      const workItem: ResearchWorkItemRecord = {
        id: allocation.id,
        objectiveId: input.objective.id,
        branchId: branch.id,
        threadId: input.objective.threadId,
        kind: suggested.kind,
        lane: resolveLaneForExecutor(normalized.executor),
        executor: normalized.executor,
        title: suggested.title,
        prompt: suggested.prompt,
        status: "pending",
        executionMode: normalized.isolation === "worktree" ? "isolated" : "sync",
        isolation: normalized.isolation,
        priorityScore: buildResearchPriorityScore({
          kind: suggested.kind
        }),
        sourceIds: [],
        dependsOnIds: [],
        createdAt: now,
        updatedAt: now
      };
      await this.deps.stateStore.writeWorkItem(input.workspacePath, workItem);
      const nextBranch = branchWrites.get(branch.id) ?? branch;
      branchWrites.set(branch.id, {
        ...nextBranch,
        workItemIds: Array.from(new Set([...nextBranch.workItemIds, workItem.id])),
        nextWorkItemId: nextBranch.nextWorkItemId ?? workItem.id,
        updatedAt: now,
        lastUpdatedAt: now
      });
    }

    await this.deps.stateStore.writeObjective(input.workspacePath, nextObjective);
    for (const branch of branchWrites.values()) {
      await this.deps.stateStore.writeBranch(input.workspacePath, branch);
    }
    for (const hypothesis of newHypotheses) {
      await this.deps.stateStore.writeHypothesis(input.workspacePath, hypothesis);
    }

    await this.appendHandoffEvidence({
      workspacePath: input.workspacePath,
      objective: nextObjective,
      branch:
        branchWrites.get(input.objective.activeBranchId ?? "") ??
        branchesById.get(input.objective.activeBranchId ?? "") ??
        state.latestBranch ??
        null,
      workItem: input.workItem,
      summary: input.handoff.summary,
      detail: input.handoff.rationale,
      evidence: [...(input.handoff.openQuestions ?? []), ...(input.handoff.runActions ?? [])],
      sourceKind: "web",
      oracleSessionSlug: input.oracleSessionSlug
    });
  }

  async finalizeOutcome(input: ResearchOutcomeInput) {
    const state = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const branch =
      state.branches.find((entry) => entry.id === input.workItem.branchId) ??
      state.latestBranch;

    if (!branch) {
      throw new Error(`Branch not found for work item ${input.workItem.id}`);
    }

    const now = new Date().toISOString();
    const finalizedWorkItem: ResearchWorkItemRecord = {
      ...input.workItem,
      status: input.status,
      oracleSessionSlug: input.oracleSessionSlug ?? input.workItem.oracleSessionSlug,
      runId: input.runId ?? input.workItem.runId,
      worktreePath: input.worktreePath ?? input.workItem.worktreePath,
      resultEvaluationId: input.evaluation.id,
      leaseId: input.lease?.id ?? input.workItem.leaseId,
      patchArtifactPath: input.patchArtifactPath ?? input.workItem.patchArtifactPath,
      promotionStatus: input.promotionStatus ?? input.workItem.promotionStatus,
      promotionError: input.promotionError ?? input.workItem.promotionError,
      completedAt: now,
      updatedAt: now
    };
    await this.deps.stateStore.writeWorkItem(input.workspacePath, finalizedWorkItem);

    await this.appendHandoffEvidence({
      workspacePath: input.workspacePath,
      objective: input.objective,
      branch,
      workItem: finalizedWorkItem,
      summary: input.summary,
      detail: input.handoff?.rationale ?? input.evaluation.rationale,
      evidence: [...(input.changedFiles ?? []), ...(input.risks ?? []), ...(input.openQuestions ?? [])],
      sourceKind:
        finalizedWorkItem.executor === "builder-edit" || finalizedWorkItem.executor === "experiment-run"
          ? "run"
          : "web",
      oracleSessionSlug: input.oracleSessionSlug
    });

    await this.deps.stateStore.writeEvaluation(input.workspacePath, input.evaluation);
    await this.deps.stateStore.appendActivity(
      input.workspacePath,
      `evaluation ${input.evaluation.verdict} for ${input.workItem.id} on ${branch.title}`
    );

    const branchState = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const branchWithEvidence = branchState.branches.find((entry) => entry.id === branch.id) ?? branch;
    const updatedBranch: ResearchBranchRecord = {
      ...branchWithEvidence,
      score: roundScore(branchWithEvidence.score + input.evaluation.scoreDelta),
      status: deriveBranchStatus(branchWithEvidence, input.evaluation.verdict, input.status),
      nextWorkItemId: undefined,
      lastFailureReason: input.status === "failed" ? input.summary : branchWithEvidence.lastFailureReason,
      workItemIds: Array.from(new Set([...branchWithEvidence.workItemIds, finalizedWorkItem.id])),
      updatedAt: now,
      lastUpdatedAt: now
    };
    await this.deps.stateStore.writeBranch(input.workspacePath, updatedBranch);
    await this.updateHypothesisFromEvaluation({
      workspacePath: input.workspacePath,
      branch: updatedBranch,
      evaluation: input.evaluation
    });

    const latestState = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const latestObjective = latestState.latestObjective ?? input.objective;
    const nextActiveBranch =
      selectActiveBranch(latestState.branches) ??
      latestState.branches.find((entry) => entry.id === latestObjective.activeBranchId) ??
      updatedBranch;
    const branchSwitched = nextActiveBranch.id !== latestObjective.activeBranchId;

    const nextRunStatus =
      input.run.slotBudget.completedWorkItems + 1 >= input.run.slotBudget.maxTotalWorkItems
        ? "paused"
        : input.evaluation.verdict === "complete"
        ? "completed"
        : input.run.status;
    await this.deps.stateStore.writeRun(input.workspacePath, {
      ...input.run,
      status: nextRunStatus,
      activeWorkItemIds: input.run.activeWorkItemIds.filter((entry) => entry !== input.workItem.id),
      oracleSessionSlugs: input.run.oracleSessionSlugs.filter((entry) => entry !== input.oracleSessionSlug),
      slotBudget: {
        ...input.run.slotBudget,
        completedWorkItems: input.run.slotBudget.completedWorkItems + 1
      },
      stopReason:
        nextRunStatus === "paused" && input.run.slotBudget.completedWorkItems + 1 >= input.run.slotBudget.maxTotalWorkItems
          ? "Reached the default work item budget for this run."
          : input.run.stopReason,
      updatedAt: now,
      endedAt: nextRunStatus === "completed" ? now : input.run.endedAt
    });
    await this.deps.stateStore.writeObjective(input.workspacePath, {
      ...latestObjective,
      status: nextRunStatus === "completed" ? "completed" : latestObjective.status,
      summary: input.evaluation.summary,
      activeBranchId: nextActiveBranch.id,
      updatedAt: now
    });
    if (branchSwitched) {
      await this.deps.stateStore.appendActivity(
        input.workspacePath,
        `branch switch ${latestObjective.activeBranchId ?? "none"} -> ${nextActiveBranch.id} (${nextActiveBranch.title})`
      );
    }
    if (finalizedWorkItem.promotionStatus === "promoted") {
      await this.deps.stateStore.appendActivity(
        input.workspacePath,
        `patch promoted for ${finalizedWorkItem.id}: ${finalizedWorkItem.patchArtifactPath ?? "inline"}`
      );
    }
    if (finalizedWorkItem.promotionStatus === "failed") {
      await this.deps.stateStore.appendActivity(
        input.workspacePath,
        `patch promotion failed for ${finalizedWorkItem.id}: ${finalizedWorkItem.promotionError ?? "unknown error"}`
      );
    }
    await this.deps.stateStore.appendEvent(input.workspacePath, {
      id: `${input.workItem.id}-completed`,
      threadId: input.objective.threadId,
      objectiveId: input.objective.id,
      branchId: branch.id,
      workItemId: input.workItem.id,
      type: "work-item.completed",
      payload: {
        executor: input.workItem.executor,
        status: input.status,
        evaluationId: input.evaluation.id,
        runId: input.runId ?? null,
        promotionStatus: finalizedWorkItem.promotionStatus ?? null
      },
      createdAt: now
    });
  }

  async blockRun(input: {
    workspacePath: string;
    run: ResearchRunRecord;
    reason: string;
  }) {
    const now = new Date().toISOString();
    await this.deps.stateStore.writeRun(input.workspacePath, {
      ...input.run,
      status: "blocked",
      blockedReason: input.reason,
      updatedAt: now
    });
    await this.deps.stateStore.appendActivity(input.workspacePath, `run blocked ${input.run.id}: ${input.reason}`);
  }

  async resumeRun(input: {
    workspacePath: string;
    run: ResearchRunRecord;
  }) {
    const now = new Date().toISOString();
    await this.deps.stateStore.writeRun(input.workspacePath, {
      ...input.run,
      status: "active",
      blockedReason: undefined,
      stopReason: undefined,
      updatedAt: now
    });
  }

  async materializeProjection(workspacePath: string, objectiveId: string) {
    const state = await this.deps.stateStore.readState(workspacePath, objectiveId);
    const objective = state.latestObjective;

    if (!objective) {
      return null;
    }

    const currentRun = state.latestRun;
    const projectionAllocation = await this.deps.stateStore.allocateProjection(workspacePath);
    const projection = (this.deps.chatProjectionService ?? new ChatProjectionService()).buildProjection({
      projectionId: projectionAllocation.id,
      threadId: objective.threadId,
      objective,
      branches: state.branches,
      findings: state.findings,
      workItems: state.workItems,
      evaluations: state.evaluations,
      run: currentRun
    });

    await this.deps.stateStore.writeProjection(workspacePath, projection);
    return projection;
  }

  async recoverInterruptedRuns(workspacePath: string) {
    const state = await this.deps.stateStore.readState(workspacePath);
    const now = new Date().toISOString();

    for (const run of state.runs.filter((entry) => entry.status === "active" && entry.activeWorkItemIds.length > 0)) {
      await this.deps.stateStore.writeRun(workspacePath, {
        ...run,
        status: "blocked",
        blockedReason: "The application restarted while Oracle or Codex work was still in flight.",
        activeWorkItemIds: [],
        oracleSessionSlugs: [],
        updatedAt: now
      });
      await this.deps.stateStore.appendActivity(
        workspacePath,
        `run blocked ${run.id}: application restarted while work items were active`
      );
    }
  }

  private async createPlannerWorkItem(
    workspacePath: string,
    objective: ResearchObjectiveRecord,
    branch: ResearchBranchRecord | null,
    runtimeContext: string
  ) {
    const allocation = await this.deps.stateStore.allocateWorkItem(workspacePath);
    const now = new Date().toISOString();
    const workItem: ResearchWorkItemRecord = {
      id: allocation.id,
      objectiveId: objective.id,
      branchId: branch?.id ?? objective.activeBranchId ?? "",
      threadId: objective.threadId,
      kind: "planner",
      lane: "planner",
      executor: "oracle-planner",
      title: branch ? `Replan ${branch.title}` : `Replan ${objective.title}`,
      prompt: branch
        ? `Replan the branch "${branch.title}" and propose the next small queue.`
        : `Plan the next small queue for "${objective.title}".`,
      status: "pending",
      executionMode: "async",
      isolation: "none",
      priorityScore: buildResearchPriorityScore({
        kind: "planner"
      }),
      sourceIds: [],
      dependsOnIds: [],
      createdAt: now,
      updatedAt: now
    };
    await this.deps.stateStore.writeWorkItem(workspacePath, workItem);
  }

  private async createResearchFanoutItem(
    workspacePath: string,
    objective: ResearchObjectiveRecord,
    branch: ResearchBranchRecord,
    runtimeContext: string
  ) {
    const allocation = await this.deps.stateStore.allocateWorkItem(workspacePath);
    const now = new Date().toISOString();
    const workItem: ResearchWorkItemRecord = {
      id: allocation.id,
      objectiveId: objective.id,
      branchId: branch.id,
      threadId: objective.threadId,
      kind: "deep-research",
      lane: "research",
      executor: "oracle-research",
      title: `Expand evidence for ${branch.title}`,
      prompt: `Find the next high-value external evidence or alternative approach for "${branch.title}".`,
      status: "pending",
      executionMode: "async",
      isolation: "none",
      priorityScore: buildResearchPriorityScore({
        kind: "deep-research"
      }),
      sourceIds: [],
      dependsOnIds: [],
      createdAt: now,
      updatedAt: now
    };
    await this.deps.stateStore.writeWorkItem(workspacePath, workItem);
  }

  private async appendHandoffEvidence(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    workItem: ResearchWorkItemRecord;
    summary: string;
    detail?: string;
    evidence: string[];
    sourceKind: "web" | "run";
    oracleSessionSlug?: string;
  }) {
    const sourceAllocation = await this.deps.stateStore.allocateSource(input.workspacePath);
    const findingAllocation = await this.deps.stateStore.allocateFinding(input.workspacePath);
    const now = new Date().toISOString();
    const source = {
      id: sourceAllocation.id,
      objectiveId: input.objective.id,
      threadId: input.objective.threadId,
      branchId: input.branch?.id,
      kind: input.sourceKind,
      title: input.workItem.title,
      locator: input.oracleSessionSlug ?? input.workItem.runId ?? input.workItem.id,
      provenance: input.oracleSessionSlug
        ? `oracle-session:${input.oracleSessionSlug}`
        : input.workItem.runId
        ? `run:${input.workItem.runId}`
        : `work-item:${input.workItem.id}`,
      summary: input.summary,
      excerpt: input.detail?.trim() || input.summary,
      metadata:
        input.oracleSessionSlug
          ? {
              oracleSessionSlug: input.oracleSessionSlug,
              executor: input.workItem.executor ?? "oracle-research"
            }
          : {
              executor: input.workItem.executor ?? "builder-edit",
              oracleSessionSlug: null
            },
      createdAt: input.workItem.startedAt ?? now,
      updatedAt: now
    } as const;
    const finding = {
      id: findingAllocation.id,
      objectiveId: input.objective.id,
      threadId: input.objective.threadId,
      branchId: input.branch?.id,
      sourceId: source.id,
      kind: input.sourceKind === "run" ? "observation" : "evidence",
      summary: input.summary,
      detail: input.detail,
      evidence: input.evidence.filter(Boolean),
      createdAt: input.workItem.startedAt ?? now,
      updatedAt: now
    } as const;

    await this.deps.stateStore.writeSource(input.workspacePath, source);
    await this.deps.stateStore.writeFinding(input.workspacePath, finding);
    await this.deps.stateStore.writeObjective(input.workspacePath, {
      ...input.objective,
      sourceIds: Array.from(new Set([...input.objective.sourceIds, source.id])),
      updatedAt: now
    });

    if (input.branch) {
      await this.deps.stateStore.writeBranch(input.workspacePath, {
        ...input.branch,
        sourceIds: Array.from(new Set([...input.branch.sourceIds, source.id])),
        findingIds: Array.from(new Set([...input.branch.findingIds, finding.id])),
        evidenceIds: Array.from(new Set([...input.branch.evidenceIds, finding.id])),
        updatedAt: now,
        lastUpdatedAt: now
      });
    }
  }

  private async updateHypothesisFromEvaluation(input: {
    workspacePath: string;
    branch: ResearchBranchRecord;
    evaluation: EvaluationRecord;
  }) {
    const state = await this.deps.stateStore.readState(input.workspacePath, input.branch.objectiveId);
    const hypothesis = state.hypotheses.find((entry) => entry.branchId === input.branch.id) ?? null;

    if (!hypothesis) {
      return;
    }

    const nextStatus =
      input.evaluation.verdict === "kill"
        ? "unsupported"
        : input.evaluation.verdict === "pivot"
        ? "revised"
        : input.evaluation.verdict === "complete" || input.evaluation.verdict === "continue"
        ? "supported"
        : "open";
    const nextConfidence = Math.max(
      0,
      Math.min(1, roundScore(hypothesis.confidence + input.evaluation.scoreDelta + (nextStatus === "supported" ? 0.05 : 0)))
    );

    await this.deps.stateStore.writeHypothesis(input.workspacePath, {
      ...hypothesis,
      status: nextStatus,
      confidence: nextConfidence,
      evidenceIds: Array.from(new Set([...hypothesis.evidenceIds, input.evaluation.id])),
      lastEvaluationId: input.evaluation.id,
      updatedAt: new Date().toISOString()
    });
  }
}

function resolveLaneForExecutor(executor: ResearchWorkItemRecord["executor"]) {
  switch (executor) {
    case "oracle-planner":
      return "planner" as const;
    case "oracle-research":
      return "research" as const;
    case "experiment-run":
      return "experiment" as const;
    case "evaluator":
      return "evaluator" as const;
    case "builder-edit":
    default:
      return "builder" as const;
  }
}

function deriveBranchStatus(
  branch: ResearchBranchRecord,
  verdict: EvaluationRecord["verdict"],
  executionStatus: ResearchOutcomeInput["status"]
): ResearchBranchRecord["status"] {
  if (verdict === "complete") {
    return "completed";
  }

  if (verdict === "kill") {
    return "killed";
  }

  if (verdict === "pivot" || executionStatus === "cancelled") {
    return "pivoted";
  }

  if (executionStatus === "failed") {
    return "blocked";
  }

  return "active";
}

function roundScore(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function selectActiveBranch(branches: ResearchBranchRecord[]) {
  return [...branches]
    .filter((entry) => entry.status === "active" || entry.status === "candidate" || entry.status === "pivoted")
    .sort((left, right) => right.score - left.score || right.lastUpdatedAt.localeCompare(left.lastUpdatedAt))[0] ?? null;
}
