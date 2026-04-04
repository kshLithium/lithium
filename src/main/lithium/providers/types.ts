import type {
  BranchRecord,
  ObjectiveRecord,
  RunRecord,
  TaskOutcome,
  TaskRecord,
  WorkerRunRecord,
  WorktreeLeaseRecord
} from "../../../shared/types";

export type ProviderContext = {
  workspacePath: string;
  objective: ObjectiveRecord;
  branch: BranchRecord | null;
  run: RunRecord;
  task: TaskRecord;
  contextText: string;
};

export type ProviderRecoveryContext = ProviderContext & {
  workerRun: WorkerRunRecord;
  lease?: WorktreeLeaseRecord | null;
};

export type ProviderHandle = {
  workerRun: WorkerRunRecord;
  lease?: WorktreeLeaseRecord;
  terminate: (signal?: NodeJS.Signals) => void;
  result: Promise<TaskOutcome>;
};

export interface TaskProvider {
  supports(kind: TaskRecord["kind"]): boolean;
  start(context: ProviderContext): Promise<ProviderHandle>;
  recover?(context: ProviderRecoveryContext): Promise<ProviderHandle | null>;
}
