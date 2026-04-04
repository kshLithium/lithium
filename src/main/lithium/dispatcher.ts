import type {
  BranchRecord,
  ObjectiveRecord,
  RunRecord,
  TaskOutcome,
  TaskRecord,
  WorkerRunRecord,
  WorktreeLeaseRecord
} from "../../shared/types";
import { ContextBuilder } from "./context-builder";
import type { ProviderHandle, TaskProvider } from "./providers/types";

export type ActiveTaskHandle = {
  task: TaskRecord;
  run: RunRecord;
  objective: ObjectiveRecord;
  branch: BranchRecord | null;
  workerRun: WorkerRunRecord;
  lease?: WorktreeLeaseRecord;
  terminate: (signal?: NodeJS.Signals) => void;
};

export type TaskCompletion = {
  handle: ActiveTaskHandle;
  outcome: TaskOutcome;
};

export class Dispatcher {
  private readonly active = new Map<string, ActiveTaskHandle>();
  private readonly completions: TaskCompletion[] = [];

  constructor(
    private readonly deps: {
      providers: TaskProvider[];
      contextBuilder: ContextBuilder;
    }
  ) {}

  async start(input: {
    workspacePath: string;
    objective: ObjectiveRecord;
    branch: BranchRecord | null;
    run: RunRecord;
    task: TaskRecord;
  }) {
    const provider = this.resolveProvider(input.task);
    const contextText = await this.deps.contextBuilder.build({
      workspacePath: input.workspacePath,
      objective: input.objective,
      branch: input.branch,
      run: input.run,
      task: input.task
    });
    const handle = await provider.start({
      workspacePath: input.workspacePath,
      objective: input.objective,
      branch: input.branch,
      run: input.run,
      task: input.task,
      contextText
    });
    this.registerHandle({
      task: input.task,
      run: input.run,
      objective: input.objective,
      branch: input.branch,
      workerRun: handle.workerRun,
      lease: handle.lease,
      terminate: handle.terminate
    }, handle);
    return handle;
  }

  async recover(input: {
    workspacePath: string;
    objective: ObjectiveRecord;
    branch: BranchRecord | null;
    run: RunRecord;
    task: TaskRecord;
    workerRun: WorkerRunRecord;
    lease?: WorktreeLeaseRecord | null;
  }) {
    const provider = this.resolveProvider(input.task);
    if (!provider.recover) {
      return null;
    }
    const contextText = await this.deps.contextBuilder.build({
      workspacePath: input.workspacePath,
      objective: input.objective,
      branch: input.branch,
      run: input.run,
      task: input.task
    });
    const handle = await provider.recover({
      workspacePath: input.workspacePath,
      objective: input.objective,
      branch: input.branch,
      run: input.run,
      task: input.task,
      contextText,
      workerRun: input.workerRun,
      lease: input.lease ?? undefined
    });
    if (!handle) {
      return null;
    }
    this.registerHandle({
      task: input.task,
      run: input.run,
      objective: input.objective,
      branch: input.branch,
      workerRun: input.workerRun,
      lease: input.lease ?? undefined,
      terminate: handle.terminate
    }, handle);
    return handle;
  }

  listActive(runId?: string) {
    const values = [...this.active.values()];
    return runId ? values.filter((entry) => entry.run.id === runId) : values;
  }

  drainCompletions() {
    return this.completions.splice(0, this.completions.length);
  }

  terminateRun(runId: string) {
    for (const handle of this.listActive(runId)) {
      handle.terminate();
    }
  }

  completeTask(taskId: string) {
    this.active.delete(taskId);
  }

  patchActive(taskId: string, next: Partial<Pick<ActiveTaskHandle, "task" | "run" | "branch" | "workerRun" | "lease">>) {
    const current = this.active.get(taskId);
    if (!current) {
      return;
    }
    this.active.set(taskId, {
      ...current,
      ...next
    });
  }

  private registerHandle(activeHandle: ActiveTaskHandle, handle: ProviderHandle) {
    this.active.set(activeHandle.task.id, activeHandle);
    handle.result
      .then((outcome) => {
        this.completions.push({
          handle: activeHandle,
          outcome
        });
      })
      .catch((error) => {
        this.completions.push({
          handle: activeHandle,
          outcome: {
            status: "failed",
            summary: error instanceof Error ? error.message : String(error),
            failureReason: error instanceof Error ? error.stack ?? error.message : String(error),
            retryability: "retryable",
            artifactRefs: [],
            changedFiles: [],
            metrics: []
          }
        });
      });
  }

  private resolveProvider(task: TaskRecord) {
    const provider = this.deps.providers.find((entry) => entry.supports(task.kind));
    if (!provider) {
      throw new Error(`No provider is registered for task kind ${task.kind}.`);
    }
    return provider;
  }
}
