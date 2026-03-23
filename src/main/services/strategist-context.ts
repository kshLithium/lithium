import { createHash } from "node:crypto";
import path, { basename } from "node:path";
import type { ProjectSnapshot } from "../../shared/types";

const SUPPORTED_STRATEGIST_UPLOAD_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".csv",
  ".tsv",
  ".py",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".toml",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".json",
  ".yaml",
  ".yml",
  ".html",
  ".xml",
  ".rtf",
  ".odt",
  ".ods",
  ".odp"
]);
const FILE_PATH_MENTION_PATTERN = /(?:^|[\s([{"'`])((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+)(?=$|[\s)\]},"'`])/g;
const FILE_BASENAME_MENTION_PATTERN = /\b[\w.-]+\.[A-Za-z0-9]{1,8}\b/g;

export function buildStrategistOracleSessionId(workspacePath: string, threadId: string) {
  const workspaceSlug = basename(workspacePath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 10);
  const workspaceHash = createHash("sha1").update(workspacePath).digest("hex").slice(0, 8);

  return `ors-strat-${workspaceSlug || "ws"}-${workspaceHash}-${threadId.toLowerCase()}`;
}

export function isSupportedStrategistUploadPath(filePath: string) {
  const baseName = path.basename(filePath).toLowerCase();
  const extension = path.extname(filePath).toLowerCase();

  if (baseName === "readme" || /^readme\.[^.]+$/i.test(baseName)) {
    return true;
  }

  return SUPPORTED_STRATEGIST_UPLOAD_EXTENSIONS.has(extension);
}

export function shouldAttachStrategistRuntimeContext(
  snapshot: ProjectSnapshot,
  fingerprint: string
) {
  const thread = snapshot.activeThread;

  if (!thread?.strategistContextFingerprint) {
    return true;
  }

  return thread.strategistContextFingerprint !== fingerprint;
}

export function buildStrategistContextFingerprint(snapshot: ProjectSnapshot) {
  const payload = {
    projectMemory: snapshot.memory
      ? {
          projectBrief: snapshot.memory.projectBrief,
          researchGoal: snapshot.memory.researchGoal,
          constraints: snapshot.memory.constraints,
          preferences: snapshot.memory.preferences,
          openQuestions: snapshot.memory.openQuestions,
          activeHypotheses: snapshot.memory.activeHypotheses
        }
      : null,
    threadId: snapshot.activeThread?.id ?? "",
    threadMemory: snapshot.activeThread?.memory ?? "",
    attachmentState: [...snapshot.activeThreadAttachments]
      .map((record) => ({
        id: record.id,
        relativePath: record.relativePath,
        updatedAt: record.updatedAt
      }))
      .sort(
        (left, right) =>
          left.relativePath.localeCompare(right.relativePath) ||
          left.id.localeCompare(right.id) ||
          left.updatedAt.localeCompare(right.updatedAt)
      ),
    latestRun: snapshot.latestRun
      ? {
          id: snapshot.latestRun.id,
          status: snapshot.latestRun.status,
          endedAt: snapshot.latestRun.endedAt,
          changedFiles: [...snapshot.latestRun.changedFiles].sort((left, right) =>
            left.localeCompare(right)
          )
        }
      : null,
    latestTask: snapshot.latestTask
      ? {
          id: snapshot.latestTask.id,
          updatedAt: snapshot.latestTask.updatedAt
        }
      : null,
    latestTerminalSession: snapshot.latestTerminalSession
      ? {
          id: snapshot.latestTerminalSession.id,
          endedAt: snapshot.latestTerminalSession.endedAt,
          cwd: snapshot.latestTerminalSession.cwd
        }
      : null
  };

  return JSON.stringify(payload);
}

export function resolveExplicitStrategistWorkspaceFiles(
  prompt: string,
  workspacePath: string,
  workspaceFiles: Array<{ relativePath: string; name: string }>
) {
  const explicitMentions = new Set<string>();
  const normalizedPrompt = prompt.toLowerCase();

  for (const match of prompt.matchAll(FILE_PATH_MENTION_PATTERN)) {
    const candidate = normalizeWorkspaceMention(match[1] ?? "");

    if (candidate) {
      explicitMentions.add(candidate);
    }
  }

  for (const match of prompt.matchAll(FILE_BASENAME_MENTION_PATTERN)) {
    const candidate = normalizeWorkspaceMention(match[0] ?? "");

    if (candidate) {
      explicitMentions.add(candidate);
    }
  }

  const resolved = new Set<string>();

  for (const mention of explicitMentions) {
    const directMatch = workspaceFiles.find(
      (file) => normalizeWorkspaceMention(file.relativePath) === mention
    );

    if (directMatch) {
      resolved.add(path.join(workspacePath, directMatch.relativePath));
      continue;
    }

    const basenameMatches = workspaceFiles.filter(
      (file) => normalizeWorkspaceMention(file.name) === mention
    );

    if (basenameMatches.length === 1) {
      resolved.add(path.join(workspacePath, basenameMatches[0].relativePath));
    }
  }

  if (/\breadme(?:\.[a-z0-9]+)?\b/i.test(normalizedPrompt)) {
    const readmeFile = workspaceFiles.find((file) => /^readme(\.[^.]+)?$/i.test(file.name));

    if (readmeFile) {
      resolved.add(path.join(workspacePath, readmeFile.relativePath));
    }
  }

  return [...resolved].filter((filePath) => isSupportedStrategistUploadPath(filePath));
}

function normalizeWorkspaceMention(value: string) {
  return value
    .trim()
    .replace(/^[`"'([{]+|[`"')\]}.,:;!?]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}
