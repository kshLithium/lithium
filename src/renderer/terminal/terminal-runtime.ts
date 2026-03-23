import type {
  LithiumApi,
  TerminalEvent as SharedTerminalEvent,
  TerminalSessionState
} from "../../shared/types";

export type TerminalSessionSnapshot = TerminalSessionState;

export type TerminalEvent =
  | {
      type: "data";
      workspacePath: string;
      sessionId: string;
      data: string;
    }
  | {
      type: "cwd";
      workspacePath: string;
      sessionId: string;
      cwd: string;
    }
  | {
      type: "exit";
      workspacePath: string;
      sessionId: string;
      exitCode: number | null;
    };

type TerminalBridge = Pick<
  LithiumApi,
  | "createTerminalSession"
  | "writeTerminalInput"
  | "resizeTerminalSession"
  | "closeTerminalSession"
  | "getTerminalSession"
  | "onTerminalEvent"
>;

export function getTerminalBridge() {
  const bridge = (window as Window & { lithium?: LithiumApi }).lithium;

  if (!bridge) {
    throw new Error("Lithium bridge is not available.");
  }

  return bridge as TerminalBridge;
}

export function normalizeTerminalEvent(event: SharedTerminalEvent | unknown): TerminalEvent | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const value = event as Record<string, unknown>;
  const candidate = value.sessionId ?? value.sessionID ?? value.id;
  const workspacePath = value.workspacePath;

  if (
    typeof candidate !== "string" ||
    !candidate.trim() ||
    typeof workspacePath !== "string" ||
    !workspacePath.trim()
  ) {
    return null;
  }

  if (value.type === "data" && typeof value.data === "string" && value.data) {
    return {
      type: "data",
      workspacePath,
      sessionId: candidate,
      data: value.data
    };
  }

  if (value.type === "cwd" && typeof value.cwd === "string" && value.cwd) {
    return {
      type: "cwd",
      workspacePath,
      sessionId: candidate,
      cwd: value.cwd
    };
  }

  if (value.type === "exit") {
    return {
      type: "exit",
      workspacePath,
      sessionId: candidate,
      exitCode: typeof value.exitCode === "number" ? value.exitCode : null
    };
  }

  return null;
}
