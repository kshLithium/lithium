import type { ActiveWorkerProgressRecord, ResearchWorkItemRecord } from "../../shared/types";

export type ActiveTaskHandle<Result> = {
  key: string;
  workspacePath: string;
  runId: string;
  objectiveId: string;
  task: ResearchWorkItemRecord;
  startedAt: string;
  deadlineAt?: string;
  terminate: () => void;
  resultPromise: Promise<Result>;
  resolved?: Result;
  reported: boolean;
};

export class RuntimeRegistry<Result> {
  private readonly active = new Map<string, ActiveTaskHandle<Result>>();

  register(input: {
    workspacePath: string;
    runId: string;
    objectiveId: string;
    task: ResearchWorkItemRecord;
    deadlineAt?: string;
    terminate: () => void;
    resultPromise: Promise<Result>;
  }) {
    const key = this.buildKey(input.workspacePath, input.runId, input.task.id);
    const handle: ActiveTaskHandle<Result> = {
      key,
      workspacePath: input.workspacePath,
      runId: input.runId,
      objectiveId: input.objectiveId,
      task: input.task,
      startedAt: new Date().toISOString(),
      deadlineAt: input.deadlineAt,
      terminate: input.terminate,
      resultPromise: input.resultPromise.then((result) => {
        handle.resolved = result;
        return result;
      }),
      reported: false
    };

    this.active.set(key, handle);
    return handle;
  }

  listByRun(runId: string) {
    return [...this.active.values()].filter((handle) => handle.runId === runId);
  }

  listProgress(workspacePath: string, objectiveId: string | null) {
    return [...this.active.values()]
      .filter((handle) => handle.workspacePath === workspacePath && (!objectiveId || handle.objectiveId === objectiveId))
      .map(
        (handle): ActiveWorkerProgressRecord => ({
          runId: handle.runId,
          workItemId: handle.task.id,
          objectiveId: handle.objectiveId,
          title: handle.task.title,
          executor: handle.task.executor ?? "builder",
          status: handle.task.status,
          summary: handle.task.title,
          oracleSessionSlug: handle.task.oracleSessionSlug,
          worktreePath: handle.task.worktreePath,
          updatedAt: handle.startedAt
        })
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async waitForNext(runId: string, timeoutMs = 1_000) {
    const alreadyResolved = this.listByRun(runId).find((handle) => handle.resolved !== undefined && !handle.reported);
    if (alreadyResolved) {
      alreadyResolved.reported = true;
      return {
        handle: alreadyResolved,
        result: alreadyResolved.resolved as Result
      };
    }

    const handles = this.listByRun(runId).filter((handle) => !handle.reported);
    if (handles.length === 0) {
      return null;
    }

    const completion = Promise.race(
      handles.map(async (handle) => {
        const result = await handle.resultPromise;
        return { handle, result };
      })
    );

    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });
    const settled = await Promise.race([completion, timeout]);

    if (!settled) {
      return null;
    }

    settled.handle.reported = true;
    settled.handle.resolved = settled.result;
    return settled;
  }

  complete(handle: ActiveTaskHandle<Result>) {
    this.active.delete(handle.key);
  }

  terminateRun(runId: string) {
    for (const handle of this.listByRun(runId)) {
      handle.terminate();
    }
  }

  private buildKey(workspacePath: string, runId: string, taskId: string) {
    return `${workspacePath}::${runId}::${taskId}`;
  }
}
