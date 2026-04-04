import type {
  BuildChangeTaskPayload,
  EvaluateBranchTaskPayload,
  PlannerTaskPayload,
  ResearchIsolationMode,
  ResearchPriorityScore,
  ResearchTaskPayload,
  ResearchTaskTimeoutPolicy,
  ResearchWorkItemExecutor,
  ResearchWorkItemKind,
  ResearchWorkItemLane,
  ResearchWorkItemRecord,
  RunExperimentTaskPayload
} from "../../shared/types";

type NormalizedTaskContract = {
  kind: ResearchWorkItemKind;
  lane: ResearchWorkItemLane;
  executor: ResearchWorkItemExecutor;
  isolation: ResearchIsolationMode;
  executionMode: ResearchWorkItemRecord["executionMode"];
  timeoutPolicy: ResearchTaskTimeoutPolicy;
};

const PRIORITY_BASELINES: Record<
  ResearchWorkItemKind,
  Omit<ResearchPriorityScore, "total">
> = {
  plan: baseScore(0.82, 0.9, 0.82, 0.2, 0.72, 0.02, 0.55),
  discover: baseScore(0.74, 0.96, 0.6, 0.66, 0.84, 0.08, 0.52),
  read_synthesize: baseScore(0.8, 0.88, 0.76, 0.34, 0.78, 0.04, 0.68),
  build_change: baseScore(0.9, 0.7, 0.86, 0.45, 0.7, 0.06, 0.78),
  run_experiment: baseScore(0.94, 0.92, 0.74, 0.6, 0.72, 0.06, 1),
  evaluate_branch: baseScore(0.84, 0.78, 0.93, 0.22, 0.68, 0.02, 0.94),
  arbitrate_branch: baseScore(0.86, 0.62, 0.98, 0.1, 0.6, 0, 0.86)
};

export function normalizeTaskContract(
  kind: ResearchWorkItemKind,
  executor?: ResearchWorkItemExecutor,
  isolation?: ResearchIsolationMode
): NormalizedTaskContract {
  const normalizedKind = normalizeKind(kind);
  const normalizedExecutor = normalizeExecutor(normalizedKind, executor);
  const normalizedIsolation =
    isolation ??
    (normalizedExecutor === "builder" || normalizedExecutor === "experimenter" ? "worktree" : "none");
  const lane = resolveLane(normalizedExecutor);
  return {
    kind: normalizedKind,
    lane,
    executor: normalizedExecutor,
    isolation: normalizedIsolation,
    executionMode: normalizedIsolation === "worktree" ? "isolated" : normalizedExecutor === "arbiter" ? "sync" : "async",
    timeoutPolicy: defaultTimeoutPolicy(normalizedKind)
  };
}

export function createTaskRecord(input: {
  id: string;
  objectiveId: string;
  branchId: string;
  title: string;
  prompt: string;
  kind: ResearchWorkItemKind;
  executor?: ResearchWorkItemExecutor;
  isolation?: ResearchIsolationMode;
  sourceIds?: string[];
  dependsOnIds?: string[];
  payload?: ResearchTaskPayload;
  now?: string;
  priorityScore?: ResearchPriorityScore;
  timeoutPolicy?: ResearchTaskTimeoutPolicy;
}) {
  const now = input.now ?? new Date().toISOString();
  const normalized = normalizeTaskContract(input.kind, input.executor, input.isolation);
  return {
    id: input.id,
    objectiveId: input.objectiveId,
    branchId: input.branchId,
    kind: normalized.kind,
    lane: normalized.lane,
    executor: normalized.executor,
    title: input.title,
    prompt: input.prompt,
    status: "pending" as const,
    executionMode: normalized.executionMode,
    isolation: normalized.isolation,
    priorityScore: input.priorityScore ?? buildResearchPriorityScore({ kind: normalized.kind }),
    sourceIds: input.sourceIds ?? [],
    dependsOnIds: input.dependsOnIds ?? [],
    payload: input.payload,
    timeoutPolicy: input.timeoutPolicy ?? normalized.timeoutPolicy,
    maxAttempts: 1,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now
  } satisfies ResearchWorkItemRecord;
}

export function createPlannerPayload(input: {
  objectiveId: string;
  activeBranchId: string;
  goal: string;
}): PlannerTaskPayload {
  return {
    objectiveId: input.objectiveId,
    activeBranchId: input.activeBranchId,
    goal: input.goal
  };
}

export function createBuildPayload(input: {
  branchId: string;
  goal: string;
  constraints?: string[];
  verificationCommands?: string[];
  successCriteria?: string[];
}): BuildChangeTaskPayload {
  return {
    branchId: input.branchId,
    goal: input.goal,
    constraints: input.constraints ?? [],
    verificationCommands: input.verificationCommands ?? [],
    successCriteria: input.successCriteria ?? []
  };
}

export function createExperimentPayload(input: {
  branchId: string;
  commands: string[];
  timeoutMs?: number;
  expectedMetrics?: RunExperimentTaskPayload["expectedMetrics"];
}): RunExperimentTaskPayload {
  return {
    branchId: input.branchId,
    commands: input.commands,
    timeoutMs: input.timeoutMs ?? defaultTimeoutPolicy("run_experiment").wallMs,
    expectedMetrics: input.expectedMetrics ?? []
  };
}

export function createEvaluatePayload(input: {
  branchId: string;
  compareToBranchId?: string;
  focus: string;
}): EvaluateBranchTaskPayload {
  return {
    branchId: input.branchId,
    compareToBranchId: input.compareToBranchId,
    focus: input.focus
  };
}

export function buildResearchPriorityScore(input: {
  kind?: ResearchWorkItemKind;
  objectiveAlignment?: number;
  expectedInformationGain?: number;
  feasibility?: number;
  estimatedCost?: number;
  branchFreshness?: number;
  duplicationPenalty?: number;
  reproducibilityPriority?: number;
}) {
  const kind = normalizeKind(input.kind ?? "plan");
  const base = PRIORITY_BASELINES[kind];
  const score = {
    objectiveAlignment: clamp01(input.objectiveAlignment ?? base.objectiveAlignment),
    expectedInformationGain: clamp01(input.expectedInformationGain ?? base.expectedInformationGain),
    feasibility: clamp01(input.feasibility ?? base.feasibility),
    estimatedCost: clamp01(input.estimatedCost ?? base.estimatedCost),
    branchFreshness: clamp01(input.branchFreshness ?? base.branchFreshness),
    duplicationPenalty: clamp01(input.duplicationPenalty ?? base.duplicationPenalty),
    reproducibilityPriority: clamp01(input.reproducibilityPriority ?? base.reproducibilityPriority)
  };
  return {
    ...score,
    total: roundScore(
      score.objectiveAlignment * 3 +
        score.expectedInformationGain * 3 +
        score.feasibility * 2 +
        score.branchFreshness * 1.5 +
        score.reproducibilityPriority * 1.5 -
        score.estimatedCost * 1.5 -
        score.duplicationPenalty * 2
    )
  };
}

export function isOracleExecutor(executor?: ResearchWorkItemExecutor) {
  return executor === "planner" || executor === "discoverer" || executor === "reader-synthesizer";
}

export function isCodexExecutor(executor?: ResearchWorkItemExecutor) {
  return executor === "builder" || executor === "experimenter" || executor === "evaluator";
}

export function isTerminalTaskStatus(status: ResearchWorkItemRecord["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function normalizeKind(kind: ResearchWorkItemKind): ResearchWorkItemKind {
  return kind;
}

function normalizeExecutor(kind: ResearchWorkItemKind, executor?: ResearchWorkItemExecutor): ResearchWorkItemExecutor {
  if (executor) {
    return executor;
  }

  switch (kind) {
    case "plan":
      return "planner";
    case "discover":
      return "discoverer";
    case "read_synthesize":
      return "reader-synthesizer";
    case "build_change":
      return "builder";
    case "run_experiment":
      return "experimenter";
    case "evaluate_branch":
      return "evaluator";
    case "arbitrate_branch":
      return "arbiter";
    default:
      return "planner";
  }
}

function resolveLane(executor: ResearchWorkItemExecutor): ResearchWorkItemLane {
  switch (executor) {
    case "planner":
      return "plan";
    case "discoverer":
      return "discover";
    case "reader-synthesizer":
      return "synthesis";
    case "builder":
      return "build";
    case "experimenter":
      return "experiment";
    case "evaluator":
      return "evaluate";
    case "arbiter":
      return "arbiter";
    default:
      return "plan";
  }
}

function defaultTimeoutPolicy(kind: ResearchWorkItemKind): ResearchTaskTimeoutPolicy {
  switch (kind) {
    case "plan":
      return { wallMs: 5 * 60_000, silenceMs: 90_000 };
    case "discover":
    case "read_synthesize":
      return { wallMs: 10 * 60_000, silenceMs: 2 * 60_000 };
    case "build_change":
    case "run_experiment":
      return { wallMs: 20 * 60_000, silenceMs: 3 * 60_000 };
    case "evaluate_branch":
      return { wallMs: 5 * 60_000, silenceMs: 90_000 };
    case "arbitrate_branch":
      return { wallMs: 30_000, silenceMs: 30_000 };
    default:
      return { wallMs: 5 * 60_000, silenceMs: 90_000 };
  }
}

function baseScore(
  objectiveAlignment: number,
  expectedInformationGain: number,
  feasibility: number,
  estimatedCost: number,
  branchFreshness: number,
  duplicationPenalty: number,
  reproducibilityPriority: number
) {
  return {
    objectiveAlignment,
    expectedInformationGain,
    feasibility,
    estimatedCost,
    branchFreshness,
    duplicationPenalty,
    reproducibilityPriority
  };
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
