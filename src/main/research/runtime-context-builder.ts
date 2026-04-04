import { readFile } from "node:fs/promises";
import type { AttachmentRecord, RunRecord } from "../../shared/types";
import { RecordStore } from "../services/record-store";
import { buildProjectPaths } from "../services/workspace-layout";
import { extractFinalSummary } from "../services/run-artifacts";
import { ResearchStateStore } from "./state-store";
import { ArtifactService } from "./artifact-service";

export class RuntimeContextBuilder {
  private readonly records = new RecordStore();

  constructor(
    private readonly deps: {
      stateStore: ResearchStateStore;
      artifactService: ArtifactService;
    }
  ) {}

  async build(workspacePath: string, objectiveId: string) {
    const state = await this.deps.stateStore.readState(workspacePath, objectiveId);
    const objective = state.latestObjective;

    if (!objective) {
      return "";
    }

    const activeBranch =
      state.branches.find((entry) => entry.id === objective.activeBranchId) ??
      state.latestBranch ??
      null;
    const recentAttachments = (await this.listAttachments(workspacePath, objective.id)).slice(0, 5);
    const recentExperiments = await this.deps.artifactService.readRecentExperimentResults(workspacePath, objective.id, 4);
    const recentRuns = await this.readBuilderRuns(workspacePath, objective.id);
    const recentLogs = await this.readRecentLogs(workspacePath);

    return [
      `OBJECTIVE: ${objective.objective}`,
      `OBJECTIVE_SUMMARY: ${objective.summary}`,
      `ACTIVE_BRANCH: ${activeBranch?.title || "none"}`,
      `ACTIVE_BRANCH_HYPOTHESIS: ${activeBranch?.hypothesis || "none"}`,
      `LATEST_EVALUATION: ${state.latestEvaluation?.summary || "none"}`,
      `RECENT_SOURCES:`,
      ...state.sources
        .slice(0, 6)
        .map((entry) => `- [${entry.kind}] ${entry.title} | ${entry.provenance} | ${entry.excerpt || entry.summary}`),
      `RECENT_FINDINGS:`,
      ...state.findings.slice(0, 6).map((entry) => `- ${entry.summary}`),
      `ATTACHMENTS:`,
      ...recentAttachments.map((entry) => `- [${entry.kind}] ${entry.relativePath}: ${entry.excerpt || "no excerpt"}`),
      `QUEUE:`,
      ...state.workItems
        .filter((entry) => entry.status === "pending")
        .slice(0, 6)
        .map((entry) => `- [${entry.executor}] ${entry.title}`),
      `RECENT_EXPERIMENTS:`,
      ...recentExperiments.map((entry) => `- ${entry.status}: ${entry.summary}`),
      `RECENT_RUNS:`,
      ...recentRuns.slice(0, 4).map((entry) => `- ${entry.status}: ${extractFinalSummary(entry.finalMessage) || entry.prompt}`),
      `RECENT_LOGS:`,
      ...recentLogs.slice(0, 8).map((entry) => `- ${entry}`)
    ].join("\n");
  }

  private async listAttachments(workspacePath: string, objectiveId: string) {
    return (await this.records.readRecordDirectory<AttachmentRecord>(buildProjectPaths(workspacePath).attachmentRecordsDir))
      .filter((record) => record.objectiveId === objectiveId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async readBuilderRuns(workspacePath: string, objectiveId: string) {
    const runs = await this.records.readRecordDirectory<RunRecord>(buildProjectPaths(workspacePath).runsDir);
    return runs
      .filter((entry) => entry.threadId === objectiveId)
      .sort((left, right) => (right.endedAt ?? right.startedAt).localeCompare(left.endedAt ?? left.startedAt));
  }

  private async readRecentLogs(workspacePath: string) {
    const content = await readFile(buildProjectPaths(workspacePath).activityLog, "utf8").catch(() => "");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-40)
      .reverse();
  }
}
