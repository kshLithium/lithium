import { EventEmitter } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type IPty } from "node-pty";
import type { RecordStatus, TerminalEvent } from "../../shared/types";
import { buildLiveResourceKey } from "./live-resource-key";
import { stripTerminalMarkers } from "./terminal-pty-markers";
import { prepareInteractiveShellLaunch } from "./terminal-shell-launch";

type StartLiveTerminalOptions = {
  id: string;
  workspacePath: string;
  cwd: string;
  transcriptPath: string;
  cols: number;
  rows: number;
  shell?: string;
  bootstrapCommand?: string;
};

type LiveTerminalHandle = {
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

type LiveTerminalState = LiveTerminalHandle & {
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

const terminalEvents = new EventEmitter();
const activeTerminals = new Map<string, LiveTerminalState>();

export function onLiveTerminalEvent(listener: (event: TerminalEvent) => void) {
  terminalEvents.on("event", listener);

  return () => {
    terminalEvents.off("event", listener);
  };
}

export async function startLiveTerminal(options: StartLiveTerminalOptions): Promise<LiveTerminalHandle> {
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
  const state: LiveTerminalState = {
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
    const parsed = stripTerminalMarkers(chunk, state.pendingMarker);
    state.pendingMarker = parsed.pending;

    if (parsed.cwd && parsed.cwd !== state.cwd) {
      state.cwd = parsed.cwd;
      emitTerminalEvent({
        type: "cwd",
        workspacePath: state.workspacePath,
        sessionId: state.id,
        cwd: parsed.cwd
      });
    }

    if (parsed.output) {
      state.transcriptStream.write(parsed.output);
      emitTerminalEvent({
        type: "data",
        workspacePath: state.workspacePath,
        sessionId: state.id,
        data: parsed.output
      });
    }
  });

  pty.onExit(({ exitCode }) => {
    void finalizeLiveTerminal(state, exitCode);
  });

  activeTerminals.set(registryKey, state);

  if (options.bootstrapCommand?.trim()) {
    queueMicrotask(() => {
      const active = activeTerminals.get(registryKey);

      if (!active) {
        return;
      }

      active.pty.write(`${options.bootstrapCommand?.trim()}\r`);
    });
  }

  return toLiveTerminalHandle(state);
}

export function getLiveTerminal(workspacePath: string, id: string): LiveTerminalHandle | null {
  const state = activeTerminals.get(buildLiveResourceKey(workspacePath, id));
  return state ? toLiveTerminalHandle(state) : null;
}

export function writeToLiveTerminal(workspacePath: string, id: string, data: string) {
  const state = activeTerminals.get(buildLiveResourceKey(workspacePath, id));

  if (!state) {
    return false;
  }

  state.pty.write(data);
  return true;
}

export function resizeLiveTerminal(workspacePath: string, id: string, cols: number, rows: number) {
  const state = activeTerminals.get(buildLiveResourceKey(workspacePath, id));

  if (!state) {
    return null;
  }

  state.cols = cols;
  state.rows = rows;
  state.pty.resize(cols, rows);
  return toLiveTerminalHandle(state);
}

export function stopLiveTerminal(workspacePath: string, id: string) {
  const state = activeTerminals.get(buildLiveResourceKey(workspacePath, id));

  if (!state) {
    return false;
  }

  state.requestedExitStatus = "cancelled";
  state.pty.kill("SIGTERM");
  return true;
}

export function stopAllLiveTerminals() {
  for (const state of activeTerminals.values()) {
    state.requestedExitStatus = "cancelled";

    try {
      state.pty.kill("SIGTERM");
    } catch {
      // Ignore races with already-exited terminals.
    }
  }
}

async function finalizeLiveTerminal(state: LiveTerminalState, exitCode: number) {
  activeTerminals.delete(buildLiveResourceKey(state.workspacePath, state.id));
  state.transcriptStream.end();
  await state.cleanupShellLaunch().catch(() => undefined);

  emitTerminalEvent({
    type: "exit",
    workspacePath: state.workspacePath,
    sessionId: state.id,
    status: state.requestedExitStatus ?? (exitCode === 0 ? "completed" : "failed"),
    exitCode,
    endedAt: new Date().toISOString()
  });
}

function emitTerminalEvent(event: TerminalEvent) {
  terminalEvents.emit("event", event);
}

function toLiveTerminalHandle(state: LiveTerminalState): LiveTerminalHandle {
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
