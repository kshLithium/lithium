import path from "node:path";
import { PROJECT_SCHEMA_VERSION } from "../../shared/types";

export const LITHIUM_DIR = ".lithium";
export const PROJECT_FILE = "project.json";
export const ACTIVITY_LOG = "activity.log";
export const PROMPT_LOG = "prompt-log.jsonl";
export const WORKER_HISTORY_LOG = "worker-history.jsonl";
export const PROJECT_VOLATILE_RUNTIME_DIRECTORIES = [
  "automation/sessions",
  "automation/cycles",
  "automation/steps",
  "automation/checkpoints",
  "orchestrator"
] as const;

export type ProjectPaths = {
  root: string;
  threadsDir: string;
  conversationEntriesDir: string;
  attachmentRecordsDir: string;
  decisionsDir: string;
  tasksDir: string;
  runsDir: string;
  routesDir: string;
  automationDir: string;
  automationSessionsDir: string;
  automationCyclesDir: string;
  automationStepsDir: string;
  automationCheckpointsDir: string;
  orchestratorDir: string;
  researchDir: string;
  researchObjectivesDir: string;
  researchBranchesDir: string;
  researchSourcesDir: string;
  researchFindingsDir: string;
  researchHypothesesDir: string;
  researchWorkItemsDir: string;
  researchEvaluationsDir: string;
  researchProjectionsDir: string;
  researchRunsDir: string;
  researchOracleSessionsDir: string;
  researchEventsFile: string;
  researchCurrentProjectionFile: string;
  researchCurrentRunFile: string;
  legacyV2Dir: string;
  worktreesDir: string;
  contextDir: string;
  memoryDir: string;
  projectFile: string;
  activityLog: string;
  promptLog: string;
  workerHistoryLog: string;
  contextBundle: string;
  projectMemoryFile: string;
  memoryBriefFile: string;
  memoryOpenQuestionsFile: string;
  memorySessionSummaryFile: string;
  memoryDurableContextFile: string;
  memoryWorkingContextFile: string;
  memoryEvidenceContextFile: string;
  memoryPreferencesFile: string;
  workspaceAttachmentsDir: string;
};

export type ArtifactPaths = {
  id: string;
  jsonPath: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  transcriptPath: string;
};

export function buildProjectPaths(workspacePath: string): ProjectPaths {
  const root = path.join(workspacePath, LITHIUM_DIR);

  return {
    root,
    threadsDir: path.join(root, "threads"),
    conversationEntriesDir: path.join(root, "conversation"),
    attachmentRecordsDir: path.join(root, "attachments"),
    decisionsDir: path.join(root, "decisions"),
    tasksDir: path.join(root, "tasks"),
    runsDir: path.join(root, "runs"),
    routesDir: path.join(root, "routes"),
    automationDir: path.join(root, "automation"),
    automationSessionsDir: path.join(root, "automation", "sessions"),
    automationCyclesDir: path.join(root, "automation", "cycles"),
    automationStepsDir: path.join(root, "automation", "steps"),
    automationCheckpointsDir: path.join(root, "automation", "checkpoints"),
    orchestratorDir: path.join(root, "orchestrator"),
    researchDir: path.join(root, "research"),
    researchObjectivesDir: path.join(root, "research", "objectives"),
    researchBranchesDir: path.join(root, "research", "branches"),
    researchSourcesDir: path.join(root, "research", "sources"),
    researchFindingsDir: path.join(root, "research", "findings"),
    researchHypothesesDir: path.join(root, "research", "hypotheses"),
    researchWorkItemsDir: path.join(root, "research", "work-items"),
    researchEvaluationsDir: path.join(root, "research", "evaluations"),
    researchProjectionsDir: path.join(root, "research", "projections"),
    researchRunsDir: path.join(root, "research", "runs"),
    researchOracleSessionsDir: path.join(root, "research", "oracle-sessions"),
    researchEventsFile: path.join(root, "research", "events.jsonl"),
    researchCurrentProjectionFile: path.join(root, "research", "projections", "current.json"),
    researchCurrentRunFile: path.join(root, "research", "runs", "current.json"),
    legacyV2Dir: path.join(root, "legacy", "v2"),
    worktreesDir: path.join(root, "research", "worktrees"),
    contextDir: path.join(root, "context"),
    memoryDir: path.join(root, "memory"),
    projectFile: path.join(root, PROJECT_FILE),
    activityLog: path.join(root, ACTIVITY_LOG),
    promptLog: path.join(root, PROMPT_LOG),
    workerHistoryLog: path.join(root, WORKER_HISTORY_LOG),
    contextBundle: path.join(root, "context", "current-context.md"),
    projectMemoryFile: path.join(root, "memory", "project-memory.json"),
    memoryBriefFile: path.join(root, "memory", "brief.md"),
    memoryOpenQuestionsFile: path.join(root, "memory", "open-questions.md"),
    memorySessionSummaryFile: path.join(root, "memory", "session-summary.md"),
    memoryDurableContextFile: path.join(root, "memory", "durable-context.md"),
    memoryWorkingContextFile: path.join(root, "memory", "working-context.md"),
    memoryEvidenceContextFile: path.join(root, "memory", "evidence-context.md"),
    memoryPreferencesFile: path.join(root, "memory", "preferences.json"),
    workspaceAttachmentsDir: path.join(workspacePath, "attachments")
  };
}

export function projectRuntimeDirectories(paths: ProjectPaths) {
  return [
    paths.automationDir,
    paths.automationSessionsDir,
    paths.automationCyclesDir,
    paths.automationStepsDir,
    paths.automationCheckpointsDir,
    paths.orchestratorDir
  ];
}

export function createArtifactPaths(directory: string, id: string): ArtifactPaths {
  return {
    id,
    jsonPath: path.join(directory, `${id}.json`),
    stdoutPath: path.join(directory, `${id}.stdout.log`),
    stderrPath: path.join(directory, `${id}.stderr.log`),
    outputPath: path.join(directory, `${id}.output.txt`),
    transcriptPath: path.join(directory, `${id}.transcript.log`)
  };
}

export { PROJECT_SCHEMA_VERSION };
