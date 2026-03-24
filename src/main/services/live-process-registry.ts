import { createWriteStream, mkdirSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { CommandSpec } from "../../shared/types";
import type { CommandResult } from "./process-runner";
import { buildLiveResourceKey } from "./live-resource-key";
import { terminateProcessTree } from "./process-tree";

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
  child: ChildProcessByStdio<null, Readable, Readable>;
  spec: CommandSpec;
  stdoutPath: string;
  stderrPath: string;
  outputPath?: string;
  startedAt: string;
  done: Promise<CommandResult>;
};

const activeProcesses = new Map<string, LiveProcessState>();

export function startLiveProcess(options: StartLiveProcessOptions): LiveProcessHandle {
  const startedAt = new Date().toISOString();
  const registryKey = buildLiveResourceKey(options.workspacePath, options.id);
  mkdirSync(path.dirname(options.stdoutPath), { recursive: true });
  mkdirSync(path.dirname(options.stderrPath), { recursive: true });
  const child = spawn(options.spec.command, options.spec.args, {
    cwd: options.spec.cwd,
    env: {
      ...process.env,
      ...options.env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;

  const stdoutReady = mkdir(path.dirname(options.stdoutPath), { recursive: true }).then(() =>
    writeFile(options.stdoutPath, "", "utf8")
  );
  const stderrReady = mkdir(path.dirname(options.stderrPath), { recursive: true }).then(() =>
    writeFile(options.stderrPath, "", "utf8")
  );

  const stdoutStream = createWriteStream(options.stdoutPath, { flags: "a" });
  const stderrStream = createWriteStream(options.stderrPath, { flags: "a" });

  const done = new Promise<CommandResult>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;

    const finish = async (result: Omit<CommandResult, "startedAt">) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      activeProcesses.delete(registryKey);

      try {
        await stdoutReady;
        await stderrReady;
        await writeFile(options.stdoutPath, stdout, "utf8");
        await writeFile(options.stderrPath, stderr, "utf8");
      } catch (error) {
        reject(error);
        return;
      } finally {
        stdoutStream.end();
        stderrStream.end();
      }

      resolve({
        startedAt,
        ...result
      });
    };

    const normalizedTimeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : null;

    if (normalizedTimeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(child.pid ?? -1).catch(() => undefined);
      }, normalizedTimeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutStream.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrStream.write(text);
    });

    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      void finish({
        endedAt: new Date().toISOString(),
        exitCode: null,
        timedOut,
        stdout,
        stderr
      });
    });

    child.on("close", (code) => {
      void finish({
        endedAt: new Date().toISOString(),
        exitCode: code,
        timedOut,
        stdout,
        stderr
      });
    });
  });

  activeProcesses.set(registryKey, {
    id: options.id,
    workspacePath: options.workspacePath,
    child,
    spec: options.spec,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    outputPath: options.outputPath,
    startedAt,
    done
  });

  return {
    id: options.id,
    workspacePath: options.workspacePath,
    pid: child.pid ?? null,
    spec: options.spec,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    outputPath: options.outputPath,
    startedAt,
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

  void terminateProcessTree(state.child.pid ?? -1).catch(() => {
    try {
      state.child.kill("SIGTERM");
    } catch {
      // Ignore races with already-exited children.
    }
  });
  return true;
}

export async function inspectLiveProcessFiles(input: {
  stdoutPath: string;
  stderrPath: string;
  outputPath?: string;
}) {
  const stdout = await readMaybe(input.stdoutPath);
  const stderr = await readMaybe(input.stderrPath);
  const outputText = input.outputPath ? await readMaybe(input.outputPath) : "";
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
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function statMaybe(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}
