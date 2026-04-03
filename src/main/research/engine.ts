import type {
  EvaluationRecord,
  LithiumHandoff,
  ResearchBranchRecord,
  ResearchObjectiveRecord,
  ResearchProjectionRecord,
  ResearchRunRecord,
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
  codexWorkItem: ResearchWorkItemRecord | null;
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

    const branchesById = new Map(state.branches.map((entry) => [entry.id, entry]));
    const ranked = rankRunnableWorkItems(state.workItems, branchesById);
    const oracleWorkItems = ranked
      .filter((entry) => entry.executor === "oracle-planner" || entry.executor === "oracle-research")
      .slice(0, run.slotBudget.oracleSlots);
    const codexWorkItem =
      ranked.find((entry) =>
        entry.executor === "builder-edit" || entry.executor === "experiment-run" || entry.executor === "evaluator"
      ) ?? null;
    const replanTriggers = collectResearchReplanTriggers({
      runnableQueueDepth: ranked.length,
      latestEvaluation: state.latestEvaluation,
      latestBranch: state.latestBranch,
      latestSource: state.latestSource,
      latestWorkItem: state.latestWorkItem,
      budgetBoundary: run.slotBudget.completedWorkItems >= run.slotBudget.maxTotalWorkItems
    });

    return {
      objective,
      run,
      oracleWorkItems,
      codexWorkItem,
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
    const branches = new Map(state.branches.map((entry) => [entry.title.toLowerCase(), entry]));
    const now = new Date().toISOString();

    for (const proposedBranch of input.handoff.proposedBranches ?? []) {
      const existing = branches.get(proposedBranch.title.trim().toLowerCase());
      if (existing) {
        continue;
      }

      const allocation = await this.deps.stateStore.allocateBranch(input.workspacePath);
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
      await this.deps.stateStore.writeBranch(input.workspacePath, branch);
      branches.set(branch.title.toLowerCase(), branch);
      await this.deps.stateStore.writeObjective(input.workspacePath, {
        ...input.objective,
        branchIds: Array.from(new Set([...input.objective.branchIds, branch.id])),
        updatedAt: now
      });
    }

    for (const suggested of input.handoff.researchWorkItems ?? []) {
      const branch =
        (suggested.branchTitle && branches.get(suggested.branchTitle.trim().toLowerCase())) ??
        state.branches.find((entry) => entry.id === input.objective.activeBranchId) ??
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
      await this.deps.stateStore.writeBranch(input.workspacePath, {
        ...branch,
        workItemIds: Array.from(new Set([...branch.workItemIds, workItem.id])),
        nextWorkItemId: branch.nextWorkItemId ?? workItem.id,
        updatedAt: now,
        lastUpdatedAt: now
      });
    }

    await this.appendHandoffEvidence({
      workspacePath: input.workspacePath,
      objective: input.objective,
      branch:
        state.branches.find((entry) => entry.id === input.objective.activeBranchId) ??
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

    const updatedBranch: ResearchBranchRecord = {
      ...branch,
      score: roundScore(branch.score + input.evaluation.scoreDelta),
      status: deriveBranchStatus(branch, input.evaluation.verdict, input.status),
      nextWorkItemId: undefined,
      lastFailureReason: input.status === "failed" ? input.summary : branch.lastFailureReason,
      workItemIds: Array.from(new Set([...branch.workItemIds, finalizedWorkItem.id])),
      updatedAt: now,
      lastUpdatedAt: now
    };
    await this.deps.stateStore.writeBranch(input.workspacePath, updatedBranch);

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
      ...input.objective,
      status: nextRunStatus === "completed" ? "completed" : input.objective.status,
      summary: input.evaluation.summary,
      updatedAt: now
    });
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
        runId: input.runId ?? null
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
      summary: input.summary,
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
