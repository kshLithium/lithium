import type {
  EvaluationComparator,
  EvaluateTaskPayload,
  MetricExpectation,
  MetricRecord,
  TaskOutcome,
  TaskRecord,
  WorkerRunRecord
} from "../../../shared/types";
import { startCommand } from "../../services/process-runner";
import {
  LITHIUM_EVALUATION_MARKER,
  parseEvaluatorDecision
} from "../../services/protocol";
import { ArtifactStore } from "../artifact-store";
import { ResearchStore } from "../store";
import { createId, nowIso } from "../utils";
import { isPidAlive, terminateByPid, waitForPidExit } from "./process-recovery";
import type { ProviderContext, ProviderHandle, ProviderRecoveryContext, TaskProvider } from "./types";

type DeterministicEvaluation = {
  gateStatus: "passed" | "failed" | "inconclusive";
  summary: string;
  rationale: string;
  comparator?: EvaluationComparator;
};

export class EvaluatorProvider implements TaskProvider {
  constructor(
    private readonly deps: {
      artifactStore: ArtifactStore;
      store: ResearchStore;
    }
  ) {}

  supports(kind: TaskRecord["kind"]) {
    return kind === "evaluate_branch";
  }

  async start(context: ProviderContext): Promise<ProviderHandle> {
    const deterministic = this.evaluateDeterministically(context.workspacePath, context.task);
    if (deterministic.gateStatus === "failed") {
      const workerRun = this.buildSyntheticWorkerRun(context);
      return {
        workerRun,
        terminate: () => undefined,
        result: Promise.resolve({
          status: "completed",
          summary: deterministic.summary,
          retryability: "needs-human",
          artifactRefs: [],
          changedFiles: [],
          metrics: [],
          evaluation: {
            verdict: "continue",
            gateStatus: deterministic.gateStatus,
            scoreDelta: -0.12,
            summary: deterministic.summary,
            rationale: deterministic.rationale,
            comparator: deterministic.comparator
          }
        })
      };
    }

    const artifacts = await this.deps.artifactStore.allocateRunArtifacts(context.workspacePath, "evaluator", createId("eval"));
    const prompt = buildEvaluatorPrompt(context, deterministic);
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
      metadata: {
        deterministic
      },
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
          deterministic,
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
          workerRun: context.workerRun,
          deterministic: readDeterministicMetadata(context.workerRun),
          exitCode: 0,
          timedOut: false
        });
      })()
    };
  }

  private async finalize(input: {
    workerRun: WorkerRunRecord;
    deterministic: DeterministicEvaluation;
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
    const status = input.timedOut || input.exitCode === null ? "failed" : input.exitCode === 0 ? "completed" : "failed";
    if (status === "failed") {
      return {
        status,
        summary: "Evaluator execution failed.",
        failureReason: input.timedOut ? "Evaluator timed out." : "Evaluator command failed.",
        retryability: "needs-human",
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
          }
        ],
        changedFiles: [],
        metrics: []
      };
    }

    const decision = parseEvaluatorDecision(outputText);
    if (!decision.ok) {
      return {
        status: "failed",
        summary: "Evaluator output violated the structured protocol.",
        failureReason: decision.error,
        retryability: "retryable",
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
        metrics: []
      };
    }

    return {
      status,
      summary: decision.value.summary,
      retryability: "needs-human",
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
      evaluation: {
        ...decision.value,
        gateStatus: input.deterministic.gateStatus,
        comparator: input.deterministic.comparator
      }
    };
  }

  private evaluateDeterministically(workspacePath: string, task: TaskRecord): DeterministicEvaluation {
    const payload = task.payload as EvaluateTaskPayload;
    const projection = this.deps.store.getProjection(workspacePath);
    const subjectTask = projection.tasks.find((entry) => entry.id === payload.subjectTaskId) ?? null;
    const experimentRuns = projection.experiments.filter((entry) => payload.experimentResultIds.includes(entry.id));
    const metricRecords = projection.metrics.filter((entry) => payload.metricRefs.includes(entry.id));

    if (payload.subjectTaskStatus === "failed" && experimentRuns.length === 0) {
      return {
        gateStatus: "failed",
        summary: "Deterministic gate failed because the subject task itself failed.",
        rationale: subjectTask?.summary || "The evaluated subject task failed before producing a promotable result."
      };
    }

    const contractViolation = experimentRuns.find((entry) => entry.contractViolation);
    if (contractViolation) {
      return {
        gateStatus: "failed",
        summary: "Deterministic gate failed because the experiment violated the read-only contract.",
        rationale: contractViolation.contractViolation || "The experiment mutated tracked files during a read-only step."
      };
    }

    const failedExperiment = experimentRuns.find((entry) => entry.status !== "completed");
    if (failedExperiment) {
      return {
        gateStatus: "failed",
        summary: "Deterministic gate failed because the experiment or verification step failed.",
        rationale: failedExperiment.summary
      };
    }

    const metricExpectations = experimentRuns.flatMap((entry) => {
      const manifestPath = entry.manifestRef?.path;
      const manifest = manifestPath ? this.deps.artifactStore.readText(entry.manifestRef!) : null;
      return manifest;
    });
    void metricExpectations;

    const expectationFailure = findMissingMetricExpectation(metricRecords, payload.successCriteria);
    if (expectationFailure) {
      return {
        gateStatus: "failed",
        summary: "Deterministic gate failed because expected metrics are missing.",
        rationale: expectationFailure
      };
    }

    const comparator = buildComparator(payload.baselineExperimentId, projection.metrics, metricRecords);
    return {
      gateStatus: comparator ? "passed" : "inconclusive",
      summary: comparator ? "Deterministic checks passed and baseline comparison is available." : "Deterministic checks passed but no baseline comparison was available.",
      rationale: comparator
        ? `Compared ${Object.keys(comparator.metricDeltas).length} metric deltas against the baseline experiment.`
        : "No baseline experiment was configured or no comparable metrics were found.",
      comparator
    };
  }

  private buildSyntheticWorkerRun(context: ProviderContext): WorkerRunRecord {
    const now = nowIso();
    return {
      id: createId("eval"),
      taskId: context.task.id,
      runId: context.run.id,
      objectiveId: context.objective.id,
      branchId: context.task.branchId,
      provider: "evaluator",
      command: {
        command: "builtin",
        args: ["deterministic-gate"],
        cwd: context.workspacePath
      },
      status: "running",
      pid: null,
      stdoutPath: "",
      stderrPath: "",
      createdAt: now,
      updatedAt: now,
      startedAt: now
    };
  }
}

function buildEvaluatorPrompt(context: ProviderContext, deterministic: DeterministicEvaluation) {
  return [
    "You are the Lithium V5 evaluator.",
    `Return ${LITHIUM_EVALUATION_MARKER} followed by one JSON object.`,
    "Required fields: verdict, gateStatus, scoreDelta, summary, rationale. Optional: followupPrompt.",
    "Allowed verdicts: continue, kill, pivot, complete.",
    "Allowed gateStatus: passed, failed, inconclusive.",
    "Do not invent metrics. Use the deterministic gate and comparator as ground truth.",
    "",
    `TASK_TITLE: ${context.task.title}`,
    `TASK_KIND: ${context.task.kind}`,
    `DETERMINISTIC_GATE: ${deterministic.gateStatus}`,
    `DETERMINISTIC_SUMMARY: ${deterministic.summary}`,
    `DETERMINISTIC_RATIONALE: ${deterministic.rationale}`,
    deterministic.comparator
      ? `COMPARATOR: ${JSON.stringify(deterministic.comparator)}`
      : "COMPARATOR: none",
    "",
    "ARTIFACT_CONTEXT:",
    context.contextText.trim()
  ].join("\n");
}

function readDeterministicMetadata(workerRun: WorkerRunRecord): DeterministicEvaluation {
  const record = workerRun.metadata?.deterministic;
  if (!record || typeof record !== "object") {
    return {
      gateStatus: "inconclusive",
      summary: "Deterministic metadata was unavailable during recovery.",
      rationale: "The evaluator had to recover without saved deterministic metadata."
    };
  }
  const candidate = record as DeterministicEvaluation;
  return {
    gateStatus: candidate.gateStatus,
    summary: candidate.summary,
    rationale: candidate.rationale,
    comparator: candidate.comparator
  };
}

function buildComparator(
  baselineExperimentId: string | undefined,
  projectionMetrics: MetricRecord[],
  metricRecords: MetricRecord[]
): EvaluationComparator | undefined {
  if (!baselineExperimentId) {
    return undefined;
  }
  const baselineMetrics = projectionMetrics.filter((entry) => entry.experimentId === baselineExperimentId);
  if (baselineMetrics.length === 0 || metricRecords.length === 0) {
    return undefined;
  }
  const baselineByName = new Map(baselineMetrics.map((entry) => [entry.name, entry] as const));
  const metricDeltas: Record<string, number> = {};
  for (const metric of metricRecords) {
    const baseline = baselineByName.get(metric.name);
    if (!baseline) {
      continue;
    }
    metricDeltas[metric.name] = metric.value - baseline.value;
  }
  if (Object.keys(metricDeltas).length === 0) {
    return undefined;
  }
  return {
    baselineExperimentId,
    metricDeltas
  };
}

function findMissingMetricExpectation(metricRecords: MetricRecord[], successCriteria: string[]) {
  const names = new Set(metricRecords.map((entry) => entry.name));
  const requiredMetricNames = successCriteria
    .map((entry) => {
      const match = entry.match(/\b([A-Za-z][A-Za-z0-9_.-]{1,40})\b/);
      return match?.[1] ?? null;
    })
    .filter((entry): entry is string => Boolean(entry));
  const missing = requiredMetricNames.filter((entry) => !names.has(entry));
  return missing.length > 0 ? `Missing metrics: ${missing.join(", ")}` : "";
}
