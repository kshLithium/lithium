import { useEffect, useEffectEvent } from "react";

type UsePollingTaskOptions = {
  deps: ReadonlyArray<unknown>;
  enabled: boolean;
  initialDelayMs?: number;
  task: () => Promise<number | null | void> | number | null | void;
};

export function usePollingTask(options: UsePollingTaskOptions) {
  const runTask = useEffectEvent(options.task);

  useEffect(() => {
    if (!options.enabled) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = (delayMs: number) => {
      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        void poll();
      }, Math.max(0, delayMs));
    };

    const poll = async () => {
      const nextDelay = await runTask();

      if (cancelled || typeof nextDelay !== "number" || !Number.isFinite(nextDelay)) {
        return;
      }

      schedule(nextDelay);
    };

    if (typeof options.initialDelayMs === "number" && Number.isFinite(options.initialDelayMs)) {
      schedule(options.initialDelayMs);
    } else {
      void poll();
    }

    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [options.enabled, options.initialDelayMs, ...options.deps]);
}
