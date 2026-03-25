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
    let active =
      typeof document === "undefined"
        ? true
        : !document.hidden && (typeof document.hasFocus !== "function" || document.hasFocus());

    const clearTimer = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = (delayMs: number) => {
      if (!active) {
        return;
      }

      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        void poll();
      }, Math.max(0, delayMs));
    };

    const poll = async () => {
      if (!active) {
        return;
      }

      const nextDelay = await runTask();

      if (cancelled || !active || typeof nextDelay !== "number" || !Number.isFinite(nextDelay)) {
        return;
      }

      schedule(nextDelay);
    };

    const refreshActivity = () => {
      active =
        typeof document === "undefined"
          ? true
          : !document.hidden && (typeof document.hasFocus !== "function" || document.hasFocus());

      if (active && timer == null && !cancelled) {
        void poll();
        return;
      }

      if (!active) {
        clearTimer();
      }
    };

    if (typeof options.initialDelayMs === "number" && Number.isFinite(options.initialDelayMs)) {
      schedule(options.initialDelayMs);
    } else {
      void poll();
    }

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", refreshActivity);
      window.addEventListener("focus", refreshActivity);
      window.addEventListener("blur", refreshActivity);
    }

    return () => {
      cancelled = true;
      clearTimer();

      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", refreshActivity);
        window.removeEventListener("focus", refreshActivity);
        window.removeEventListener("blur", refreshActivity);
      }
    };
  }, [options.enabled, options.initialDelayMs, ...options.deps]);
}
