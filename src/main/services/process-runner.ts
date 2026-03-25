import { appendFile } from "node:fs/promises";
import type { CommandSpec } from "../../shared/types";
import { appendHeadTailBuffer, prepareTextFiles } from "./fs-utils";
import { startProcessSession, type ProcessSessionResult } from "./command-session";

export type CommandResult = ProcessSessionResult & {
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

const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;

export async function startCommand(options: RunCommandOptions): Promise<CommandSession> {
  const { spec, timeoutMs, stdoutPath, stderrPath, env } = options;
  await prepareTextFiles([stdoutPath, stderrPath]);

  let stdout = "";
  let stderr = "";
  let appendQueue = Promise.resolve();

  const enqueueAppend = (targetPath: string, text: string) => {
    appendQueue = appendQueue
      .then(() => appendFile(targetPath, text, "utf8"))
      .catch(() => undefined);
  };

  const flushAppends = async () => {
    await appendQueue.catch(() => undefined);
  };

  const session = startProcessSession({
    spec,
    timeoutMs,
    env,
    onBeforeResolve: flushAppends,
    onStdout: (text) => {
      stdout = appendHeadTailBuffer(stdout, text, MAX_CAPTURED_OUTPUT_BYTES);
      enqueueAppend(stdoutPath, text);
    },
    onStderr: (text) => {
      stderr = appendHeadTailBuffer(stderr, text, MAX_CAPTURED_OUTPUT_BYTES);
      enqueueAppend(stderrPath, text);
    }
  });
  const result = session.result.then((payload) => ({
    ...payload,
    stdout,
    stderr
  }));

  return {
    pid: session.pid,
    startedAt: session.startedAt,
    result,
    terminate: session.terminate
  };
}

export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const session = await startCommand(options);
  return await session.result;
}
