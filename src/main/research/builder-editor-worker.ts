import type { BuilderRequest, ProjectSnapshot } from "../../shared/types";
import { extractFinalSummary } from "../services/run-artifacts";

type BuilderExecutor = (request: BuilderRequest) => Promise<ProjectSnapshot>;

export type BuilderWorkerExecutionResult = {
  snapshot: ProjectSnapshot;
  summary: string;
  status: "completed" | "failed" | "cancelled";
  changedFiles: string[];
  risks: string[];
  openQuestions: string[];
  runActions: string[];
  runId?: string;
  worktreePath?: string;
};

export class BuilderEditorWorkerAdapter {
  constructor(private readonly execute: BuilderExecutor) {}

  async run(input: {
    workspacePath: string;
    threadId: string;
    prompt: string;
    displayPrompt: string;
    executionWorkspacePath?: string;
    worktreePath?: string;
  }): Promise<BuilderWorkerExecutionResult> {
    const snapshot = await this.execute({
      workspacePath: input.workspacePath,
      threadId: input.threadId,
      prompt: input.prompt,
      displayPrompt: input.displayPrompt,
      executionWorkspacePath: input.executionWorkspacePath
    });
    const latestRun = snapshot.latestRun;

    return {
      snapshot,
      summary: extractFinalSummary(latestRun?.finalMessage || "") || "Builder finished without a final summary.",
      status:
        latestRun?.status === "completed" || latestRun?.status === "cancelled" || latestRun?.status === "failed"
          ? latestRun.status
          : "failed",
      changedFiles: latestRun?.changedFiles ?? [],
      risks: latestRun?.handoff?.risks ?? [],
      openQuestions: latestRun?.handoff?.openQuestions ?? [],
      runActions: latestRun?.handoff?.runActions ?? [],
      runId: latestRun?.id,
      worktreePath: input.worktreePath
    };
  }
}
