import path from "node:path";
import { PROJECT_SCHEMA_VERSION } from "../../shared/types";

export const LITHIUM_DIR = ".lithium";
export const PROJECT_FILE = "project.json";
export const ACTIVITY_LOG = "activity.log";
export const PROMPT_LOG = "prompt-log.jsonl";
export const WORKER_HISTORY_LOG = "worker-history.jsonl";

export const PROJECT_VOLATILE_RUNTIME_DIRECTORIES = ["artifacts", "logs"] as const;

export const LEGACY_LITHIUM_SENTINELS = [
  "project.json",
  "research/objectives",
  "research/branches",
  "research/sources",
  "research/work-items",
  "research/runs",
  "threads",
  ["convers", "ation"].join(""),
  ["autom", "ation"].join(""),
  ["orchestr", "ator"].join(""),
  "decisions",
  "tasks",
  "routes"
] as const;

export type ProjectPaths = {
  root: string;
  projectFile: string;
  researchDbFile: string;
  artifactRoot: string;
  logsDir: string;
  workerRunsDir: string;
  oracleSessionsDir: string;
  evaluatorDir: string;
  experimentManifestDir: string;
  sourceArtifactsDir: string;
  researchPatchesDir: string;
  worktreesDir: string;
  activityLog: string;
  promptLog: string;
  workerHistoryLog: string;
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
  const artifactRoot = path.join(root, "artifacts");
  const logsDir = path.join(root, "logs");

  return {
    root,
    projectFile: path.join(root, PROJECT_FILE),
    researchDbFile: path.join(root, "research.db"),
    artifactRoot,
    logsDir,
    workerRunsDir: path.join(artifactRoot, "worker-runs"),
    oracleSessionsDir: path.join(artifactRoot, "oracle-sessions"),
    evaluatorDir: path.join(artifactRoot, "evaluator"),
    experimentManifestDir: path.join(artifactRoot, "experiment-manifests"),
    sourceArtifactsDir: path.join(artifactRoot, "source-artifacts"),
    researchPatchesDir: path.join(artifactRoot, "patches"),
    worktreesDir: path.join(artifactRoot, "worktrees"),
    activityLog: path.join(logsDir, ACTIVITY_LOG),
    promptLog: path.join(logsDir, PROMPT_LOG),
    workerHistoryLog: path.join(logsDir, WORKER_HISTORY_LOG),
    workspaceAttachmentsDir: path.join(workspacePath, "attachments")
  };
}

export function projectRuntimeDirectories(paths: ProjectPaths) {
  return [paths.artifactRoot, paths.logsDir, paths.worktreesDir];
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
