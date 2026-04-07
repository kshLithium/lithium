import type {
  AppSettings,
  BuildTaskPayload,
  DiscoverTaskPayload,
  DiscoveredSourceSpec,
  PlannerProposal,
  ReadTaskPayload,
  SynthesizedFindingSpec,
  TaskOutcome,
  TaskRecord,
  WorkerRunRecord
} from "../../../shared/types";
import { OracleRunner } from "../../services/oracle-runner";
import {
  LITHIUM_DISCOVER_MARKER,
  LITHIUM_PLAN_MARKER,
  LITHIUM_READ_MARKER,
  parseDiscoverOutput,
  parsePlannerOutput,
  parseReadOutput
} from "../../services/protocol";
import { ArtifactStore } from "../artifact-store";
import { ResearchStore } from "../store";
import { createId, nowIso } from "../utils";
import { isPidAlive, terminateByPid, waitForPidExit } from "./process-recovery";
import type { ProviderContext, ProviderHandle, ProviderRecoveryContext, TaskProvider } from "./types";

export class StrategistProvider implements TaskProvider {
  constructor(
    private readonly deps: {
      oracleRunner: OracleRunner;
      artifactStore: ArtifactStore;
      store: ResearchStore;
      settings: AppSettings;
    }
  ) {}

  supports(kind: TaskRecord["kind"]) {
    return kind === "plan" || kind === "discover" || kind === "read_synthesize";
  }

  async start(context: ProviderContext): Promise<ProviderHandle> {
    const artifacts = await this.deps.artifactStore.allocateRunArtifacts(context.workspacePath, "strategist", createId("oracle"));
    const files = await this.resolveAttachedFiles(context);
    const prompt = buildStrategistPrompt(context);
    const session = await this.deps.oracleRunner.startConsult({
      workspacePath: context.workspacePath,
      prompt,
      model: this.deps.settings.oracleModel,
      browserThinkingTime: this.deps.settings.oracleThinkingTime,
      files,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      outputPath: artifacts.outputPath,
      slug: artifacts.id,
      oracleSessionReady: true
    });

    const workerRun: WorkerRunRecord = {
      id: artifacts.id,
      taskId: context.task.id,
      runId: context.run.id,
      objectiveId: context.objective.id,
      branchId: context.task.branchId,
      provider: "strategist",
      command: session.command,
      status: "running",
      pid: session.pid,
      model: this.deps.settings.oracleModel,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      outputPath: artifacts.outputPath,
      metadata: {
        kind: context.task.kind,
        files
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
          task: context.task,
          workerRun,
          rawOutput:
            result.outputText ||
            [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
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
        const rawOutput = await this.deps.artifactStore.readText(
          context.workerRun.outputPath
            ? {
                id: createId("art"),
                kind: "output",
                path: context.workerRun.outputPath,
                createdAt: nowIso()
              }
            : null
        );
        return await this.finalize({
          task: context.task,
          workerRun: context.workerRun,
          rawOutput
        });
      })()
    };
  }

  private async finalize(input: {
    task: TaskRecord;
    workerRun: WorkerRunRecord;
    rawOutput: string;
  }): Promise<TaskOutcome> {
    const artifactRefs = [
      {
        id: createId("art"),
        kind: "stdout" as const,
        path: input.workerRun.stdoutPath,
        createdAt: nowIso()
      },
      {
        id: createId("art"),
        kind: "stderr" as const,
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
    ];

    if (input.task.kind === "plan") {
      const plan = parsePlannerOutput(input.rawOutput);
      if (!plan.ok) {
        return {
          status: "failed",
          summary: "Planner output violated the structured protocol.",
          failureReason: plan.error,
          retryability: "retryable",
          artifactRefs,
          changedFiles: [],
          metrics: []
        };
      }
      return {
        status: "completed",
        summary: plan.value.summary || "Planner completed.",
        retryability: "needs-human",
        artifactRefs,
        changedFiles: [],
        metrics: [],
        plan: plan.value
      };
    }

    if (input.task.kind === "discover") {
      const discover = parseDiscoverOutput(input.rawOutput);
      if (!discover.ok) {
        return {
          status: "failed",
          summary: "Discover output violated the structured protocol.",
          failureReason: discover.error,
          retryability: "retryable",
          artifactRefs,
          changedFiles: [],
          metrics: []
        };
      }
      return {
        status: "completed",
        summary: discover.value.summary || "Discovery completed.",
        retryability: "needs-human",
        artifactRefs,
        changedFiles: [],
        metrics: [],
        discoveredSources: discover.value.sources
      };
    }

    const read = parseReadOutput(input.rawOutput);
    if (!read.ok) {
      return {
        status: "failed",
        summary: "Read/synthesize output violated the structured protocol.",
        failureReason: read.error,
        retryability: "retryable",
        artifactRefs,
        changedFiles: [],
        metrics: []
      };
    }
    return {
      status: "completed",
      summary: read.value.summary || "Synthesis completed.",
      retryability: "needs-human",
      artifactRefs,
      changedFiles: [],
      metrics: [],
      findings: read.value.findings
    };
  }

  private async resolveAttachedFiles(context: ProviderContext) {
    if (context.task.kind !== "read_synthesize") {
      return [];
    }
    const payload = context.task.payload as ReadTaskPayload;
    return this.deps.store
      .listProjections(context.workspacePath, "source")
      .filter((entry) => payload.sourceIds.includes(entry.id))
      .map((entry) => entry.textArtifactRef?.path ?? entry.bodyArtifactRef?.path ?? "")
      .filter(Boolean)
      .slice(0, 12);
  }
}

function buildStrategistPrompt(context: ProviderContext) {
  switch (context.task.kind) {
    case "plan":
      return [
        "You are the strategist for Lithium V5.",
        `Return ${LITHIUM_PLAN_MARKER} followed by one JSON object.`,
        "Required top-level keys: summary, rationale, proposedBranches, proposedTasks.",
        "Each proposedBranch needs title and hypothesis.",
        "Each proposedTask needs stepId, title, prompt, kind, dependsOn, expectedInfoGain, estimatedCost, evidenceNeeded, successRubric, stopCondition, branchUpdateIntent.",
        "Allowed kinds: discover, read_synthesize, build_change, verify_change, run_experiment, evaluate_branch, promote_patch.",
        "For verify_change and run_experiment, include experiment_spec with cwd, commands, timeoutMs, mode, expectedMetrics, artifactGlobs.",
        "For build_change, include verification_spec when the build should be followed by a declarative verification step.",
        "Allowed branchUpdateIntent values: advance, branch, verify, kill.",
        "",
        "CURRENT_CONTEXT:",
        context.contextText.trim()
      ].join("\n");
    case "discover":
      return [
        "You are the discoverer for Lithium V5.",
        `Return ${LITHIUM_DISCOVER_MARKER} followed by one JSON object.`,
        "Required keys: summary, sources.",
        "Each source needs locator, title, kind, summary. Allowed kinds: web, repo, paper.",
        "",
        "CURRENT_CONTEXT:",
        context.contextText.trim()
      ].join("\n");
    case "read_synthesize":
      return [
        "You are the reader-synthesizer for Lithium V5.",
        `Return ${LITHIUM_READ_MARKER} followed by one JSON object.`,
        "Required keys: summary, findings.",
        "Each finding needs summary and source_locator. Optional: detail, citation_text.",
        "",
        "CURRENT_CONTEXT:",
        context.contextText.trim()
      ].join("\n");
    default:
      return context.contextText;
  }
}
