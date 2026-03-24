import { spawn } from "node:child_process";
import { access, constants, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  RecordStatus,
  RunRecord,
  WorkspaceFileDiff,
  WorkspaceFileDiffStatus
} from "../../shared/types";
import { handoffMachineSummary } from "../../shared/handoff-utils";
import { parseBuilderOutput } from "./protocol";
import { resolveWorkspaceGitRoot } from "./workspace-execution";
import { resolveWorkspaceMemberPath } from "./workspace-paths";

const DEFAULT_HUNG_THRESHOLD_MS = 120_000;
const DEFAULT_ACTIVE_COMMAND_HUNG_THRESHOLD_MS = 20 * 60 * 1_000;
const DEFAULT_FINALIZATION_THRESHOLD_MS = 15_000;

export async function readTailText(filePath: string, maxBytes = 16 * 1024) {
  const fileStat = await stat(filePath).catch(() => null);

  if (!fileStat || fileStat.size === 0) {
    return "";
  }

  const start = Math.max(0, fileStat.size - maxBytes);
  const length = fileStat.size - start;
  const file = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(length);
    let bytesReadTotal = 0;

    while (bytesReadTotal < length) {
      const { bytesRead } = await file.read(
        buffer,
        bytesReadTotal,
        length - bytesReadTotal,
        start + bytesReadTotal
      );

      if (bytesRead <= 0) {
        break;
      }

      bytesReadTotal += bytesRead;
    }

    return buffer.toString("utf8", 0, bytesReadTotal);
  } finally {
    await file.close();
  }
}

export async function readTextFile(filePath: string) {
  return await readFile(filePath, "utf8").catch(() => "");
}

export function parseChangedFilesFromFinalMessage(finalMessage: string) {
  return parseBuilderOutput(finalMessage).files
    .flatMap((entry) => entry.split(" -> ").slice(-1))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function stripStatusFooter(finalMessage: string) {
  return finalMessage.replace(/\n*LITHIUM_STATUS\s*\n[\s\S]*$/i, "").trim();
}

export function extractFinalSummary(finalMessage: string) {
  const handoff = parseBuilderOutput(finalMessage);
  const machineSummary = handoffMachineSummary(handoff);

  if (machineSummary) {
    return machineSummary;
  }

  const stripped = stripStatusFooter(finalMessage);
  const firstParagraph = stripped
    .split(/\n\s*\n/)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .find(Boolean);

  if (firstParagraph) {
    return firstParagraph;
  }

  return finalMessage.replace(/\s+/g, " ").trim();
}

export async function collectGitChangedFiles(workspacePath: string) {
  const gitRoot = await resolveWorkspaceGitRoot(workspacePath);
  const canonicalWorkspacePath = await realpath(workspacePath).catch(() => path.resolve(workspacePath));

  if (!gitRoot) {
    return [];
  }

  const child = spawn("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: gitRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

  if (exitCode !== 0) {
    return [];
  }

  return parseGitStatusEntries(stdout)
    .map((entry) => normalizeGitChangedPath(entry, canonicalWorkspacePath, gitRoot))
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.replaceAll(path.sep, "/"))
    .filter(Boolean);
}

export async function readWorkspaceFileDiff(
  workspacePath: string,
  filePath: string,
  contextLines = 3
): Promise<WorkspaceFileDiff | null> {
  const absolutePath = await resolveWorkspaceMemberPath(workspacePath, filePath);
  const canonicalWorkspacePath = await realpath(workspacePath).catch(() => path.resolve(workspacePath));
  const canonicalAbsolutePath = await realpath(absolutePath).catch(() => absolutePath);
  const relativePath = normalizeWorkspaceRelativePath(canonicalWorkspacePath, canonicalAbsolutePath);
  const gitRoot = await resolveWorkspaceGitRoot(workspacePath);

  if (!gitRoot) {
    return {
      path: absolutePath,
      relativePath,
      status: "unavailable",
      diffText: ""
    };
  }

  const canonicalGitRoot = await realpath(gitRoot).catch(() => gitRoot);
  const gitRelativePath = path.relative(canonicalGitRoot, canonicalAbsolutePath);

  if (!gitRelativePath || gitRelativePath.startsWith("..") || path.isAbsolute(gitRelativePath)) {
    return {
      path: absolutePath,
      relativePath,
      status: "unavailable",
      diffText: ""
    };
  }

  const normalizedGitPath = gitRelativePath.replaceAll(path.sep, "/");
  const status = await inspectGitFileStatus(gitRoot, normalizedGitPath);

  if (status === "clean") {
    return {
      path: absolutePath,
      relativePath,
      status,
      diffText: ""
    };
  }

  const diffText =
    status === "untracked"
      ? await buildUntrackedFileDiff(absolutePath, normalizedGitPath, contextLines)
      : await buildTrackedFileDiff(gitRoot, normalizedGitPath, contextLines);
  const resolvedStatus = diffText.includes("Binary files") ? "binary" : status;

  return {
    path: absolutePath,
    relativePath,
    status: resolvedStatus,
    diffText
  };
}

export function normalizeGitChangedPath(entry: string, workspacePath: string, gitRoot: string) {
  const decodedEntry = decodeGitPath(entry);
  const absolutePath = path.resolve(gitRoot, decodedEntry);
  const relativePath = path.relative(workspacePath, absolutePath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return relativePath
    .split(" -> ")
    .slice(-1)
    .join(" -> ")
    .trim();
}

async function inspectGitFileStatus(
  gitRoot: string,
  relativePath: string
): Promise<WorkspaceFileDiffStatus> {
  const { stdout } = await runGitCapture(
    ["status", "--porcelain", "--untracked-files=all", "--", relativePath],
    gitRoot
  );
  const firstLine = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .find(Boolean);

  if (!firstLine) {
    return "clean";
  }

  const statusCode = firstLine.slice(0, 2);

  if (statusCode === "??") {
    return "untracked";
  }

  if (statusCode.includes("D")) {
    return "deleted";
  }

  if (statusCode.includes("A")) {
    return "added";
  }

  return "modified";
}

function parseGitStatusEntries(output: string) {
  const entries = output.split("\0");
  const changedPaths: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (!entry) {
      continue;
    }

    const statusCode = entry.slice(0, 2);
    const rawPath = entry.slice(3).trim();

    if (rawPath) {
      changedPaths.push(rawPath);
    }

    if (statusCode.includes("R") || statusCode.includes("C")) {
      index += 1;
    }
  }

  return changedPaths;
}

function decodeGitPath(value: string) {
  const trimmed = value.trim();

  if (!(trimmed.startsWith("\"") && trimmed.endsWith("\""))) {
    return trimmed;
  }

  const bytes: number[] = [];

  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const char = trimmed[index];

    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }

    const octal = trimmed.slice(index + 1, index + 4);

    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }

    const escaped = trimmed[index + 1];

    if (!escaped) {
      break;
    }

    switch (escaped) {
      case "n":
        bytes.push(...Buffer.from("\n"));
        break;
      case "r":
        bytes.push(...Buffer.from("\r"));
        break;
      case "t":
        bytes.push(...Buffer.from("\t"));
        break;
      case "\"":
      case "\\":
        bytes.push(...Buffer.from(escaped));
        break;
      default:
        bytes.push(...Buffer.from(escaped, "utf8"));
        break;
    }

    index += 1;
  }

  return Buffer.from(bytes).toString("utf8");
}

async function buildTrackedFileDiff(gitRoot: string, relativePath: string, contextLines: number) {
  const headDiff = await runGitCapture(
    ["diff", "--no-ext-diff", "--no-color", `--unified=${contextLines}`, "HEAD", "--", relativePath],
    gitRoot
  );

  if (headDiff.stdout.trim()) {
    return headDiff.stdout;
  }

  const workingTreeDiff = await runGitCapture(
    ["diff", "--no-ext-diff", "--no-color", `--unified=${contextLines}`, "--", relativePath],
    gitRoot
  );

  return workingTreeDiff.stdout;
}

async function buildUntrackedFileDiff(absolutePath: string, relativePath: string, contextLines: number) {
  const targetExists = await access(absolutePath, constants.F_OK)
    .then(() => true)
    .catch(() => false);

  if (!targetExists) {
    return "";
  }

  const { stdout } = await runGitCapture(
    ["diff", "--no-index", "--no-ext-diff", "--no-color", `--unified=${contextLines}`, "--", "/dev/null", absolutePath],
    path.dirname(absolutePath)
  );

  return stdout.replaceAll(absolutePath, relativePath);
}

async function runGitCapture(args: string[], cwd: string) {
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"]
  });
  let stdout = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

  return {
    stdout,
    exitCode
  };
}

function normalizeWorkspaceRelativePath(workspacePath: string, absolutePath: string) {
  return path.relative(path.resolve(workspacePath), absolutePath).replaceAll(path.sep, "/");
}

export function mergeChangedFiles(...lists: string[][]) {
  return Array.from(
    new Set(
      lists
        .flat()
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

export function inferRunStatus(input: {
  run: RunRecord | null;
  active: boolean;
  quietForMs: number;
  outputText: string;
  activeCommand?: string | null;
}): "idle" | "running" | "awaiting-finalization" | "hung" {
  const { run, active, quietForMs, outputText, activeCommand } = input;

  if (!run) {
    return "idle";
  }

  if (active) {
    if (outputText.trim() && quietForMs >= getFinalizationThresholdMs()) {
      return "awaiting-finalization";
    }

    const hungThreshold = activeCommand?.trim()
      ? getActiveCommandHungThresholdMs()
      : getHungThresholdMs();

    if (quietForMs >= hungThreshold) {
      return "hung";
    }

    return "running";
  }

  if (run.status === "running" || run.finalization === null) {
    return "awaiting-finalization";
  }

  return "idle";
}

export function inferFinalRunStatus(input: {
  exitCode: number | null;
  finalMessage: string;
  timedOut: boolean;
}): RecordStatus {
  const resultTag = parseBuilderOutput(input.finalMessage).result;

  if (resultTag === "success") {
    return "completed";
  }

  if (resultTag === "partial" || resultTag === "failed") {
    return "failed";
  }

  if (input.exitCode === 0 && !input.timedOut) {
    return "completed";
  }

  return "failed";
}

function getHungThresholdMs() {
  return readThresholdOverride("LITHIUM_RUN_HUNG_THRESHOLD_MS", DEFAULT_HUNG_THRESHOLD_MS);
}

function getActiveCommandHungThresholdMs() {
  return readThresholdOverride(
    "LITHIUM_RUN_ACTIVE_COMMAND_HUNG_THRESHOLD_MS",
    DEFAULT_ACTIVE_COMMAND_HUNG_THRESHOLD_MS
  );
}

function getFinalizationThresholdMs() {
  return readThresholdOverride(
    "LITHIUM_RUN_FINALIZATION_THRESHOLD_MS",
    DEFAULT_FINALIZATION_THRESHOLD_MS
  );
}

function readThresholdOverride(envName: string, fallback: number) {
  const rawValue = process.env[envName]?.trim();

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
