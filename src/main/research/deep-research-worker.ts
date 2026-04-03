import type { ProjectSnapshot, StrategistRequest } from "../../shared/types";

type StrategistExecutor = (request: StrategistRequest) => Promise<ProjectSnapshot>;

export type DeepResearchExecutionResult = {
  snapshot: ProjectSnapshot;
  summary: string;
  risks: string[];
  openQuestions: string[];
  runActions: string[];
  decisionId?: string;
};

export class DeepResearchWorkerAdapter {
  constructor(private readonly execute: StrategistExecutor) {}

  async run(input: {
    workspacePath: string;
    threadId: string;
    prompt: string;
    displayPrompt: string;
  }): Promise<DeepResearchExecutionResult> {
    const snapshot = await this.execute({
      workspacePath: input.workspacePath,
      threadId: input.threadId,
      prompt: input.prompt,
      displayPrompt: input.displayPrompt,
      attachExplicitWorkspaceFiles: false
    });
    const latestDecision = snapshot.latestDecision;

    return {
      snapshot,
      summary: latestDecision?.summary || "Strategist returned no concrete summary.",
      risks: latestDecision?.handoff?.risks ?? [],
      openQuestions: latestDecision?.handoff?.openQuestions ?? [],
      runActions: latestDecision?.handoff?.runActions ?? [],
      decisionId: latestDecision?.id
    };
  }
}
