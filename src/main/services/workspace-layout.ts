import path from "node:path";
import { PROJECT_SCHEMA_VERSION } from "../../shared/types";

export const LITHIUM_DIR = ".lithium";

export const LEGACY_LITHIUM_ROOT_ITEMS = [
  "project.json",
  "research.db",
  "activity.log",
  "prompt-log.jsonl",
  "worker-history.jsonl",
  "threads",
  "conversation",
  "automation"
] as const;

export type ProjectPaths = {
  workspacePath: string;
  root: string;
  stateDir: string;
  runtimeDir: string;
  artifactsDir: string;
  indexDir: string;
  researchDbFile: string;
  socketPath: string;
  pidFile: string;
  daemonLogFile: string;
  leasesDir: string;
  tempEnvDir: string;
  workerRunsDir: string;
  strategistRunsDir: string;
  evaluatorRunsDir: string;
  sourceBodiesDir: string;
  sourceTextsDir: string;
  sourceChunksDir: string;
  experimentDir: string;
  patchesDir: string;
  attachmentsDir: string;
  worktreesDir: string;
  legacyResearchDbFile: string;
};

export type ArtifactPaths = {
  id: string;
  basePath: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
};

export function buildProjectPaths(workspacePath: string): ProjectPaths {
  const root = path.join(workspacePath, LITHIUM_DIR);
  const stateDir = path.join(root, "state");
  const runtimeDir = path.join(root, "runtime");
  const artifactsDir = path.join(root, "artifacts");
  const indexDir = path.join(root, "index");

  return {
    workspacePath,
    root,
    stateDir,
    runtimeDir,
    artifactsDir,
    indexDir,
    researchDbFile: path.join(stateDir, "research.db"),
    socketPath: path.join(runtimeDir, "daemon.sock"),
    pidFile: path.join(runtimeDir, "daemon.pid"),
    daemonLogFile: path.join(runtimeDir, "daemon.log"),
    leasesDir: path.join(runtimeDir, "leases"),
    tempEnvDir: path.join(runtimeDir, "temp-envs"),
    workerRunsDir: path.join(artifactsDir, "worker-runs"),
    strategistRunsDir: path.join(artifactsDir, "strategist"),
    evaluatorRunsDir: path.join(artifactsDir, "evaluator"),
    sourceBodiesDir: path.join(artifactsDir, "source-bodies"),
    sourceTextsDir: path.join(artifactsDir, "source-texts"),
    sourceChunksDir: path.join(indexDir, "source-chunks"),
    experimentDir: path.join(artifactsDir, "experiments"),
    patchesDir: path.join(artifactsDir, "patches"),
    attachmentsDir: path.join(artifactsDir, "attachments"),
    worktreesDir: path.join(artifactsDir, "worktrees"),
    legacyResearchDbFile: path.join(root, "research.db")
  };
}

export function createArtifactPaths(directory: string, id: string): ArtifactPaths {
  const basePath = path.join(directory, id);
  return {
    id,
    basePath,
    stdoutPath: `${basePath}.stdout.log`,
    stderrPath: `${basePath}.stderr.log`,
    outputPath: `${basePath}.output.txt`
  };
}

export { PROJECT_SCHEMA_VERSION };
