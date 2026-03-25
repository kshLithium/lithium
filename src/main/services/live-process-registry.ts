import { createWriteStream } from "node:fs";
import type { CommandSpec } from "../../shared/types";
import type { CommandResult } from "./process-runner";
import {
  appendTailBuffer,
  endWriteStream,
  prepareTextFilesSync,
  readTextFileIfExists,
  statIfExists
} from "./fs-utils";
import { buildLiveResourceKey } from "./live-resource-key";
import { readTailText } from "./run-artifacts";
import { startProcessSession } from "./command-session";

export type LiveProcessHandle = {
  id: string;
  workspacePath: string;
  pid: number | null;
  spec: CommandSpec;
  stdoutPath: string;
  stderrPath: string;
  outputPath?: string;
  startedAt: string;
  done: Promise<CommandResult>;
};

type StartLiveProcessOptions = {
  id: string;
  workspacePath: string;
  spec: CommandSpec;
  stdoutPath: string;
  stderrPath: string;
  outputPath?: string;
  timeoutMs?: number | null;
  env?: NodeJS.ProcessEnv;
};

type LiveProcessState = {
  id: string;
  workspacePath: string;
  child: ReturnType<typeof startProcessSession>["child"];
  terminate: ReturnType<typeof startProcessSession>["terminate"];
  spec: CommandSpec;
  stdoutPath: string;
  stderrPath: string;
  outputPath?: string;
  startedAt: string;
  done: Promise<CommandResult>;
};

const activeProcesses = new Map<string, LiveProcessState>();
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;

export function startLiveProcess(options: StartLiveProcessOptions): LiveProcessHandle {
  const registryKey = buildLiveResourceKey(options.workspacePath, options.id);
  prepareTextFilesSync([options.stdoutPath, options.stderrPath]);
  let stdout = "";
  let stderr = "";

  const stdoutStream = createWriteStream(options.stdoutPath, { flags: "a" });
  const stderrStream = createWriteStream(options.stderrPath, { flags: "a" });
  const session = startProcessSession({
    spec: options.spec,
    timeoutMs: options.timeoutMs,
    env: options.env,
    onBeforeResolve: async () => {
      activeProcesses.delete(registryKey);
      await Promise.all([
        endWriteStream(stdoutStream),
        endWriteStream(stderrStream)
      ]);
    },
    onStdout: (text) => {
      stdout = appendTailBuffer(stdout, text, MAX_CAPTURED_OUTPUT_BYTES);
      stdoutStream.write(text);
    },
    onStderr: (text) => {
      stderr = appendTailBuffer(stderr, text, MAX_CAPTURED_OUTPUT_BYTES);
      stderrStream.write(text);
    }
  });
  const done = session.result.then((payload) => ({
    ...payload,
    stdout,
    stderr
  }));

  activeProcesses.set(registryKey, {
    id: options.id,
    workspacePath: options.workspacePath,
    child: session.child,
    terminate: session.terminate,
    spec: options.spec,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    outputPath: options.outputPath,
    startedAt: session.startedAt,
    done
  });

  return {
    id: options.id,
    workspacePath: options.workspacePath,
    pid: session.pid,
    spec: options.spec,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    outputPath: options.outputPath,
    startedAt: session.startedAt,
    done
  };
}

export function getLiveProcess(workspacePath: string, id: string) {
  const state = activeProcesses.get(buildLiveResourceKey(workspacePath, id));

  if (!state) {
    return null;
  }

  return {
    id: state.id,
    workspacePath: state.workspacePath,
    pid: state.child.pid ?? null,
    spec: state.spec,
    stdoutPath: state.stdoutPath,
    stderrPath: state.stderrPath,
    outputPath: state.outputPath,
    startedAt: state.startedAt,
    done: state.done
  } satisfies LiveProcessHandle;
}

export function stopLiveProcess(workspacePath: string, id: string) {
  const state = activeProcesses.get(buildLiveResourceKey(workspacePath, id));

  if (!state) {
    return false;
  }

  state.terminate("SIGTERM");
  return true;
}

export function stopAllLiveProcesses() {
  for (const state of activeProcesses.values()) {
    state.terminate("SIGTERM");
  }
}

export async function inspectLiveProcessFiles(input: {
  stdoutPath: string;
  stderrPath: string;
  outputPath?: string;
  stdoutTailBytes?: number;
  stderrTailBytes?: number;
  outputTailBytes?: number;
}) {
  const stdout =
    typeof input.stdoutTailBytes === "number" && input.stdoutTailBytes > 0
      ? await readTailText(input.stdoutPath, input.stdoutTailBytes).catch(() => "")
      : await readMaybe(input.stdoutPath);
  const stderr =
    typeof input.stderrTailBytes === "number" && input.stderrTailBytes > 0
      ? await readTailText(input.stderrPath, input.stderrTailBytes).catch(() => "")
      : await readMaybe(input.stderrPath);
  const outputText =
    input.outputPath
      ? typeof input.outputTailBytes === "number" && input.outputTailBytes > 0
        ? await readTailText(input.outputPath, input.outputTailBytes).catch(() => "")
        : await readMaybe(input.outputPath)
      : "";
  const timestamps = await Promise.all([
    statMaybe(input.stdoutPath),
    statMaybe(input.stderrPath),
    input.outputPath ? statMaybe(input.outputPath) : Promise.resolve(null)
  ]);
  const lastTouched = timestamps
    .map((item) => item?.mtimeMs ?? 0)
    .reduce((max, value) => Math.max(max, value), 0);

  return {
    stdout,
    stderr,
    outputText,
    lastTouched
  };
}

async function readMaybe(filePath: string) {
  return await readTextFileIfExists(filePath);
}

async function statMaybe(filePath: string) {
  return await statIfExists(filePath);
}
