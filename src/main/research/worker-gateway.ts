import type {
  AutomationSessionRecord,
  ResearchBranchRecord,
  ResearchEvaluationVerdict,
  ResearchPriorityScore,
  ResearchWorkItemRecord
} from "../../shared/types";
import { BuilderEditorWorkerAdapter, type BuilderWorkerExecutionResult } from "./builder-editor-worker";
import { DeepResearchWorkerAdapter, type DeepResearchExecutionResult } from "./deep-research-worker";
import { ExperimentRunnerWorkerAdapter, type ExperimentWorkerExecutionResult } from "./experiment-runner-worker";
import { type PlannerDecision, PlannerRunner } from "./planner-runner";
import { EvaluatorRunner, type EvaluatorDecision } from "./evaluator-runner";
import { WorktreeManager } from "./worktree-manager";
import { buildResearchPriorityScore } from "./policy/scheduler-policy";

export type ResearchPlanningInput = {
  workspacePath: string;
  session: AutomationSessionRecord;
  objectiveSummary: string;
  branch: ResearchBranchRecord | null;
  runtimeContext: string;
  redirectInstruction?: string;
};

export type ResearchPlanningResult = PlannerDecision;

export type ResearchEvaluationInput = {
  workspacePath: string;
  branch: ResearchBranchRecord;
  workItem: ResearchWorkItemRecord;
  executionSummary: string;
  runtimeContext: string;
  executionStatus: "completed" | "failed" | "cancelled";
};

export type ResearchEvaluationResult = EvaluatorDecision;

export type ResearchWorkItemExecutionResult = {
  summary: string;
  status: "completed" | "failed" | "cancelled";
  changedFiles: string[];
  risks: string[];
  openQuestions: string[];
  runActions: string[];
  decisionId?: string;
  runId?: string;
  worktreePath?: string;
};

export class WorkerGateway {
  constructor(
    private readonly deps: {
      plannerRunner?: PlannerRunner;
      evaluatorRunner?: EvaluatorRunner;
      worktreeManager?: WorktreeManager;
      builderEditorWorker: BuilderEditorWorkerAdapter;
      experimentRunnerWorker: ExperimentRunnerWorkerAdapter;
      deepResearchWorker: DeepResearchWorkerAdapter;
    }
  ) {}

  async supportsWorkspace(workspacePath: string) {
    return await (this.deps.worktreeManager ?? new WorktreeManager()).supportsWorkspace(workspacePath);
  }

  async plan(input: ResearchPlanningInput): Promise<ResearchPlanningResult> {
    try {
      const runner = this.deps.plannerRunner ?? new PlannerRunner();
      const result = await runner.plan({
        workspacePath: input.workspacePath,
        objective: input.redirectInstruction?.trim() || input.session.objective,
        runtimeContext: input.runtimeContext
      });

      if (result.decision.workItems.length > 0 || result.decision.branches.length > 0) {
        return result.decision;
      }
    } catch {
      // Fall through to a deterministic heuristic plan.
    }

    const branchTitle = input.branch?.title || "Primary branch";
    const plannerPrompt =
      input.redirectInstruction?.trim() ||
      (input.branch
        ? `Advance ${branchTitle} with the next bounded step, favoring reproducible evidence.`
        : `Refresh the research direction for: ${input.session.objective}`);

    return {
      summary: "Planned the next research queue with the local heuristic.",
      rationale: "No structured planner output was available, so the engine kept the queue small and evidence-oriented.",
      branches: input.branch
        ? []
        : [
            {
              title: branchTitle,
              hypothesis: input.session.objective
            }
          ],
      workItems: [
        input.branch
          ? {
              title: `Execute the next bounded experiment for ${branchTitle}`,
              prompt: plannerPrompt,
              kind: "experiment",
              lane: "experiment",
              executionMode: "isolated",
              branchTitle
            }
          : {
              title: "Refresh the strategic research direction",
              prompt: plannerPrompt,
              kind: "deep-research",
              lane: "research",
              executionMode: "sync",
              branchTitle
            }
      ]
    };
  }

  async evaluate(input: ResearchEvaluationInput): Promise<ResearchEvaluationResult> {
    try {
      const runner = this.deps.evaluatorRunner ?? new EvaluatorRunner();
      const result = await runner.evaluate({
        workspacePath: input.workspacePath,
        branchTitle: input.branch.title,
        workItemTitle: input.workItem.title,
        executionSummary: input.executionSummary,
        runtimeContext: input.runtimeContext
      });
      return result.decision;
    } catch {
      // Fall through to a deterministic heuristic evaluation.
    }

    const verdict: ResearchEvaluationVerdict =
      input.executionStatus === "completed" ? "continue" : input.executionStatus === "cancelled" ? "pivot" : "kill";

    return {
      verdict,
      scoreDelta: verdict === "continue" ? 0.08 : verdict === "pivot" ? -0.03 : -0.12,
      summary:
        verdict === "continue"
          ? "The latest work item produced enough signal to continue the branch."
          : verdict === "pivot"
          ? "The latest work item was interrupted, so the branch should pivot instead of assuming success."
          : "The latest work item failed hard enough to stop or demote the current branch.",
      rationale: input.executionSummary,
      followupPrompt:
        verdict === "continue"
          ? "Schedule the next bounded step that converts this evidence into a reproducible result."
          : verdict === "pivot"
          ? "Replan from the newest evidence and choose a safer bounded step."
          : "Kill or demote this branch and replan from a different branch."
    };
  }

  async executeWorkItem(input: {
    workspacePath: string;
    threadId: string;
    workItem: ResearchWorkItemRecord;
  }): Promise<ResearchWorkItemExecutionResult> {
    if (input.workItem.kind === "deep-research") {
      const result = await this.deps.deepResearchWorker.run({
        workspacePath: input.workspacePath,
        threadId: input.threadId,
        prompt: input.workItem.prompt,
        displayPrompt: input.workItem.title
      });
      return normalizeDeepResearchResult(result);
    }

    const shouldIsolate = input.workItem.executionMode === "isolated" || input.workItem.kind === "experiment";
    const worktreePath = shouldIsolate
      ? (await (this.deps.worktreeManager ?? new WorktreeManager()).prepareRunWorkspace(
          input.workspacePath,
          input.workItem.id
        )).worktreePath
      : undefined;

    const sharedExecution = {
      workspacePath: input.workspacePath,
      threadId: input.threadId,
      prompt: input.workItem.prompt,
      displayPrompt: input.workItem.title,
      executionWorkspacePath: worktreePath,
      worktreePath
    };

    const result =
      input.workItem.kind === "experiment"
        ? await this.deps.experimentRunnerWorker.run(sharedExecution)
        : await this.deps.builderEditorWorker.run(sharedExecution);

    return normalizeBuilderResult(result);
  }

  buildPriorityScore(input: {
    kind: ResearchWorkItemRecord["kind"];
    overrides?: Partial<Omit<ResearchPriorityScore, "total">>;
  }) {
    return buildResearchPriorityScore({
      kind: input.kind,
      ...input.overrides
    });
  }
}

function normalizeBuilderResult(
  result: BuilderWorkerExecutionResult | ExperimentWorkerExecutionResult
): ResearchWorkItemExecutionResult {
  return {
    summary: result.summary,
    status: result.status,
    changedFiles: result.changedFiles,
    risks: result.risks,
    openQuestions: result.openQuestions,
    runActions: result.runActions,
    runId: result.runId,
    worktreePath: result.worktreePath
  };
}

function normalizeDeepResearchResult(result: DeepResearchExecutionResult): ResearchWorkItemExecutionResult {
  return {
    summary: result.summary,
    status: "completed",
    changedFiles: [],
    risks: result.risks,
    openQuestions: result.openQuestions,
    runActions: result.runActions,
    decisionId: result.decisionId
  };
}
