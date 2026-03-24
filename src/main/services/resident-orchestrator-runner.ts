import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { BuilderModel, BuilderReasoningEffort } from "../../shared/types";
import {
  getLiveTerminal,
  startLiveTerminal,
  stopLiveTerminal,
  writeToLiveTerminal
} from "./terminal-pty-registry";
import {
  OrchestratorRunner,
  type OrchestratorRequestPaths,
  type OrchestratorRunOptions,
  type OrchestratorRunResult
} from "./orchestrator-runner";
import {
  parseOrchestratorDelegationRequest,
  type OrchestratorDelegationDirective
} from "./orchestrator-directives";

type ResidentTurnOptions = Omit<OrchestratorRunOptions, "stdoutPath" | "stderrPath" | "outputPath"> & {
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
};

type HostSession = {
  id: string;
  transcriptPath: string;
};

const POLL_INTERVAL_MS = 150;

export class ResidentOrchestratorRunner {
  private readonly queueByHost = new Map<string, Promise<OrchestratorRunResult>>();
  private readonly fallbackRunner: OrchestratorRunner;

  constructor(fallbackRunner = new OrchestratorRunner()) {
    this.fallbackRunner = fallbackRunner;
  }

  async runTurn(options: ResidentTurnOptions): Promise<OrchestratorRunResult> {
    const queueKey = this.buildQueueKey(options);
    const previous = this.queueByHost.get(queueKey) ?? Promise.resolve(null as never);
    const next = previous
      .catch(() => undefined)
      .then(async () => await this.runQueuedTurn(options));

    this.queueByHost.set(queueKey, next);

    try {
      return await next;
    } finally {
      if (this.queueByHost.get(queueKey) === next) {
        this.queueByHost.delete(queueKey);
      }
    }
  }

  private buildQueueKey(options: ResidentTurnOptions) {
    return `${options.workspacePath}::${options.hostKey?.trim() || "default"}`;
  }

  private async runQueuedTurn(options: ResidentTurnOptions) {
    try {
      return await this.runWithResidentShell(options);
    } catch {
      await this.resetHost(options.workspacePath, options.hostKey);
      return await this.fallbackRunner.runTurn(options);
    }
  }

  private async runWithResidentShell(options: ResidentTurnOptions): Promise<OrchestratorRunResult> {
    const host = await this.ensureHost(options.workspacePath, options.hostKey);
    const requestDir = path.dirname(options.requestPaths.builder);
    const composedPrompt = this.fallbackRunner.composePrompt(
      options.prompt,
      options.runtimeContext,
      options.requestPaths
    );
    const turnDir = path.join(requestDir, "resident-turns", randomUUID());
    const promptPath = path.join(turnDir, "prompt.md");
    const exitPath = path.join(turnDir, "exit.code");
    const startedAt = new Date().toISOString();

    await mkdir(turnDir, { recursive: true });
    await Promise.all([
      writeFile(promptPath, composedPrompt, "utf8"),
      this.resetTurnFiles(options.requestPaths, options.stdoutPath, options.stderrPath, options.outputPath, exitPath)
    ]);

    const command = this.fallbackRunner.buildCommand(
      options.workspacePath,
      options.sessionId,
      composedPrompt,
      options.outputPath,
      normalizeOrchestratorModel(options.model),
      normalizeReasoning(options.reasoningEffort),
      "stdin"
    );
    const shellCommand = buildResidentShellCommand({
      command,
      promptPath,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      exitPath
    });

    if (!writeToLiveTerminal(options.workspacePath, host.id, `${shellCommand}\r`)) {
      throw new Error("Resident orchestrator shell is unavailable.");
    }

    const exitCode = await this.waitForExitCode(options.workspacePath, options.hostKey, host.id, exitPath);
    const stdout = await readMaybe(options.stdoutPath);
    const stderr = await readMaybe(options.stderrPath);
    const finalMessage =
      (await readMaybe(options.outputPath)).trim() ||
      [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
    const delegations = await this.readDelegationRequests(options.requestPaths);
    const primaryDelegation = delegations[0] ?? null;

    return {
      command,
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode,
      timedOut: false,
      stdout,
      stderr,
      finalMessage,
      sessionId: parseThreadId(stdout) || options.sessionId || null,
      requestedLane: primaryDelegation?.lane ?? null,
      delegatedPrompt: primaryDelegation?.prompt ?? "",
      delegation: primaryDelegation,
      delegations
    };
  }

  private async ensureHost(workspacePath: string, hostKey?: string): Promise<HostSession> {
    const existing = getLiveTerminal(workspacePath, hostSessionId(workspacePath, hostKey));

    if (existing) {
      return {
        id: existing.id,
        transcriptPath: hostTranscriptPath(workspacePath, hostKey)
      };
    }

    const handle = await startLiveTerminal({
      id: hostSessionId(workspacePath, hostKey),
      workspacePath,
      cwd: workspacePath,
      transcriptPath: hostTranscriptPath(workspacePath, hostKey),
      cols: 120,
      rows: 32,
      shell: "/bin/sh"
    });

    return {
      id: handle.id,
      transcriptPath: hostTranscriptPath(workspacePath, hostKey)
    };
  }

  private async resetHost(workspacePath: string, hostKey?: string) {
    stopLiveTerminal(workspacePath, hostSessionId(workspacePath, hostKey));
    await rm(hostTranscriptPath(workspacePath, hostKey), { force: true }).catch(() => undefined);
  }

  private async resetTurnFiles(
    requestPaths: OrchestratorRequestPaths,
    stdoutPath: string,
    stderrPath: string,
    outputPath: string,
    exitPath: string
  ) {
    await Promise.all([
      mkdir(path.dirname(requestPaths.builder), { recursive: true }),
      rm(requestPaths.builder, { force: true }),
      rm(requestPaths.strategist, { force: true }),
      rm(requestPaths.automation, { force: true }),
      rm(stdoutPath, { force: true }),
      rm(stderrPath, { force: true }),
      rm(outputPath, { force: true }),
      rm(exitPath, { force: true })
    ]);
  }

  private async waitForExitCode(
    workspacePath: string,
    hostKey: string | undefined,
    hostId: string,
    exitPath: string
  ) {
    while (true) {
      if (!getLiveTerminal(workspacePath, hostSessionId(workspacePath, hostKey)) || !getLiveTerminal(workspacePath, hostId)) {
        throw new Error("Resident orchestrator shell exited before finishing the turn.");
      }

      const rawExit = (await readMaybe(exitPath)).trim();

      if (rawExit) {
        const parsed = Number.parseInt(rawExit, 10);
        return Number.isFinite(parsed) ? parsed : null;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  private async readDelegationRequests(requestPaths: OrchestratorRequestPaths) {
    const files: Array<[OrchestratorRunResult["requestedLane"], string]> = [
      ["builder", requestPaths.builder],
      ["strategist", requestPaths.strategist],
      ["automation", requestPaths.automation]
    ];
    const delegations: OrchestratorDelegationDirective[] = [];

    for (const [lane, filePath] of files) {
      const raw = (await readMaybe(filePath)).trim();

      if (raw && lane) {
        const directive = parseOrchestratorDelegationRequest(lane, raw);
        if (directive) {
          delegations.push(directive);
        }
      }
    }

    return delegations;
  }
}

function buildResidentShellCommand(input: {
  command: { command: string; args: string[]; cwd: string };
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  exitPath: string;
}) {
  const quotedCommand = [input.command.command, ...input.command.args].map(toShellLiteral).join(" ");

  return [
    `cd ${toShellLiteral(input.command.cwd)}`,
    `${quotedCommand} < ${toShellLiteral(input.promptPath)} > ${toShellLiteral(input.stdoutPath)} 2> ${toShellLiteral(input.stderrPath)}`,
    `status=$?`,
    `printf '%s' "$status" > ${toShellLiteral(input.exitPath)}`
  ].join("; ");
}

function hostSessionId(workspacePath: string, hostKey?: string) {
  const suffix = hostKey?.trim() || "default";
  return `__lithium_orchestrator__${Buffer.from(`${workspacePath}::${suffix}`).toString("base64url").slice(0, 24)}`;
}

function hostTranscriptPath(workspacePath: string, hostKey?: string) {
  const suffix = (hostKey?.trim() || "default").replace(/[^a-z0-9._-]+/gi, "-");
  return path.join(workspacePath, ".lithium", "orchestrator", `resident-host.${suffix}.transcript.log`);
}

function toShellLiteral(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function readMaybe(filePath: string) {
  try {
    await stat(filePath);
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseThreadId(stdout: string) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string };

      if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id.trim()) {
        return event.thread_id.trim();
      }
    } catch {
      continue;
    }
  }

  return "";
}

function normalizeOrchestratorModel(model?: BuilderModel): BuilderModel {
  return model === "gpt-5.3-codex" ? "gpt-5.4" : model ?? "gpt-5.4";
}

function normalizeReasoning(reasoningEffort?: BuilderReasoningEffort): BuilderReasoningEffort {
  return reasoningEffort ?? "xhigh";
}
