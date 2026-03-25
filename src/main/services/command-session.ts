import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { CommandSpec } from "../../shared/types";
import { terminateProcessTree } from "./process-tree";

export type ProcessSessionResult = {
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  timedOut: boolean;
};

export type ProcessSession = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  pid: number | null;
  startedAt: string;
  result: Promise<ProcessSessionResult>;
  terminate: (signal?: NodeJS.Signals) => void;
};

type StartProcessSessionOptions = {
  spec: CommandSpec;
  timeoutMs?: number | null;
  env?: NodeJS.ProcessEnv;
  onBeforeResolve?: () => Promise<void> | void;
  onStderr?: (text: string) => void;
  onStdout?: (text: string) => void;
};

export function startProcessSession(options: StartProcessSessionOptions): ProcessSession {
  const startedAt = new Date().toISOString();
  const child = spawn(options.spec.command, options.spec.args, {
    cwd: options.spec.cwd,
    env: {
      ...process.env,
      ...options.env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let timedOut = false;
  let settled = false;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let resolveResult: (value: ProcessSessionResult) => void = () => undefined;
  let rejectResult: (reason: unknown) => void = () => undefined;

  const result = new Promise<ProcessSessionResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const finalize = async (payload: Omit<ProcessSessionResult, "startedAt">) => {
    if (settled) {
      return;
    }

    settled = true;

    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }

    try {
      await options.onBeforeResolve?.();
      resolveResult({
        startedAt,
        ...payload
      });
    } catch (error) {
      rejectResult(error);
    }
  };

  const normalizedTimeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : null;

  if (normalizedTimeoutMs !== null) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child.pid ?? -1).catch(() => undefined);
    }, normalizedTimeoutMs);
  }

  child.stdout.on("data", (chunk) => {
    options.onStdout?.(chunk.toString());
  });

  child.stderr.on("data", (chunk) => {
    options.onStderr?.(chunk.toString());
  });

  child.on("error", (error) => {
    options.onStderr?.(`${error.message}\n`);
    void finalize({
      endedAt: new Date().toISOString(),
      exitCode: null,
      timedOut
    });
  });

  child.on("close", (code) => {
    void finalize({
      endedAt: new Date().toISOString(),
      exitCode: code,
      timedOut
    });
  });

  return {
    child,
    pid: child.pid ?? null,
    startedAt,
    result,
    terminate: (signal: NodeJS.Signals = "SIGTERM") => {
      if (settled) {
        return;
      }

      void terminateProcessTree(child.pid ?? -1).catch(() => {
        try {
          child.kill(signal);
        } catch {
          // Ignore races with already-exited children.
        }
      });
    }
  };
}
