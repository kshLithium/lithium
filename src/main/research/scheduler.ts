import type {
  ResearchObjectiveRecord,
  ResearchRunRecord,
  ResearchWorkItemRecord
} from "../../shared/types";
import type { ActiveTaskHandle } from "./runtime-registry";
import { createPlannerPayload, createTaskRecord, isCodexExecutor, isOracleExecutor, isTerminalTaskStatus } from "./task-contracts";
import { buildResearchRuntimeContext } from "./runtime-context";
import { ResearchStateStore } from "./state-store";

export type TaskDispatchPlan = {
  task: ResearchWorkItemRecord;
  runtimeContext: string;
};

export class ResearchScheduler {
  constructor(
    private readonly deps: {
      stateStore: ResearchStateStore;
    }
  ) {}

  async ensureQueue(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    run: ResearchRunRecord;
  }) {
    if (input.run.slotBudget.completedWorkItems >= input.run.slotBudget.maxTotalWorkItems) {
      return;
    }

    const state = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const pendingPlanner = state.workItems.some((task) => task.status === "pending" && task.kind === "plan");
    const runningPlanner = state.workItems.some((task) => task.status === "running" && task.kind === "plan");

    if (pendingPlanner || runningPlanner || !shouldReplan(state, input.run)) {
      return;
    }

    const activeBranch =
      state.branches.find((branch) => branch.id === input.objective.activeBranchId) ??
      [...state.branches].sort((left, right) => right.score - left.score)[0] ??
      null;
    if (!activeBranch) {
      return;
    }

    const allocation = await this.deps.stateStore.allocateWorkItem(input.workspacePath);
    const task = createTaskRecord({
      id: allocation.id,
      objectiveId: input.objective.id,
      branchId: activeBranch.id,
      title: `Plan next steps for ${activeBranch.title}`,
      prompt: `Plan the next bounded research steps for branch "${activeBranch.title}" under objective "${input.objective.title}".`,
      kind: "plan",
      payload: createPlannerPayload({
        objectiveId: input.objective.id,
        activeBranchId: activeBranch.id,
        goal: input.objective.objective
      })
    });
    await this.deps.stateStore.writeWorkItem(input.workspacePath, task);
    await this.deps.stateStore.writeBranch(input.workspacePath, {
      ...activeBranch,
      workItemIds: Array.from(new Set([...activeBranch.workItemIds, task.id])),
      nextWorkItemId: activeBranch.nextWorkItemId ?? task.id,
      updatedAt: task.updatedAt,
      lastUpdatedAt: task.updatedAt
    });
    await this.deps.stateStore.appendActivity(input.workspacePath, `scheduler enqueued plan task ${task.id}`);
  }

  async createDispatchPlan(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    run: ResearchRunRecord;
    activeTasks: Array<ActiveTaskHandle<unknown>>;
  }): Promise<TaskDispatchPlan[]> {
    if (input.run.status !== "active" || input.run.dispatchPaused) {
      return [];
    }

    const state = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const runnable = state.workItems
      .filter((task) => task.status === "pending")
      .filter((task) => task.dependsOnIds.every((id) => isDependencySatisfied(state.workItems, id)))
      .sort((left, right) => {
        return (
          right.priorityScore.total - left.priorityScore.total ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id)
        );
      });

    if (runnable.length === 0) {
      return [];
    }

    const activeOracle = input.activeTasks.filter((handle) => isOracleExecutor(handle.task.executor)).length;
    const activeCodex = input.activeTasks.filter((handle) => isCodexExecutor(handle.task.executor)).length;
    let oracleSlots = Math.max(0, input.run.slotBudget.oracleSlots - activeOracle);
    let codexSlots = Math.max(0, input.run.slotBudget.codexSlots - activeCodex);
    const busyCodexBranches = new Set(
      input.activeTasks.filter((handle) => isCodexExecutor(handle.task.executor)).map((handle) => handle.task.branchId)
    );
    const runtimeContext = buildResearchRuntimeContext({
      state,
      objective: input.objective,
      run: input.run
    });
    const selected: TaskDispatchPlan[] = [];

    for (const task of runnable) {
      if (selected.some((entry) => entry.task.id === task.id)) {
        continue;
      }

      if (isOracleExecutor(task.executor)) {
        if (oracleSlots <= 0) {
          continue;
        }
        oracleSlots -= 1;
        selected.push({ task, runtimeContext });
        continue;
      }

      if (isCodexExecutor(task.executor)) {
        if (codexSlots <= 0 || busyCodexBranches.has(task.branchId)) {
          continue;
        }
        codexSlots -= 1;
        busyCodexBranches.add(task.branchId);
        selected.push({ task, runtimeContext });
        continue;
      }

      selected.push({ task, runtimeContext });
    }

    return selected;
  }
}

function shouldReplan(
  state: Awaited<ReturnType<ResearchStateStore["readState"]>>,
  run: ResearchRunRecord
) {
  const pendingNonPlanner = state.workItems.filter(
    (task) => task.status === "pending" && task.kind !== "plan"
  ).length;
  if (state.workItems.length === 0) {
    return true;
  }
  if (pendingNonPlanner === 0) {
    return true;
  }

  const completedCount = state.workItems.filter((task) => isTerminalTaskStatus(task.status)).length;
  const sourceDelta = state.sources.length - (run.lastPlanSourceCount ?? 0);
  const completedDelta = completedCount - (run.lastPlanCompletedCount ?? 0);
  const topBranchScore = [...state.branches].sort((left, right) => right.score - left.score)[0]?.score ?? 0;
  const scoreDelta = Math.abs(topBranchScore - (run.lastPlanBranchScore ?? topBranchScore));
  const lastPlanAt = run.lastPlanAt ?? "";
  const branchDisruption = state.branches.some(
    (branch) =>
      (branch.status === "killed" || branch.status === "pivoted") &&
      branch.lastUpdatedAt.localeCompare(lastPlanAt) > 0
  );

  return pendingNonPlanner < 2 || sourceDelta >= 3 || completedDelta >= 2 || scoreDelta >= 0.15 || branchDisruption;
}

function isDependencySatisfied(workItems: ResearchWorkItemRecord[], dependencyId: string) {
  const dependency = workItems.find((task) => task.id === dependencyId);
  if (!dependency) {
    return true;
  }
  return dependency.status === "completed";
}
