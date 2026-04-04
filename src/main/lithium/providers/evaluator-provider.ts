import type { EvaluationVerdict, TaskOutcome, TaskRecord, WorkerRunRecord } from "../../../shared/types";
import { startCommand } from "../../services/process-runner";
import { ArtifactStore } from "../artifact-store";
import { createId, nowIso } from "../utils";
import { isPidAlive, terminateByPid, waitForPidExit } from "./process-recovery";
import type { ProviderContext, ProviderHandle, ProviderRecoveryContext, TaskProvider } from "./types";

export class EvaluatorProvider implements TaskProvider {
  constructor(
    private readonly deps: {
      artifactStore: ArtifactStore;
    }
  ) {}

  supports(kind: TaskRecord["kind"]) {
    return kind === "evaluate_branch";
  }

  async start(context: ProviderContext): Promise<ProviderHandle> {
    const artifacts = await this.deps.artifactStore.allocateRunArtifacts(context.workspacePath, "evaluator", createId("eval"));
    const prompt = buildEvaluatorPrompt(context);
    const session = await startCommand({
      spec: {
        command: "codex",
        args: [
          "exec",
          "-c",
          'model_reasoning_effort="high"',
          "--model",
          "gpt-5.4",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "--output-last-message",
          artifacts.outputPath,
          prompt
        ],
        cwd: context.workspacePath
      },
      timeoutMs: 10 * 60_000,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath
    });

    const workerRun: WorkerRunRecord = {
      id: artifacts.id,
      taskId: context.task.id,
      runId: context.run.id,
      objectiveId: context.objective.id,
      branchId: context.task.branchId,
      provider: "evaluator",
      command: {
        command: "codex",
        args: [
          "exec",
          "-c",
          'model_reasoning_effort="high"',
          "--model",
          "gpt-5.4",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "--output-last-message",
          artifacts.outputPath,
          prompt
        ],
        cwd: context.workspacePath
      },
      status: "running",
      pid: session.pid,
      model: "gpt-5.4",
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      outputPath: artifacts.outputPath,
      createdAt: session.startedAt,
      updatedAt: session.startedAt,
      startedAt: session.startedAt
    };

    return {
      workerRun,
      terminate: session.terminate,
      result: session.result.then((result) =>
        this.finalize({
          workerRun,
          exitCode: result.exitCode,
          timedOut: result.timedOut
        })
      )
    };
  }

  async recover(context: ProviderRecoveryContext): Promise<ProviderHandle | null> {
    if (!(await isPidAlive(context.workerRun.pid))) {
      return null;
    }

    return {
      workerRun: context.workerRun,
      terminate: (signal) => terminateByPid(context.workerRun.pid, signal),
      result: (async () => {
        await waitForPidExit(context.workerRun.pid!);
        return await this.finalize({
          workerRun: context.workerRun
        });
      })()
    };
  }

  private async finalize(input: {
    workerRun: WorkerRunRecord;
    exitCode?: number | null;
    timedOut?: boolean;
  }): Promise<TaskOutcome> {
    const outputText = await this.deps.artifactStore.readText(
      input.workerRun.outputPath
        ? {
            id: createId("art"),
            kind: "output",
            path: input.workerRun.outputPath,
            createdAt: nowIso()
          }
        : null
    );
    const decision = parseEvaluatorDecision(outputText);
    const status = input.timedOut || input.exitCode === null ? "failed" : input.exitCode === 0 ? "completed" : "failed";

    return {
      status,
      summary: decision.summary,
      failureReason: status === "failed" ? decision.rationale : undefined,
      retryability: status === "completed" ? "needs-human" : "retryable",
      artifactRefs: [
        {
          id: createId("art"),
          kind: "stdout",
          path: input.workerRun.stdoutPath,
          createdAt: nowIso()
        },
        {
          id: createId("art"),
          kind: "stderr",
          path: input.workerRun.stderrPath,
          createdAt: nowIso()
        },
        ...(input.workerRun.outputPath
          ? [
              {
                id: createId("art"),
                kind: "output" as const,
                path: input.workerRun.outputPath,
                createdAt: nowIso()
              }
            ]
          : [])
      ],
      changedFiles: [],
      metrics: [],
      evaluation: decision
    };
  }
}

function buildEvaluatorPrompt(context: ProviderContext) {
  return [
    "You are the Lithium V4 evaluator.",
    "Return only one JSON object after reasoning.",
    "Required fields: verdict, scoreDelta, summary, rationale, optional followupPrompt.",
    "Allowed verdicts: continue, kill, pivot, complete.",
    "",
    `TASK_TITLE: ${context.task.title}`,
    `TASK_KIND: ${context.task.kind}`,
    "",
    "ARTIFACT_CONTEXT:",
    context.contextText.trim()
  ].join("\n");
}

function parseEvaluatorDecision(rawOutput: string) {
  const parsed = tryParseJson(rawOutput);
  const payload = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const verdict = readVerdict(payload.verdict);
  return {
    verdict,
    scoreDelta: typeof payload.scoreDelta === "number" && Number.isFinite(payload.scoreDelta) ? payload.scoreDelta : 0,
    summary:
      typeof payload.summary === "string" && payload.summary.trim()
        ? payload.summary.trim()
        : "Evaluation completed with fallback summary.",
    rationale:
      typeof payload.rationale === "string" && payload.rationale.trim()
        ? payload.rationale.trim()
        : "Evaluator output did not provide rationale.",
    followupPrompt:
      typeof payload.followupPrompt === "string" && payload.followupPrompt.trim()
        ? payload.followupPrompt.trim()
        : undefined
  };
}

function tryParseJson(rawOutput: string) {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function readVerdict(value: unknown): EvaluationVerdict {
  return value === "continue" || value === "kill" || value === "pivot" || value === "complete" ? value : "continue";
}
