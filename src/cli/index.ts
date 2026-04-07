#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { AppSettingsStore } from "../main/services/app-settings-store";
import { buildProjectPaths } from "../main/services/workspace-layout";
import { createWorkspaceDaemon } from "../main/lithium/bootstrap";
import { sendRpc, readDaemonPid, waitForDaemonSocket } from "../main/lithium/rpc-client";
import { ResearchStore } from "../main/lithium/store";
import type { StatusSnapshot } from "../shared/types";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const parsed = parseArgs(args);
  const settingsStore = new AppSettingsStore(resolveCliSettingsPath());
  const settings = await settingsStore.read();
  const workspacePath = resolveWorkspacePath(parsed.workspacePath ?? settings.lastWorkspacePath ?? process.cwd());

  if (parsed.commandPath[0] === "daemon" && parsed.commandPath[1] === "serve") {
    await serveDaemon(workspacePath, settingsStore);
    return;
  }

  await settingsStore.update({
    lastWorkspacePath: workspacePath
  });

  switch (parsed.commandPath[0]) {
    case "daemon":
      await handleDaemonCommand(workspacePath, parsed);
      return;
    case "objective":
      await handleObjectiveCommand(workspacePath, parsed);
      return;
    case "run":
      await handleRunCommand(workspacePath, parsed);
      return;
    case "source":
      await handleSourceCommand(workspacePath, parsed);
      return;
    case "status":
      await handleStatusCommand(workspacePath, parsed);
      return;
    case "workspace":
      await handleWorkspaceCommand(workspacePath, parsed);
      return;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

async function handleDaemonCommand(workspacePath: string, parsed: ParsedArgs) {
  switch (parsed.commandPath[1]) {
    case "start":
      if (parsed.flags.foreground) {
        await serveDaemon(workspacePath);
        return;
      }
      await startDaemonInBackground(workspacePath);
      process.stdout.write(`daemon started for ${workspacePath}\n`);
      return;
    case "stop":
      try {
        await sendRpc(workspacePath, "daemon.stop");
        process.stdout.write("daemon stopping\n");
      } catch {
        process.stdout.write("daemon is not running\n");
      }
      return;
    case "status": {
      try {
        const status = await sendRpc(workspacePath, "daemon.status");
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      } catch {
        process.stdout.write(
          `${JSON.stringify(
            {
              running: false,
              pid: await readDaemonPid(workspacePath),
              socketPath: buildProjectPaths(workspacePath).socketPath,
              workspacePath
            },
            null,
            2
          )}\n`
        );
      }
      return;
    }
    default:
      throw new Error("Usage: lithium daemon start|stop|status [--workspace <path>] [--foreground]");
  }
}

async function handleObjectiveCommand(workspacePath: string, parsed: ParsedArgs) {
  await ensureDaemon(workspacePath);
  switch (parsed.commandPath[1]) {
    case "create": {
      const objective = parsed.positionals.join(" ").trim();
      if (!objective) {
        throw new Error("Usage: lithium objective create <goal>");
      }
      const result = await sendRpc(workspacePath, "objective.create", {
        objective,
        title: typeof parsed.flags.title === "string" ? parsed.flags.title : undefined,
        successCriteria: parseRepeatedFlag(parsed.flags.success)
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    case "list": {
      const result = await sendRpc(workspacePath, "objective.list");
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    case "show": {
      const result = await sendRpc(workspacePath, "objective.show", {
        objectiveId: parsed.positionals[0]
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    default:
      throw new Error("Usage: lithium objective create|list|show");
  }
}

async function handleRunCommand(workspacePath: string, parsed: ParsedArgs) {
  await ensureDaemon(workspacePath);
  switch (parsed.commandPath[1]) {
    case "start":
      process.stdout.write(
        `${JSON.stringify(
          await sendRpc(workspacePath, "run.start", {
            objectiveId: readOptionalFlag(parsed.flags.objective)
          }),
          null,
          2
        )}\n`
      );
      return;
    case "pause":
      process.stdout.write(
        `${JSON.stringify(
          await sendRpc(workspacePath, "run.pause", {
            objectiveId: readOptionalFlag(parsed.flags.objective)
          }),
          null,
          2
        )}\n`
      );
      return;
    case "resume":
      process.stdout.write(
        `${JSON.stringify(
          await sendRpc(workspacePath, "run.resume", {
            objectiveId: readOptionalFlag(parsed.flags.objective)
          }),
          null,
          2
        )}\n`
      );
      return;
    case "stop":
      process.stdout.write(
        `${JSON.stringify(
          await sendRpc(workspacePath, "run.stop", {
            objectiveId: readOptionalFlag(parsed.flags.objective),
            runId: readOptionalFlag(parsed.flags.run)
          }),
          null,
          2
        )}\n`
      );
      return;
    case "watch":
      await watchStatus(workspacePath, Number(parsed.flags.interval) || 1000);
      return;
    default:
      throw new Error(
        "Usage: lithium run start|pause|resume [--workspace <path>] [--objective <id>]\n" +
          "       lithium run stop [--workspace <path>] [--objective <id>] [--run <id>]\n" +
          "       lithium run watch [--workspace <path>] [--interval <ms>]"
      );
  }
}

async function handleSourceCommand(workspacePath: string, parsed: ParsedArgs) {
  await ensureDaemon(workspacePath);
  if (parsed.commandPath[1] !== "add" || parsed.positionals.length === 0) {
    throw new Error("Usage: lithium source add <path-or-url...>");
  }
  const result = await sendRpc(workspacePath, "source.add", {
    objectiveId: readOptionalFlag(parsed.flags.objective),
    branchId: readOptionalFlag(parsed.flags.branch),
    inputs: parsed.positionals
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function handleStatusCommand(workspacePath: string, parsed: ParsedArgs) {
  await ensureDaemon(workspacePath);
  const snapshot = await sendRpc<StatusSnapshot>(workspacePath, "status.snapshot");
  if (parsed.flags.json) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }

  printStatus(snapshot);
}

async function handleWorkspaceCommand(workspacePath: string, parsed: ParsedArgs) {
  const store = new ResearchStore();
  switch (parsed.commandPath[1]) {
    case "reset":
      await stopDaemonIfRunning(workspacePath);
      await store.resetWorkspace(workspacePath);
      process.stdout.write(`reset ${path.join(workspacePath, ".lithium")}\n`);
      return;
    case "archive": {
      await stopDaemonIfRunning(workspacePath);
      const result = await store.archiveWorkspace(workspacePath);
      process.stdout.write(`archived to ${result.archivedPath}\n`);
      return;
    }
    default:
      throw new Error("Usage: lithium workspace reset|archive");
  }
}

async function serveDaemon(workspacePath: string, settingsStore?: AppSettingsStore) {
  const appSettings = await settingsStore?.read();
  const daemon = createWorkspaceDaemon(workspacePath, {
    appSettings
  });
  await daemon.start();
  await settingsStore?.update({
    lastWorkspacePath: workspacePath
  });

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise(() => undefined);
}

async function ensureDaemon(workspacePath: string) {
  try {
    await sendRpc(workspacePath, "daemon.status");
  } catch {
    await startDaemonInBackground(workspacePath);
  }
}

async function stopDaemonIfRunning(workspacePath: string) {
  try {
    await sendRpc(workspacePath, "daemon.stop");
  } catch {
    return;
  }
}

async function startDaemonInBackground(workspacePath: string) {
  try {
    await sendRpc(workspacePath, "daemon.status");
    return;
  } catch {
    // Daemon is not running yet.
  }

  const entryPoint = process.argv[1];
  const child = spawn(process.execPath, [...process.execArgv, entryPoint, "daemon", "serve", "--workspace", workspacePath], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd()
  });
  child.unref();
  await waitForDaemonSocket(workspacePath);
}

async function watchStatus(workspacePath: string, intervalMs: number) {
  let last = "";
  while (true) {
    const snapshot = await sendRpc<StatusSnapshot>(workspacePath, "status.snapshot");
    const rendered = renderStatus(snapshot);
    if (rendered !== last) {
      process.stdout.write("\u001bc");
      process.stdout.write(`${rendered}\n`);
      last = rendered;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function renderStatus(snapshot: StatusSnapshot) {
  return [
    `workspace: ${snapshot.workspacePath}`,
    `daemon: ${snapshot.daemon.running ? `running pid=${snapshot.daemon.pid ?? "?"}` : "stopped"}`,
    `objective: ${snapshot.activeObjective?.title ?? "none"}`,
    `run: ${snapshot.activeRun?.status ?? "none"}`,
    `queue: ${snapshot.queue.length}`,
    "",
    "branches:",
    ...(snapshot.branches.length > 0
      ? snapshot.branches.map((entry) => `- ${entry.title} [${entry.status}] score=${entry.score.toFixed(3)}`)
      : ["- none"]),
    "",
    "active tasks:",
    ...(snapshot.activeTasks.length > 0
      ? snapshot.activeTasks.map((entry) => `- ${entry.kind}: ${entry.title}`)
      : ["- none"]),
    "",
    "recent findings:",
    ...(snapshot.recentFindings.length > 0
      ? snapshot.recentFindings.map((entry) => `- ${entry.summary}`)
      : ["- none"]),
    "",
    "recent evaluations:",
    ...(snapshot.recentEvaluations.length > 0
      ? snapshot.recentEvaluations.map((entry) => `- ${entry.verdict}: ${entry.summary}`)
      : ["- none"])
  ].join("\n");
}

function printStatus(snapshot: StatusSnapshot) {
  process.stdout.write(`${renderStatus(snapshot)}\n`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedArgs["flags"] = {};
  const positionals: string[] = [];
  const commandPath: string[] = [];
  let index = 0;

  while (index < argv.length) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
        index += 1;
        continue;
      }
      if (flags[key] === undefined) {
        flags[key] = next;
      } else if (Array.isArray(flags[key])) {
        (flags[key] as string[]).push(next);
      } else {
        flags[key] = [String(flags[key]), next];
      }
      index += 2;
      continue;
    }
    if (commandPath.length < 2 && isCommandToken(commandPath.length, token)) {
      commandPath.push(token);
    } else {
      positionals.push(token);
    }
    index += 1;
  }

  return {
    commandPath,
    positionals,
    flags,
    workspacePath: readOptionalFlag(flags.workspace)
  };
}

function isCommandToken(index: number, token: string) {
  if (index === 0) {
    return ["daemon", "objective", "run", "source", "status", "workspace"].includes(token);
  }
  if (index === 1) {
    return true;
  }
  return false;
}

function resolveWorkspacePath(value: string) {
  return path.resolve(value);
}

function resolveCliSettingsPath() {
  return path.join(os.homedir(), ".lithium", "settings.json");
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  lithium daemon start|stop|status [--workspace <path>] [--foreground]",
      "  lithium objective create <goal> [--workspace <path>] [--title <title>] [--success <criterion> ...]",
      "  lithium objective list|show [objectiveId] [--workspace <path>]",
      "  lithium run start|pause|resume [--workspace <path>] [--objective <id>]",
      "  lithium run stop [--workspace <path>] [--objective <id>] [--run <id>]",
      "  lithium run watch [--workspace <path>] [--interval <ms>]",
      "  lithium source add <path-or-url...> [--workspace <path>] [--objective <id>] [--branch <id>]",
      "  lithium status [--workspace <path>] [--json]",
      "  lithium workspace reset|archive [--workspace <path>]"
    ].join("\n") + "\n"
  );
}

function readOptionalFlag(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseRepeatedFlag(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

type ParsedArgs = {
  commandPath: string[];
  positionals: string[];
  flags: Record<string, string | string[] | boolean>;
  workspacePath?: string;
};

void main().catch((error) => {
  process.stderr.write(`Lithium CLI failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
