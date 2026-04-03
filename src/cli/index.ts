#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { AppSettingsStore } from "../main/services/app-settings-store";
import { ResearchService } from "../main/services/research-service";
import {
  LithiumCliController,
  resolveInitialWorkspacePath,
  startCliRepl
} from "./repl";

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  const settingsStore = new AppSettingsStore(resolveCliSettingsPath());
  const settings = await settingsStore.read();
  const initialWorkspacePath = resolveInitialWorkspacePath(
    process.argv.slice(2),
    settings.lastWorkspacePath,
    process.cwd()
  );
  const controller = new LithiumCliController({
    service: new ResearchService(initialWorkspacePath, {
      getAppSettings: () => settingsStore.read()
    }),
    settingsStore,
    writeLine: (line = "") => {
      process.stdout.write(`${line}\n`);
    }
  });

  await controller.initialize(initialWorkspacePath);
  await startCliRepl({
    controller,
    input: process.stdin,
    output: process.stdout
  });
}

function resolveCliSettingsPath() {
  return path.join(os.homedir(), ".lithium", "settings.json");
}

function printUsage() {
  process.stdout.write("Usage: lithium [workspacePath]\n");
  process.stdout.write("Start the interactive Lithium CLI in the given workspace.\n");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Lithium CLI failed: ${message}\n`);
  process.exitCode = 1;
});
