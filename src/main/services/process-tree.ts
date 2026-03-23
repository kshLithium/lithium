import { spawn } from "node:child_process";

type TerminateProcessTreeOptions = {
  expectedCommandIncludes?: string[];
  graceMs?: number;
};

type PsEntry = {
  pid: number;
  ppid: number;
};

export type ProcessTreeTerminationResult = {
  matched: boolean;
  terminated: boolean;
  rootCommand: string;
  signaledPids: number[];
  forceKilledPids: number[];
};

const DEFAULT_GRACE_MS = 1_000;

export async function terminateProcessTree(
  rootPid: number,
  options: TerminateProcessTreeOptions = {}
): Promise<ProcessTreeTerminationResult> {
  if (!Number.isFinite(rootPid) || rootPid <= 0) {
    return {
      matched: false,
      terminated: false,
      rootCommand: "",
      signaledPids: [],
      forceKilledPids: []
    };
  }

  if (process.platform === "win32") {
    return await terminateProcessTreeWindows(rootPid);
  }

  const rootCommand = await readProcessCommand(rootPid);

  if (!rootCommand) {
    return {
      matched: false,
      terminated: false,
      rootCommand: "",
      signaledPids: [],
      forceKilledPids: []
    };
  }

  const expectedSnippets = (options.expectedCommandIncludes ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (expectedSnippets.length > 0 && !expectedSnippets.some((entry) => rootCommand.includes(entry))) {
    return {
      matched: false,
      terminated: false,
      rootCommand,
      signaledPids: [],
      forceKilledPids: []
    };
  }

  const targetPids = await listProcessTreePids(rootPid);
  const orderedTargets = [...targetPids].reverse();
  const signaledPids = signalProcesses(orderedTargets, "SIGTERM");

  await sleep(options.graceMs ?? DEFAULT_GRACE_MS);

  const survivors = await filterLivePids(targetPids);
  const orderedSurvivors = [...survivors].reverse();
  const forceKilledPids = signalProcesses(orderedSurvivors, "SIGKILL");

  if (forceKilledPids.length > 0) {
    await sleep(250);
  }

  return {
    matched: true,
    terminated: signaledPids.length > 0 || forceKilledPids.length > 0,
    rootCommand,
    signaledPids,
    forceKilledPids
  };
}

export async function readProcessCommand(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return "";
  }

  if (process.platform === "win32") {
    const output = await execFileText("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
    ]).catch(() => "");
    return output.trim();
  }

  const output = await execFileText("ps", ["-p", String(pid), "-o", "command="]).catch(() => "");
  return output.trim();
}

export async function isProcessAlive(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listProcessTreePids(rootPid: number) {
  const psOutput =
    process.platform === "win32"
      ? await execFileText("powershell", [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"
        ]).catch(() => "")
      : await execFileText("ps", ["axo", "pid=,ppid="]).catch(() => "");
  const entries = parsePsEntries(psOutput);
  const childrenByParent = new Map<number, number[]>();

  for (const entry of entries) {
    const siblings = childrenByParent.get(entry.ppid) ?? [];
    siblings.push(entry.pid);
    childrenByParent.set(entry.ppid, siblings);
  }

  const visited = new Set<number>();
  const queue = [rootPid];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);

    for (const childPid of childrenByParent.get(current) ?? []) {
      if (!visited.has(childPid)) {
        queue.push(childPid);
      }
    }
  }

  if (visited.size === 0 && (await isProcessAlive(rootPid))) {
    visited.add(rootPid);
  }

  return [...visited];
}

function parsePsEntries(output: string): PsEntry[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .map(([pidText, ppidText]) => ({
      pid: Number.parseInt(pidText ?? "", 10),
      ppid: Number.parseInt(ppidText ?? "", 10)
    }))
    .filter((entry) => Number.isFinite(entry.pid) && Number.isFinite(entry.ppid));
}

function signalProcesses(pids: number[], signal: NodeJS.Signals) {
  const signaled: number[] = [];

  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signaled.push(pid);
    } catch {
      // Ignore races with already-exited processes.
    }
  }

  return signaled;
}

async function filterLivePids(pids: number[]) {
  const live = await Promise.all(
    pids.map(async (pid) => ({
      pid,
      alive: await isProcessAlive(pid)
    }))
  );

  return live.filter((entry) => entry.alive).map((entry) => entry.pid);
}

async function terminateProcessTreeWindows(rootPid: number): Promise<ProcessTreeTerminationResult> {
  const rootCommand = await readProcessCommand(rootPid);

  if (!rootCommand) {
    return {
      matched: false,
      terminated: false,
      rootCommand: "",
      signaledPids: [],
      forceKilledPids: []
    };
  }

  await execFileText("taskkill", ["/PID", String(rootPid), "/T", "/F"]).catch(() => "");

  return {
    matched: true,
    terminated: true,
    rootCommand,
    signaledPids: [rootPid],
    forceKilledPids: []
  };
}

function execFileText(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
        return;
      }

      resolve(stdout);
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
