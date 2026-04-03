import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type IPty } from "node-pty";
import type { RecordStatus } from "../../shared/types";
import { buildLiveResourceKey } from "./live-resource-key";
import { prepareInteractiveShellLaunch } from "./interactive-shell-launch";
import { stripShellOutputMarkers } from "./shell-output-markers";
import { endWriteStream } from "./fs-utils";

type StartLiveShellOptions = {
  id: string;
  workspacePath: string;
  cwd: string;
  transcriptPath: string;
  cols: number;
  rows: number;
  shell?: string;
  bootstrapCommand?: string;
};

type LiveShellHandle = {
  id: string;
  workspacePath: string;
  pid: number | null;
  shell: string;
  shellPath: string;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: string;
};

type LiveShellState = LiveShellHandle & {
  pty: IPty;
  transcriptStream: WriteStream;
  cleanupShellLaunch: () => Promise<void>;
  pendingMarker: string;
  requestedExitStatus: RecordStatus | null;
};

const TERMINAL_ENV = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor"
} satisfies NodeJS.ProcessEnv;

const activeShells = new Map<string, LiveShellState>();

export async function startLiveShell(options: StartLiveShellOptions): Promise<LiveShellHandle> {
  const launch = await prepareInteractiveShellLaunch(options.shell);
  const registryKey = buildLiveResourceKey(options.workspacePath, options.id);
  await mkdir(path.dirname(options.transcriptPath), { recursive: true });
  await writeFile(options.transcriptPath, "", "utf8");
  const transcriptStream = createWriteStream(options.transcriptPath, { flags: "a" });
  const startedAt = new Date().toISOString();
  const pty = spawn(launch.command, launch.args, {
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: {
      ...process.env,
      ...TERMINAL_ENV,
      ...launch.env
    },
    name: TERMINAL_ENV.TERM
  });
  const state: LiveShellState = {
    id: options.id,
    workspacePath: options.workspacePath,
    pid: pty.pid ?? null,
    pty,
    shell: launch.label,
    shellPath: launch.command,
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    startedAt,
    transcriptStream,
    cleanupShellLaunch: launch.cleanup,
    pendingMarker: "",
    requestedExitStatus: null
  };

  pty.onData((chunk) => {
    const parsed = stripShellOutputMarkers(chunk, state.pendingMarker);
    state.pendingMarker = parsed.pending;

    if (parsed.cwd && parsed.cwd !== state.cwd) {
      state.cwd = parsed.cwd;
    }

    if (parsed.output) {
      state.transcriptStream.write(parsed.output);
    }
  });

  pty.onExit(() => {
    void finalizeLiveShell(state);
  });

  activeShells.set(registryKey, state);

  if (options.bootstrapCommand?.trim()) {
    queueMicrotask(() => {
      const active = activeShells.get(registryKey);

      if (!active) {
        return;
      }

      active.pty.write(`${options.bootstrapCommand?.trim()}\r`);
    });
  }

  return toLiveShellHandle(state);
}

export function getLiveShell(workspacePath: string, id: string): LiveShellHandle | null {
  const state = activeShells.get(buildLiveResourceKey(workspacePath, id));
  return state ? toLiveShellHandle(state) : null;
}

export function writeToLiveShell(workspacePath: string, id: string, data: string) {
  const state = activeShells.get(buildLiveResourceKey(workspacePath, id));

  if (!state) {
    return false;
  }

  state.pty.write(data);
  return true;
}

export function stopLiveShell(workspacePath: string, id: string) {
  const state = activeShells.get(buildLiveResourceKey(workspacePath, id));

  if (!state) {
    return false;
  }

  state.requestedExitStatus = "cancelled";
  state.pty.kill("SIGTERM");
  return true;
}

export function stopAllLiveShells() {
  for (const state of activeShells.values()) {
    state.requestedExitStatus = "cancelled";

    try {
      state.pty.kill("SIGTERM");
    } catch {
      // Ignore races with already-exited shells.
    }
  }
}

async function finalizeLiveShell(state: LiveShellState) {
  activeShells.delete(buildLiveResourceKey(state.workspacePath, state.id));
  await endWriteStream(state.transcriptStream).catch(() => undefined);
  await state.cleanupShellLaunch().catch(() => undefined);
}

function toLiveShellHandle(state: LiveShellState): LiveShellHandle {
  return {
    id: state.id,
    workspacePath: state.workspacePath,
    pid: state.pid,
    shell: state.shell,
    shellPath: state.shellPath,
    cwd: state.cwd,
    cols: state.cols,
    rows: state.rows,
    startedAt: state.startedAt
  };
}
