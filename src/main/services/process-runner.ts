import { appendFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { CommandSpec } from "../../shared/types";
import { terminateProcessTree } from "./process-tree";

export type CommandResult = {
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

export type CommandSession = {
  pid: number | null;
  startedAt: string;
  result: Promise<CommandResult>;
  terminate: (signal?: NodeJS.Signals) => void;
};

type RunCommandOptions = {
  spec: CommandSpec;
  timeoutMs?: number | null;
  stdoutPath: string;
  stderrPath: string;
  env?: NodeJS.ProcessEnv;
};

export async function startCommand(options: RunCommandOptions): Promise<CommandSession> {
  const { spec, timeoutMs, stdoutPath, stderrPath, env } = options;
  const startedAt = new Date().toISOString();
  await Promise.all([writeFile(stdoutPath, "", "utf8"), writeFile(stderrPath, "", "utf8")]);

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;
  let appendQueue = Promise.resolve();
  let forceKillTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const enqueueAppend = (targetPath: string, text: string) => {
    appendQueue = appendQueue
      .then(() => appendFile(targetPath, text, "utf8"))
      .catch(() => undefined);
  };

  const flushAppends = async () => {
    await appendQueue.catch(() => undefined);
  };

  let resolveResult: (value: CommandResult) => void = () => undefined;
  let rejectResult: (reason: unknown) => void = () => undefined;
  const result = new Promise<CommandResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const finalize = async (payload: Omit<CommandResult, "startedAt">) => {
    if (settled) {
      return;
    }

    settled = true;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }

    await flushAppends();
    resolveResult({
      startedAt,
      ...payload
    });
  };

  const normalizedTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;

  if (normalizedTimeoutMs !== null) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child.pid ?? -1).catch(() => undefined);
    }, normalizedTimeoutMs);
  }

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    enqueueAppend(stdoutPath, text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    enqueueAppend(stderrPath, text);
  });

  child.on("error", async (error) => {
    stderr += `${error.message}\n`;
    await finalize({
      endedAt: new Date().toISOString(),
      exitCode: null,
      timedOut,
      stdout,
      stderr
    }).catch(rejectResult);
  });

  child.on("close", (code) => {
    void finalize({
      endedAt: new Date().toISOString(),
      exitCode: code,
      timedOut,
      stdout,
      stderr
    }).catch(rejectResult);
  });

  return {
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

export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const session = await startCommand(options);
  return await session.result;
}
