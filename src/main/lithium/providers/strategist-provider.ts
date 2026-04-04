import type {
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
      model: "gpt-5.4-pro",
      browserThinkingTime: "extended",
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
      model: "gpt-5.4-pro",
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
      return {
        status: "completed",
        summary: plan.summary || "Planner completed.",
        retryability: "needs-human",
        artifactRefs,
        changedFiles: [],
        metrics: [],
        plan
      };
    }

    if (input.task.kind === "discover") {
      const discover = parseDiscoverOutput(input.rawOutput);
      return {
        status: "completed",
        summary: discover.summary || "Discovery completed.",
        retryability: "needs-human",
        artifactRefs,
        changedFiles: [],
        metrics: [],
        discoveredSources: discover.sources
      };
    }

    const read = parseReadOutput(input.rawOutput);
    return {
      status: "completed",
      summary: read.summary || "Synthesis completed.",
      retryability: "needs-human",
      artifactRefs,
      changedFiles: [],
      metrics: [],
      findings: read.findings
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
        "You are the strategist for Lithium V4.",
        `Return ${LITHIUM_PLAN_MARKER} followed by one JSON object.`,
        "Required top-level keys: summary, rationale, proposedBranches, proposedTasks.",
        "Each proposedBranch needs title and hypothesis.",
        "Each proposedTask needs title, prompt, kind, expectedInfoGain, estimatedCost, evidenceNeeded, successRubric, stopCondition, dependencyMode, branchUpdateIntent.",
        "Allowed kinds: discover, read_synthesize, build_change, run_experiment, evaluate_branch.",
        "Allowed dependencyMode values: success, failed, terminal.",
        "Allowed branchUpdateIntent values: advance, branch, verify, kill.",
        "",
        "CURRENT_CONTEXT:",
        context.contextText.trim()
      ].join("\n");
    case "discover":
      return [
        "You are the discoverer for Lithium V4.",
        `Return ${LITHIUM_DISCOVER_MARKER} followed by one JSON object.`,
        "Required keys: summary, sources.",
        "Each source needs locator, title, kind, summary. Allowed kinds: web, repo, paper.",
        "",
        "CURRENT_CONTEXT:",
        context.contextText.trim()
      ].join("\n");
    case "read_synthesize":
      return [
        "You are the reader-synthesizer for Lithium V4.",
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
