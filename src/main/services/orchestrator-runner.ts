import os from "node:os";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { BuilderModel, BuilderReasoningEffort, CommandSpec } from "../../shared/types";
import { readTextFileIfExists } from "./fs-utils";
import { runCommand } from "./process-runner";
import {
  parseOrchestratorDelegationRequest,
  type OrchestratorDelegationDirective
} from "./orchestrator-directives";

export type OrchestratorDelegationLane = "builder" | "strategist" | "automation";

export type OrchestratorRequestPaths = {
  builder: string;
  strategist: string;
  automation: string;
};

export type OrchestratorRunOptions = {
  workspacePath: string;
  sessionId?: string;
  hostKey?: string;
  prompt: string;
  runtimeContext: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  requestPaths: OrchestratorRequestPaths;
  model?: BuilderModel;
  reasoningEffort?: BuilderReasoningEffort;
};

export type OrchestratorRunResult = {
  command: CommandSpec;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  finalMessage: string;
  sessionId: string | null;
  requestedLane: OrchestratorDelegationLane | null;
  delegatedPrompt: string;
  delegation?: OrchestratorDelegationDirective | null;
  delegations?: OrchestratorDelegationDirective[];
};

export class OrchestratorRunner {
  async runTurn(options: OrchestratorRunOptions): Promise<OrchestratorRunResult> {
    await this.resetRequestFiles(options.requestPaths);

    const command = this.buildCommand(
      options.workspacePath,
      options.sessionId,
      this.composePrompt(options.prompt, options.runtimeContext, options.requestPaths),
      options.outputPath,
      options.model ?? "gpt-5.4",
      options.reasoningEffort ?? "xhigh"
    );

    const result = await runCommand({
      spec: command,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath
    });
    const finalMessage =
      (await this.readMaybe(options.outputPath)).trim() ||
      [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
    const delegations = await this.readDelegationRequests(options.requestPaths);
    const primaryDelegation = delegations[0] ?? null;

    return {
      ...result,
      command,
      finalMessage,
      sessionId: parseThreadId(result.stdout) || options.sessionId || null,
      requestedLane: primaryDelegation?.lane ?? null,
      delegatedPrompt: primaryDelegation?.prompt ?? "",
      delegation: primaryDelegation,
      delegations
    };
  }

  buildCommand(
    workspacePath: string,
    sessionId: string | undefined,
    prompt: string,
    outputPath: string,
    model: BuilderModel,
    reasoningEffort: BuilderReasoningEffort,
    inputMode: "arg" | "stdin" = "arg"
  ): CommandSpec {
    const args = sessionId ? ["exec", "resume"] : ["exec"];
    args.push(
      "-c",
      `model_reasoning_effort="${reasoningEffort}"`,
      "--model",
      model,
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
    );

    if (!sessionId) {
      args.push("--add-dir", resolveOracleHomeDir());
    }

    args.push(
      "--output-last-message",
      outputPath
    );

    if (sessionId) {
      args.push(sessionId);
    }

    args.push(inputMode === "stdin" ? "-" : prompt);

    return {
      command: "codex",
      args,
      cwd: workspacePath
    };
  }

  composePrompt(
    prompt: string,
    runtimeContext: string,
    requestPaths: OrchestratorRequestPaths
  ) {
    return [
      "You are Lithium's conversation orchestrator.",
      "You own the user-visible reply for this thread. Speak naturally and concisely.",
      "Use the user's current language unless there is a strong reason not to.",
      "Emit short, self-contained progress notes in the user's language while you inspect context or make delegation decisions. Those notes may be shown live in chat.",
      "Do lightweight repository inspection when it helps, but do not perform heavy code edits, experiments, or browser research yourself.",
      "When concrete workspace execution is needed, write a plain markdown task to the builder request file and keep your visible reply short and forward-looking.",
      "When deep research, literature judgment, or browser-based comparison is needed, write a plain markdown task to the strategist request file and keep your visible reply short and forward-looking.",
      "When the user is clearly asking to kick off open-ended autonomous research rather than a bounded Q&A turn, write the goal to the automation request file.",
      "Default autonomous research to continuous execution. Only set Mode: checkpoint when the user explicitly asks for manual checkpoint cadence or the very next move truly depends on a real user choice that cannot be deferred.",
      "You may optionally add a few plain header lines above the worker task when tighter control helps.",
      "You may create both the builder and strategist request files in the same turn when parallel work helps.",
      "Use parallel worker requests when one lane can make concrete progress while another lane does deeper research or judgment.",
      "Keep each worker task independently executable. The builder should not wait on the strategist mid-run, and the strategist should not assume the builder has already finished.",
      "Create at most one request file per lane in a turn.",
      "Do not mix automation requests with builder/strategist requests in the same turn.",
      "Supported builder headers: Execution: live|sync, Model: gpt-5.4|gpt-5.3-codex, Reasoning: low|medium|high|xhigh.",
      "Supported strategist headers: Execution: sync|async, Model: gpt-5.4|gpt-5.4-pro, Intensity: light|standard|extended|heavy, Attach explicit files: yes|no.",
      "Supported automation headers: Mode: continuous|checkpoint, Max steps: N, Max runtime minutes: N, Max retries: N, Paper write: yes|no.",
      "After any optional headers, leave a blank line and then write the worker task in natural language.",
      "If you can answer directly, create no request files.",
      "Treat worker verbose, shell traces, and long logs as internal evidence. Do not dump them verbatim into the visible reply unless the user explicitly asks for raw output.",
      "Do not mention internal JSON, checkpoints, lanes, or control files unless it genuinely helps the user.",
      "",
      "Builder request file:",
      requestPaths.builder,
      "",
      "Strategist request file:",
      requestPaths.strategist,
      "",
      "Automation request file:",
      requestPaths.automation,
      "",
      "RUNTIME_CONTEXT:",
      runtimeContext.trim(),
      "",
      `USER_MESSAGE: ${prompt.trim()}`
    ].join("\n");
  }

  private async resetRequestFiles(requestPaths: OrchestratorRequestPaths) {
    await Promise.all([
      mkdir(path.dirname(requestPaths.builder), { recursive: true }),
      rm(requestPaths.builder, { force: true }),
      rm(requestPaths.strategist, { force: true }),
      rm(requestPaths.automation, { force: true })
    ]);
  }

  private async readDelegationRequests(requestPaths: OrchestratorRequestPaths) {
    const entries: Array<[OrchestratorDelegationLane, string]> = [
      ["builder", requestPaths.builder],
      ["strategist", requestPaths.strategist],
      ["automation", requestPaths.automation]
    ];
    const delegations: OrchestratorDelegationDirective[] = [];

    for (const [lane, filePath] of entries) {
      const raw = (await this.readMaybe(filePath)).trim();

      if (raw) {
        const directive = parseOrchestratorDelegationRequest(lane, raw);
        if (directive) {
          delegations.push(directive);
        }
      }
    }

    return delegations;
  }

  private async readMaybe(filePath: string) {
    return await readTextFileIfExists(filePath);
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

function resolveOracleHomeDir() {
  return process.env.ORACLE_HOME_DIR?.trim() || path.join(os.homedir(), ".oracle");
}
