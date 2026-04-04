import type { ResearchObjectiveRecord, ResearchRunRecord } from "../../shared/types";
import { ResearchStateStore } from "./state-store";
import { RuntimeRegistry } from "./runtime-registry";
import { ResearchScheduler } from "./scheduler";
import { ResearchResultProcessor } from "./result-processor";
import { ResearchWatchdog } from "./watchdog";
import { WorkerGateway, type WorkerDispatchResult } from "./worker-gateway";

export class ResearchRunCoordinator {
  constructor(
    private readonly deps: {
      stateStore: ResearchStateStore;
      scheduler: ResearchScheduler;
      resultProcessor: ResearchResultProcessor;
      runtimeRegistry: RuntimeRegistry<WorkerDispatchResult>;
      watchdog: ResearchWatchdog<WorkerDispatchResult>;
      workerGateway: WorkerGateway;
    }
  ) {}

  async runLoop(workspacePath: string, runId: string) {
    while (true) {
      const state = await this.deps.stateStore.readState(workspacePath);
      const run = state.runs.find((entry) => entry.id === runId) ?? null;
      if (!run) {
        return;
      }

      const objective =
        state.objectives.find((entry) => entry.id === run.objectiveId) ??
        (await this.deps.stateStore.readState(workspacePath, run.objectiveId)).latestObjective ??
        null;
      if (!objective) {
        return;
      }

      const activeHandles = this.deps.runtimeRegistry.listByRun(run.id);
      await this.deps.watchdog.enforce(run, activeHandles);

      if (run.status === "active" && !run.dispatchPaused) {
        await this.deps.scheduler.ensureQueue({
          workspacePath,
          objective,
          run
        });
        await this.dispatchRunnableTasks({
          workspacePath,
          objective,
          run
        });
      }

      const completion = await this.deps.runtimeRegistry.waitForNext(run.id, 1_000);
      if (completion) {
        try {
          await this.deps.resultProcessor.processCompletion({
            workspacePath,
            objectiveId: completion.handle.objectiveId,
            runId: completion.handle.runId,
            taskId: completion.handle.task.id,
            result: completion.result
          });
        } finally {
          this.deps.runtimeRegistry.complete(completion.handle);
        }
        continue;
      }

      const refreshedState = await this.deps.stateStore.readState(workspacePath, objective.id);
      const refreshedRun = refreshedState.runs.find((entry) => entry.id === run.id) ?? null;
      if (!refreshedRun) {
        return;
      }

      const stillActive = this.deps.runtimeRegistry.listByRun(run.id).length;
      if (stillActive > 0) {
        continue;
      }

      if (refreshedRun.status === "paused" || refreshedRun.status === "blocked" || refreshedRun.status === "completed") {
        await this.deps.resultProcessor.materializeProjection(workspacePath, objective.id);
        return;
      }

      if (refreshedRun.status === "failed") {
        if (refreshedRun.stopReason === "Run stopped by the user.") {
          return;
        }
        await this.deps.resultProcessor.materializeProjection(workspacePath, objective.id);
        return;
      }

      const pendingTasks = refreshedState.workItems.filter((task) => task.status === "pending");
      if (pendingTasks.length === 0) {
        await this.deps.stateStore.writeRun(workspacePath, {
          ...refreshedRun,
          status: "paused",
          stopReason: refreshedRun.stopReason ?? "Queue drained. Resume or replan to continue.",
          updatedAt: new Date().toISOString()
        });
        await this.deps.resultProcessor.materializeProjection(workspacePath, objective.id);
        return;
      }
    }
  }

  terminateRun(runId: string) {
    this.deps.runtimeRegistry.terminateRun(runId);
  }

  private async dispatchRunnableTasks(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    run: ResearchRunRecord;
  }) {
    const activeTasks = this.deps.runtimeRegistry.listByRun(input.run.id);
    const dispatchPlan = await this.deps.scheduler.createDispatchPlan({
      workspacePath: input.workspacePath,
      objective: input.objective,
      run: input.run,
      activeTasks
    });

    if (dispatchPlan.length === 0) {
      return;
    }

    let run = input.run;
    for (const planned of dispatchPlan) {
      const branch =
        (await this.deps.stateStore.readState(input.workspacePath, input.objective.id)).branches.find(
          (entry) => entry.id === planned.task.branchId
        ) ?? null;
      const handle = await this.deps.workerGateway.dispatch({
        workspacePath: input.workspacePath,
        objective: input.objective,
        branch,
        run,
        workItem: planned.task,
        runtimeContext: planned.runtimeContext
      });
      const runningTask = {
        ...planned.task,
        status: "running" as const,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        oracleSessionSlug: handle.oracleSessionSlug ?? planned.task.oracleSessionSlug,
        worktreePath: handle.worktreePath ?? planned.task.worktreePath
      };
      await this.deps.stateStore.writeWorkItem(input.workspacePath, runningTask);
      run = {
        ...run,
        activeWorkItemIds: Array.from(new Set([...run.activeWorkItemIds, runningTask.id])),
        oracleSessionSlugs: Array.from(
          new Set([...run.oracleSessionSlugs, ...(handle.oracleSessionSlug ? [handle.oracleSessionSlug] : [])])
        ),
        updatedAt: runningTask.updatedAt
      };
      await this.deps.stateStore.writeRun(input.workspacePath, run);
      this.deps.runtimeRegistry.register({
        workspacePath: input.workspacePath,
        runId: run.id,
        objectiveId: input.objective.id,
        task: runningTask,
        deadlineAt: handle.deadlineAt,
        terminate: handle.terminate,
        resultPromise: handle.resultPromise
      });
      await this.deps.stateStore.appendActivity(
        input.workspacePath,
        `dispatch ${runningTask.executor ?? runningTask.kind} ${runningTask.id}: ${runningTask.title}`
      );
    }

    await this.deps.resultProcessor.materializeProjection(input.workspacePath, input.objective.id);
  }
}
