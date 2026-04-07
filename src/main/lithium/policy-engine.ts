import type {
  BranchRecord,
  PlanStepProposal,
  PlannerProposal,
  PriorityScore,
  RunRecord,
  TaskBudgetBucket,
  TaskRecord
} from "../../shared/types";
import { clamp01, roundScore } from "./utils";

const PROVIDER_CAPACITY = {
  strategist: 1,
  builder: 1,
  experimenter: 1,
  evaluator: 1
} as const;

const BRANCH_ACTION_KINDS = new Set([
  "discover",
  "read_synthesize",
  "build_change",
  "verify_change",
  "run_experiment",
  "promote_patch"
] as const);

export class PolicyEngine {
  shouldCreatePlanTask(input: {
    run: RunRecord;
    branches: BranchRecord[];
    tasks: TaskRecord[];
  }) {
    if (input.run.status !== "active") {
      return false;
    }
    if (hasBudgetExceeded(input.run, "planning")) {
      return false;
    }
    if (input.branches.filter((entry) => isBranchSchedulable(entry.status)).length === 0) {
      return false;
    }
    const pendingOrRunningPlan = input.tasks.some(
      (entry) => entry.runId === input.run.id && entry.kind === "plan" && (entry.status === "pending" || entry.status === "running")
    );
    if (pendingOrRunningPlan) {
      return false;
    }
    const pendingNonEvaluation = input.tasks.some(
      (entry) =>
        entry.runId === input.run.id &&
        (entry.status === "pending" || entry.status === "running") &&
        entry.kind !== "evaluate_branch"
    );
    return !pendingNonEvaluation;
  }

  validateProposal(input: {
    proposal: PlannerProposal;
    run: RunRecord;
    branches: BranchRecord[];
    tasks: TaskRecord[];
  }) {
    const branchesRemaining = Math.max(0, input.run.budget.maxBranches - input.branches.length);
    const branchTitles = new Set(input.branches.map((entry) => entry.title.trim().toLowerCase()));
    const proposedBranches = input.proposal.proposedBranches
      .filter((entry) => !branchTitles.has(entry.title.trim().toLowerCase()))
      .slice(0, branchesRemaining);
    const proposedTasks = input.proposal.proposedTasks.filter((task) => this.acceptProposalTask(task, input));
    return {
      proposedBranches,
      proposedTasks
    };
  }

  reserveRunnableTasks(input: {
    run: RunRecord;
    tasks: TaskRecord[];
    branches: BranchRecord[];
    activeTasks: TaskRecord[];
  }) {
    if (input.run.status !== "active") {
      return [];
    }

    const branchById = new Map(input.branches.map((entry) => [entry.id, entry] as const));
    const activeByExecutor = countByExecutor(input.activeTasks);
    const writeLockedBranches = new Set(
      input.activeTasks.filter((entry) => entry.kind === "build_change").map((entry) => entry.branchId)
    );
    const evaluationBarrierBranches = new Set(
      input.tasks
        .filter((entry) => (entry.status === "pending" || entry.status === "running") && entry.kind === "evaluate_branch")
        .map((entry) => entry.branchId)
    );

    const pending = input.tasks
      .filter((entry) => entry.runId === input.run.id && entry.status === "pending")
      .filter((entry) => dependenciesSatisfied(input.tasks, entry))
      .filter((entry) => !hasBudgetExceeded(input.run, bucketForTask(entry.kind)))
      .sort((left, right) => {
        return (
          right.priority.total - left.priority.total ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id)
        );
      });

    const selected: TaskRecord[] = [];
    for (const task of pending) {
      const branch = branchById.get(task.branchId) ?? null;
      if (!branch || !isBranchSchedulable(branch.status)) {
        continue;
      }

      if (
        evaluationBarrierBranches.has(task.branchId) &&
        task.kind !== "evaluate_branch" &&
        task.kind !== "plan" &&
        BRANCH_ACTION_KINDS.has(task.kind)
      ) {
        continue;
      }

      const executor = executorForTask(task.kind);
      if (activeByExecutor[executor] >= PROVIDER_CAPACITY[executor]) {
        continue;
      }

      if (writeLockedBranches.has(task.branchId) && task.kind !== "discover" && task.kind !== "read_synthesize") {
        continue;
      }

      selected.push(task);
      activeByExecutor[executor] += 1;
      if (task.kind === "build_change") {
        writeLockedBranches.add(task.branchId);
      }
      if (task.kind === "evaluate_branch") {
        evaluationBarrierBranches.add(task.branchId);
      }
    }
    return selected;
  }

  buildPriority(task: PlanStepProposal | { kind: TaskRecord["kind"]; title: string }, branch?: BranchRecord | null): PriorityScore {
    const expectedInfoGain = clamp01("expectedInfoGain" in task ? task.expectedInfoGain : defaultInfoGain(task.kind));
    const estimatedCost = clamp01("estimatedCost" in task ? task.estimatedCost : defaultCost(task.kind));
    const objectiveAlignment = clamp01(task.kind === "evaluate_branch" ? 0.82 : task.kind === "promote_patch" ? 0.9 : 0.74);
    const feasibility = clamp01(task.kind === "build_change" ? 0.68 : task.kind === "run_experiment" || task.kind === "verify_change" ? 0.8 : 0.86);
    const evidenceStrength = clamp01(branch && branch.findingIds.length > 0 ? 0.75 : 0.3);
    const duplicationPenalty = 0;
    const total = roundScore(
      objectiveAlignment * 2.5 +
        expectedInfoGain * 3 +
        feasibility * 2 +
        evidenceStrength * 1.5 -
        estimatedCost * 1.5 -
        duplicationPenalty * 2
    );

    return {
      objectiveAlignment,
      expectedInfoGain,
      feasibility,
      estimatedCost,
      evidenceStrength,
      duplicationPenalty,
      total
    };
  }

  incrementBudget(run: RunRecord, kind: TaskRecord["kind"]) {
    const bucket = bucketForTask(kind);
    return {
      ...run,
      budgetUsage: {
        ...run.budgetUsage,
        [bucket]: run.budgetUsage[bucket] + 1
      }
    };
  }

  classifyRecovery(task: TaskRecord) {
    if (task.attemptCount < task.maxAttempts) {
      return "retryable" as const;
    }
    return "needs-human" as const;
  }

  private acceptProposalTask(input: PlanStepProposal, state: {
    run: RunRecord;
    branches: BranchRecord[];
    tasks: TaskRecord[];
  }) {
    const bucket = bucketForTask(input.kind);
    if (hasBudgetExceeded(state.run, bucket)) {
      return false;
    }

    const duplicate = state.tasks.some(
      (entry) =>
        (entry.status === "pending" || entry.status === "running") &&
        entry.kind === input.kind &&
        entry.title.trim().toLowerCase() === input.title.trim().toLowerCase()
    );
    if (duplicate) {
      return false;
    }

    const branch =
      (input.branchTitle
        ? state.branches.find((entry) => entry.title.trim().toLowerCase() === input.branchTitle?.trim().toLowerCase())
        : state.branches[0]) ?? null;
    if (!branch || !isBranchSchedulable(branch.status)) {
      return false;
    }

    if ((input.kind === "run_experiment" || input.kind === "verify_change") && !input.experimentSpec) {
      return false;
    }

    return true;
  }
}

export function bucketForTask(kind: TaskRecord["kind"]): TaskBudgetBucket {
  switch (kind) {
    case "plan":
      return "planning";
    case "discover":
    case "read_synthesize":
      return "discovery";
    case "build_change":
      return "build";
    case "verify_change":
    case "run_experiment":
    case "promote_patch":
      return "experiment";
    case "evaluate_branch":
      return "evaluation";
  }
}

export function executorForTask(kind: TaskRecord["kind"]) {
  switch (kind) {
    case "plan":
    case "discover":
    case "read_synthesize":
      return "strategist";
    case "build_change":
      return "builder";
    case "verify_change":
    case "run_experiment":
    case "promote_patch":
      return "experimenter";
    case "evaluate_branch":
      return "evaluator";
  }
}

export function dependenciesSatisfied(tasks: TaskRecord[], task: TaskRecord) {
  return task.dependencies.every((dependency) => {
    const parent = tasks.find((entry) => entry.id === dependency.taskId);
    if (!parent) {
      return false;
    }

    switch (dependency.on) {
      case "success":
        return parent.status === "completed";
      case "failed":
        return parent.status === "failed" || parent.status === "cancelled" || parent.status === "needs-human";
      case "terminal":
        return parent.status === "completed" || parent.status === "failed" || parent.status === "cancelled" || parent.status === "needs-human";
    }
  });
}

export function hasBudgetExceeded(run: RunRecord, bucket: TaskBudgetBucket) {
  return run.budgetUsage[bucket] >= run.budget[bucket];
}

export function isBranchSchedulable(status: BranchRecord["status"]) {
  return status === "candidate" || status === "active";
}

function countByExecutor(tasks: TaskRecord[]) {
  return tasks.reduce(
    (counts, task) => {
      const key = executorForTask(task.kind);
      counts[key] += 1;
      return counts;
    },
    {
      strategist: 0,
      builder: 0,
      experimenter: 0,
      evaluator: 0
    }
  );
}

function defaultInfoGain(kind: TaskRecord["kind"]) {
  switch (kind) {
    case "plan":
      return 0.72;
    case "discover":
      return 0.84;
    case "read_synthesize":
      return 0.7;
    case "build_change":
      return 0.64;
    case "verify_change":
      return 0.78;
    case "run_experiment":
      return 0.78;
    case "evaluate_branch":
      return 0.61;
    case "promote_patch":
      return 0.55;
  }
}

function defaultCost(kind: TaskRecord["kind"]) {
  switch (kind) {
    case "plan":
      return 0.22;
    case "discover":
      return 0.28;
    case "read_synthesize":
      return 0.36;
    case "build_change":
      return 0.62;
    case "verify_change":
      return 0.48;
    case "run_experiment":
      return 0.58;
    case "evaluate_branch":
      return 0.2;
    case "promote_patch":
      return 0.18;
  }
}
