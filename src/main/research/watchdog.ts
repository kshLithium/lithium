import type { ResearchRunRecord } from "../../shared/types";
import type { ActiveTaskHandle } from "./runtime-registry";

export class ResearchWatchdog<Result> {
  async enforce(run: ResearchRunRecord, activeTasks: ActiveTaskHandle<Result>[]) {
    const now = Date.now();
    const timedOut: ActiveTaskHandle<Result>[] = [];

    for (const handle of activeTasks) {
      if (!handle.deadlineAt) {
        continue;
      }

      if (Date.parse(handle.deadlineAt) <= now) {
        handle.terminate();
        timedOut.push(handle);
      }
    }

    return {
      runId: run.id,
      timedOut
    };
  }
}
