import type { ActiveWorkerProgressRecord, ResearchWorkItemRecord } from "../../shared/types";

export class ProgressRegistry {
  private readonly activeProgress = new Map<string, ActiveWorkerProgressRecord>();

  set(workspacePath: string, runId: string, objectiveId: string, workItem: ResearchWorkItemRecord) {
    const key = this.buildKey(workspacePath, runId, workItem.id);
    this.activeProgress.set(key, {
      runId,
      workItemId: workItem.id,
      objectiveId,
      title: workItem.title,
      executor: workItem.executor ?? "builder-edit",
      status: "running",
      summary: workItem.title,
      oracleSessionSlug: workItem.oracleSessionSlug,
      worktreePath: workItem.worktreePath,
      updatedAt: new Date().toISOString()
    });
  }

  clear(workspacePath: string, runId: string, workItemId: string) {
    this.activeProgress.delete(this.buildKey(workspacePath, runId, workItemId));
  }

  list(workspacePath: string, objectiveId: string | null) {
    return Array.from(this.activeProgress.entries())
      .filter(([key, value]) => key.startsWith(`${workspacePath}::`) && (!objectiveId || value.objectiveId === objectiveId))
      .map(([, value]) => value)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private buildKey(workspacePath: string, runId: string, workItemId: string) {
    return `${workspacePath}::${runId}::${workItemId}`;
  }
}
