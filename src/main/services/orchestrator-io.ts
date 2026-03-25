import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { readTextFileIfExists } from "./fs-utils";
import {
  parseOrchestratorDelegationRequest,
  type OrchestratorDelegationDirective
} from "./orchestrator-directives";

export type OrchestratorLane = "builder" | "strategist" | "automation";

export type OrchestratorRequestPaths = {
  builder: string;
  strategist: string;
  automation: string;
};

export async function resetOrchestratorTurnFiles(requestPaths: OrchestratorRequestPaths, extraFiles: string[] = []) {
  const filePaths = [requestPaths.builder, requestPaths.strategist, requestPaths.automation, ...extraFiles];
  const directories = Array.from(new Set(filePaths.map((filePath) => path.dirname(filePath))));

  await Promise.all([
    ...directories.map(async (directory) => await mkdir(directory, { recursive: true })),
    ...filePaths.map(async (filePath) => await rm(filePath, { force: true }))
  ]);
}

export async function readOrchestratorDelegationRequests(requestPaths: OrchestratorRequestPaths) {
  const entries: Array<[OrchestratorLane, string]> = [
    ["builder", requestPaths.builder],
    ["strategist", requestPaths.strategist],
    ["automation", requestPaths.automation]
  ];
  const delegations: OrchestratorDelegationDirective[] = [];

  for (const [lane, filePath] of entries) {
    const raw = (await readTextFileIfExists(filePath)).trim();

    if (!raw) {
      continue;
    }

    const directive = parseOrchestratorDelegationRequest(lane, raw);

    if (directive) {
      delegations.push(directive);
    }
  }

  return delegations;
}

export function parseCodexThreadId(stdout: string) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        thread_id?: string;
      };
      const threadId = event.thread_id?.trim();

      if ((event.type === "thread.started" || event.type === "thread.resumed") && threadId) {
        return threadId;
      }
    } catch {
      continue;
    }
  }

  return "";
}
