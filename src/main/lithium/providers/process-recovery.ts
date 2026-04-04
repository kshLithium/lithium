import { kill } from "node:process";
import { terminateProcessTree } from "../../services/process-tree";

export async function isPidAlive(pid: number | null | undefined) {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPidExit(pid: number, pollMs = 500) {
  while (await isPidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function terminateByPid(pid: number | null | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!pid || pid <= 0) {
    return;
  }

  void terminateProcessTree(pid).catch(() => {
    try {
      kill(pid, signal);
    } catch {
      // Ignore races with exited processes.
    }
  });
}
