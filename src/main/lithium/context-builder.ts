import type {
  BranchRecord,
  EvaluateTaskPayload,
  ObjectiveRecord,
  RunRecord,
  TaskRecord
} from "../../shared/types";
import { ArtifactStore } from "./artifact-store";
import { SourceIngest } from "./source-ingest";
import { ResearchStore } from "./store";

export class ContextBuilder {
  constructor(
    private readonly deps: {
      store: ResearchStore;
      sourceIngest: SourceIngest;
      artifactStore: ArtifactStore;
    }
  ) {}

  async build(input: {
    workspacePath: string;
    objective: ObjectiveRecord;
    branch: BranchRecord | null;
    run: RunRecord;
    task: TaskRecord;
  }) {
    const projection = this.deps.store.getProjection(input.workspacePath);
    const retrievalChunks = await this.deps.sourceIngest.search({
      workspacePath: input.workspacePath,
      objectiveId: input.objective.id,
      branchId: input.branch?.id,
      query: `${input.task.title}\n${input.task.prompt}`,
      limit: input.task.kind === "evaluate_branch" ? 3 : 5
    });
    const sections = [
      "OBJECTIVE",
      `- title: ${input.objective.title}`,
      `- summary: ${input.objective.summary || input.objective.objective}`,
      `- success criteria: ${input.objective.successCriteria.join(" | ") || "none"}`,
      "",
      "RUN",
      `- status: ${input.run.status}`,
      `- budget usage: planning=${input.run.budgetUsage.planning}/${input.run.budget.planning}, discovery=${input.run.budgetUsage.discovery}/${input.run.budget.discovery}, build=${input.run.budgetUsage.build}/${input.run.budget.build}, experiment=${input.run.budgetUsage.experiment}/${input.run.budget.experiment}, evaluation=${input.run.budgetUsage.evaluation}/${input.run.budget.evaluation}`,
      "",
      "BRANCH",
      input.branch
        ? `- ${input.branch.title} [${input.branch.status}] score=${input.branch.score.toFixed(3)}`
        : "- none",
      input.branch ? `- hypothesis: ${input.branch.hypothesis}` : null,
      "",
      "QUEUE",
      ...projection.tasks
        .filter((entry) => entry.runId === input.run.id)
        .filter((entry) => entry.status === "pending" || entry.status === "running")
        .slice(0, 8)
        .map((entry) => `- ${entry.status} ${entry.kind}: ${entry.title}`),
      "",
      "RECENT_FINDINGS",
      ...projection.findings
        .filter((entry) => !input.branch || entry.branchId === input.branch.id)
        .slice(0, 5)
        .map((entry) => `- ${entry.summary}`),
      "",
      "RETRIEVAL",
      ...(retrievalChunks.length > 0
        ? retrievalChunks.map((entry) => `- [${entry.sourceId}#${entry.chunkIndex}] ${entry.text.slice(0, 320)}`)
        : ["- none"])
    ].filter((entry): entry is string => Boolean(entry));

    if (input.task.kind === "evaluate_branch") {
      sections.push("", "EVALUATION_INPUT", ...(await this.buildEvaluationSection(input.workspacePath, input.task)));
    }

    return sections.join("\n");
  }

  private async buildEvaluationSection(workspacePath: string, task: TaskRecord) {
    const payload = task.payload as EvaluateTaskPayload;
    const projection = this.deps.store.getProjection(workspacePath);
    const subjectTask = projection.tasks.find((entry) => entry.id === payload.subjectTaskId) ?? null;
    const sourceSnippets = await Promise.all(
      payload.sourceRefs.slice(0, 4).map(async (sourceId) => {
        const source = projection.sources.find((entry) => entry.id === sourceId);
        if (!source?.textArtifactRef) {
          return source ? `- source ${source.id}: ${source.summary}` : "";
        }
        const body = await this.deps.artifactStore.readText(source.textArtifactRef);
        return `- source ${source.id}: ${body.slice(0, 300)}`;
      })
    );
    const workerRun = payload.workerRunId
      ? projection.workerRuns.find((entry) => entry.id === payload.workerRunId) ?? null
      : null;
    const stdout = workerRun?.stdoutPath
      ? await this.deps.artifactStore.readText({
          id: "tmp",
          kind: "stdout",
          path: workerRun.stdoutPath,
          createdAt: ""
        })
      : "";
    const stderr = workerRun?.stderrPath
      ? await this.deps.artifactStore.readText({
          id: "tmp",
          kind: "stderr",
          path: workerRun.stderrPath,
          createdAt: ""
        })
      : "";
    const patch = payload.patchArtifactRef ? await this.deps.artifactStore.readText(payload.patchArtifactRef) : "";
    const metrics = projection.metrics
      .filter((entry) => payload.metricRefs.includes(entry.id))
      .map((entry) => `- ${entry.name}: ${entry.value}${entry.unit ? ` ${entry.unit}` : ""}`);

    return [
      `- focus: ${payload.focus}`,
      `- subject task: ${subjectTask?.title ?? payload.subjectTaskId}`,
      `- subject status: ${payload.subjectTaskStatus}`,
      payload.changedFiles.length > 0 ? `- changed files: ${payload.changedFiles.join(", ")}` : "- changed files: none",
      payload.successCriteria.length > 0 ? `- success criteria: ${payload.successCriteria.join(" | ")}` : "- success criteria: none",
      metrics.length > 0 ? metrics.join("\n") : "- metrics: none",
      patch ? `- patch excerpt: ${patch.slice(0, 600)}` : "- patch excerpt: none",
      stdout ? `- stdout tail: ${stdout.slice(-600)}` : "- stdout tail: none",
      stderr ? `- stderr tail: ${stderr.slice(-600)}` : "- stderr tail: none",
      ...sourceSnippets.filter(Boolean)
    ];
  }
}
