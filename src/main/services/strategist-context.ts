import { createHash } from "node:crypto";
import path, { basename } from "node:path";
import type { AttachmentRecord, ProjectSnapshot, WorkspaceFileRecord } from "../../shared/types";
import { handoffMachineSummary, resolveMeaningfulAutomationSummary } from "../../shared/handoff-utils";

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
  ".odp",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif"
]);
const STRATEGIST_IMAGE_UPLOAD_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif"]);
const STRATEGIST_SPREADSHEET_UPLOAD_EXTENSIONS = new Set([".csv", ".tsv", ".xls", ".xlsx"]);
const STRATEGIST_ARCHIVE_DIGEST_EXTENSIONS = new Set([".zip"]);
const STRATEGIST_TEXT_AND_DOCUMENT_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;
const STRATEGIST_SPREADSHEET_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const STRATEGIST_IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const FILE_PATH_MENTION_PATTERN = /(?:^|[\s([{"'`])((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+)(?=$|[\s)\]},"'`])/g;
const FILE_BASENAME_MENTION_PATTERN = /\b[\w.-]+\.[A-Za-z0-9]{1,8}\b/g;

export const STRATEGIST_MAX_UPLOAD_FILES = 10;
export const STRATEGIST_RESERVED_CONTEXT_UPLOAD_SLOTS = 2;
const STRATEGIST_GENERAL_UPLOAD_LIMIT_BYTES = 512 * 1024 * 1024;
const STRATEGIST_IMAGE_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const STRATEGIST_SPREADSHEET_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const STRATEGIST_KEYWORD_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "the",
  "this",
  "that",
  "to",
  "up",
  "us",
  "we",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "you",
  "your",
  "현재",
  "질문",
  "맥락",
  "상황",
  "관련",
  "파일",
  "첨부",
  "이",
  "그",
  "저",
  "및",
  "를",
  "을",
  "에",
  "의",
  "과",
  "와",
  "좀",
  "더",
  "잘",
  "하는",
  "해주세요"
]);

export const STRATEGIST_BROWSER_UPLOAD_MAX_FILES = 10;

export type StrategistUploadCandidate = {
  path: string;
  priority: number;
};

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

function isStrategistReferenceEligiblePath(filePath: string) {
  return isSupportedStrategistUploadPath(filePath) || STRATEGIST_ARCHIVE_DIGEST_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function resolveStrategistUploadLimitBytes(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  if (STRATEGIST_IMAGE_UPLOAD_EXTENSIONS.has(extension)) {
    return STRATEGIST_IMAGE_UPLOAD_MAX_BYTES;
  }

  if (STRATEGIST_SPREADSHEET_UPLOAD_EXTENSIONS.has(extension)) {
    return STRATEGIST_SPREADSHEET_UPLOAD_MAX_BYTES;
  }

  return STRATEGIST_TEXT_AND_DOCUMENT_UPLOAD_MAX_BYTES;
}

export function validateStrategistUploadPath(filePath: string, sizeBytes?: number) {
  if (!isSupportedStrategistUploadPath(filePath)) {
    return {
      supported: false,
      reason: "Unsupported file type for ChatGPT web uploads."
    } as const;
  }

  if (typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes >= 0) {
    const sizeLimitBytes = resolveStrategistUploadLimitBytes(filePath);

    if (sizeBytes > sizeLimitBytes) {
      return {
        supported: false,
        reason: `File exceeds the ${formatUploadLimit(sizeLimitBytes)} upload limit for this file type.`
      } as const;
    }
  }

  return {
    supported: true
  } as const;
}

export function getStrategistUploadLimitBytes(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(extension)) {
    return STRATEGIST_IMAGE_UPLOAD_LIMIT_BYTES;
  }

  if ([".csv", ".tsv", ".xls", ".xlsx", ".ods"].includes(extension)) {
    return STRATEGIST_SPREADSHEET_UPLOAD_LIMIT_BYTES;
  }

  return STRATEGIST_GENERAL_UPLOAD_LIMIT_BYTES;
}

export function isWithinStrategistUploadLimit(filePath: string, sizeBytes: number) {
  return sizeBytes > 0 && sizeBytes <= getStrategistUploadLimitBytes(filePath);
}

export function limitStrategistUploadCandidates(
  candidates: StrategistUploadCandidate[],
  options: {
    maxFiles?: number;
  } = {}
) {
  const deduped = new Map<string, StrategistUploadCandidate>();

  for (const candidate of candidates) {
    const existing = deduped.get(candidate.path);

    if (!existing || candidate.priority > existing.priority) {
      deduped.set(candidate.path, candidate);
    }
  }

  return [...deduped.values()]
    .filter((candidate) => isSupportedStrategistUploadPath(candidate.path))
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.path.localeCompare(right.path)
    )
    .slice(0, options.maxFiles ?? STRATEGIST_BROWSER_UPLOAD_MAX_FILES)
    .map((candidate) => candidate.path);
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

export function buildStrategistContextFingerprint(
  snapshot: ProjectSnapshot,
  options: {
    workspaceFingerprint?: string;
  } = {}
) {
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
    attachmentState: [...(snapshot.attachments ?? [])]
      .filter((record) => record.threadId === (snapshot.activeThread?.id ?? ""))
      .map((record) => ({
        id: record.id,
        relativePath: record.relativePath,
        updatedAt: record.updatedAt,
        consumedAt: record.consumedAt ?? ""
      }))
      .sort(
        (left, right) =>
          left.relativePath.localeCompare(right.relativePath) ||
          left.id.localeCompare(right.id) ||
          left.updatedAt.localeCompare(right.updatedAt) ||
          left.consumedAt.localeCompare(right.consumedAt)
      ),
    latestRun: snapshot.latestRun
      ? {
          id: snapshot.latestRun.id,
          status: snapshot.latestRun.status,
          endedAt: snapshot.latestRun.endedAt,
          summary:
            handoffMachineSummary(snapshot.latestRun.handoff) ||
            snapshot.latestRun.finalMessage?.replace(/\s+/g, " ").trim().slice(0, 280) ||
            "",
          changedFiles: [...(snapshot.latestRun.changedFiles ?? [])].sort((left, right) =>
            left.localeCompare(right)
          )
        }
      : null,
    latestTask: snapshot.latestTask
      ? {
          id: snapshot.latestTask.id,
          prompt: snapshot.latestTask.prompt,
          updatedAt: snapshot.latestTask.updatedAt
        }
      : null,
    latestAutomationSession: snapshot.latestAutomationSession
      ? {
          id: snapshot.latestAutomationSession.id,
          status: snapshot.latestAutomationSession.status,
          currentStepSummary: resolveMeaningfulAutomationSummary(
            snapshot.latestAutomationSession.currentStepSummary,
            snapshot.latestAutomationSession.displayObjective,
            snapshot.latestAutomationSession.objective
          )
        }
      : null,
    latestAutomationCheckpoint: snapshot.latestAutomationCheckpoint
      ? {
          status: snapshot.latestAutomationCheckpoint.status,
          title: snapshot.latestAutomationCheckpoint.title,
          summary: snapshot.latestAutomationCheckpoint.summary
        }
      : null,
    workspaceFingerprint: options.workspaceFingerprint ?? ""
  };

  return JSON.stringify(payload);
}

export function buildStrategistPromptEnvelope(input: {
  prompt: string;
  displayPrompt?: string;
  latestThreadSummary?: string;
  latestDecisionSummary?: string;
  latestRunSummary?: string;
  latestChangedFiles?: string[];
  recentAttachmentNames?: string[];
  attachedContextLabels?: string[];
  attachedRawFileNames?: string[];
  skippedUploadNotes?: string[];
}) {
  const userLanguage = resolveStrategistPromptLanguage([
    input.prompt,
    input.displayPrompt ?? "",
    input.latestThreadSummary ?? "",
    input.latestDecisionSummary ?? "",
    input.latestRunSummary ?? ""
  ]);
  const originalPrompt = input.displayPrompt?.trim() || input.prompt.trim();
  const workingPrompt = input.prompt.trim();
  const changedFiles = (input.latestChangedFiles ?? []).slice(0, 6).join(", ");
  const recentAttachments = (input.recentAttachmentNames ?? []).slice(0, 6).join(", ");
  const attachedContext = (input.attachedContextLabels ?? []).join(", ");
  const attachedRawFiles = (input.attachedRawFileNames ?? []).slice(0, 6).join(", ");
  const skippedUploadNotes = (input.skippedUploadNotes ?? []).slice(0, 4).join(" | ");

  if (userLanguage === "ko") {
    return [
      "당신은 이 연구 워크스페이스의 strategist입니다.",
      "첨부된 context 파일들을 현재 상태의 기준으로 사용하세요.",
      "기본적으로는 큰 실험 흐름, branch 우선순위, decision gate, 다음 bounded move를 먼저 판단하세요.",
      "개별 코드 조각, 단일 로그, 단일 실험 카드의 세부 해석은 사용자가 명시적으로 요구하거나 그 세부가 분기 판단에 직접 필요할 때만 다루세요.",
      "세부 쟁점이 여러 개면 한 답변에서 모두 깊게 파고들기보다, 공통 흐름 판단을 먼저 내리고 독립 쟁점을 분리할 수 있게 정리하세요.",
      originalPrompt !== workingPrompt
        ? "원래 사용자 문장과 정리된 작업 지시가 다르면, 원래 사용자 의도를 우선하고 정리된 문장은 보조 설명으로만 사용하세요."
        : "아래 사용자 요청을 그대로 되풀이하지 말고, 현재 상태 판단과 다음 중요한 방향으로 바로 들어가세요.",
      attachedContext ? `첨부된 context 파일: ${attachedContext}` : "",
      attachedRawFiles ? `추가 raw 파일: ${attachedRawFiles}` : "",
      skippedUploadNotes ? `직접 업로드에서 빠진 파일 메모: ${truncateInline(skippedUploadNotes, 260)}` : "",
      input.latestThreadSummary ? `현재 thread 요약: ${truncateInline(input.latestThreadSummary, 220)}` : "",
      input.latestDecisionSummary ? `직전 strategist 요약: ${truncateInline(input.latestDecisionSummary, 220)}` : "",
      input.latestRunSummary ? `직전 builder 요약: ${truncateInline(input.latestRunSummary, 220)}` : "",
      changedFiles ? `최근 변경 파일: ${truncateInline(changedFiles, 220)}` : "",
      recentAttachments ? `최근 thread 첨부: ${truncateInline(recentAttachments, 220)}` : "",
      "",
      `원래 사용자 메시지:\n${originalPrompt}`,
      originalPrompt !== workingPrompt ? `\n정리된 strategist 작업 지시:\n${workingPrompt}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    "You are the strategist for this research workspace.",
    "Use the attached context files as the source of truth for the current project state.",
    "Default to the portfolio-level experiment flow: branch priority, decision gates, and the next bounded move.",
    "Do not dive into line-level code, single-log fragments, or one experiment card at a time unless the user explicitly asked for that detail or it is directly required for the decision.",
    "If the ask contains several fine-grained issues, lead with the shared flow judgment first and separate the independent sub-questions instead of drilling into everything at once.",
    originalPrompt !== workingPrompt
      ? "If the original user wording and the clarified working ask differ, satisfy the original user intent first and use the clarified ask only as supporting structure."
      : "Do not begin by repeating the user's wording verbatim; move directly into the current judgment and next high-value direction.",
    attachedContext ? `Attached context files: ${attachedContext}` : "",
    attachedRawFiles ? `Additional raw files: ${attachedRawFiles}` : "",
    skippedUploadNotes ? `Relevant files not uploaded directly: ${truncateInline(skippedUploadNotes, 260)}` : "",
    input.latestThreadSummary ? `Current thread summary: ${truncateInline(input.latestThreadSummary, 220)}` : "",
    input.latestDecisionSummary ? `Latest strategist summary: ${truncateInline(input.latestDecisionSummary, 220)}` : "",
    input.latestRunSummary ? `Latest builder summary: ${truncateInline(input.latestRunSummary, 220)}` : "",
    changedFiles ? `Recent changed files: ${truncateInline(changedFiles, 220)}` : "",
    recentAttachments ? `Recent thread attachments: ${truncateInline(recentAttachments, 220)}` : "",
    "",
    `Original user message:\n${originalPrompt}`,
    originalPrompt !== workingPrompt ? `\nClarified strategist ask:\n${workingPrompt}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
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

  return [...resolved].filter((filePath) => isStrategistReferenceEligiblePath(filePath));
}

export function resolveRelevantStrategistWorkspaceFiles(input: {
  prompt: string;
  displayPrompt?: string;
  workspacePath: string;
  workspaceFiles: WorkspaceFileRecord[];
  latestChangedFiles?: string[];
  contextHints?: string[];
  maxFiles?: number;
}) {
  const combinedPrompt = [input.displayPrompt, input.prompt].filter(Boolean).join("\n");
  const explicitPaths = new Set(
    resolveExplicitStrategistWorkspaceFiles(combinedPrompt, input.workspacePath, input.workspaceFiles)
  );
  const latestChangedFiles = new Set((input.latestChangedFiles ?? []).map((value) => normalizeWorkspaceMention(value)));
  const readmeFile = input.workspaceFiles.find(
    (file) => !file.relativePath.startsWith(".lithium/") && /^readme(\.[^.]+)?$/i.test(file.name)
  );
  const keywordSet = extractStrategistKeywords(
    [combinedPrompt, ...(input.contextHints ?? [])].filter(Boolean).join("\n")
  );

  const scored = input.workspaceFiles
    .filter((file) => !file.relativePath.startsWith(".lithium/"))
    .map((file) => {
      const absolutePath = path.join(input.workspacePath, file.relativePath);

      if (!isStrategistReferenceEligiblePath(absolutePath)) {
        return null;
      }

      const normalizedPath = normalizeWorkspaceMention(file.relativePath);
      const normalizedName = normalizeWorkspaceMention(file.name);
      const fileTokens = extractStrategistKeywords(
        `${file.relativePath.replace(/[\\/._-]+/g, " ")} ${file.name.replace(/[._-]+/g, " ")}`
      );
      let score = 0;

      if (explicitPaths.has(absolutePath)) {
        score += 1_000;
      }

      if (latestChangedFiles.has(normalizedPath)) {
        score += 250;
      }

      if (readmeFile?.relativePath === file.relativePath) {
        score += explicitPaths.size > 0 ? 30 : 90;
      }

      if (keywordSet.size > 0) {
        let overlap = 0;

        for (const token of fileTokens) {
          if (keywordSet.has(token)) {
            overlap += 1;
          }
        }

        if (overlap > 0) {
          score += 70 + overlap * 14;
        }
      }

      if (normalizedName === "readme" || normalizedName.startsWith("readme.")) {
        score += 20;
      }

      return {
        path: absolutePath,
        score
      };
    })
    .filter((candidate): candidate is { path: string; score: number } => Boolean(candidate))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.path.localeCompare(right.path)
    );

  return scored.slice(0, input.maxFiles ?? 6).map((candidate) => candidate.path);
}

export function resolveRecentStrategistAttachmentCandidates(
  attachmentRecords: AttachmentRecord[],
  workspacePath: string,
  options: {
    maxFiles?: number;
  } = {}
) {
  return [...attachmentRecords]
    .filter((record) => record.threadId)
    .sort(
      (left, right) =>
        Number(Boolean(left.consumedAt)) - Number(Boolean(right.consumedAt)) ||
        right.updatedAt.localeCompare(left.updatedAt)
    )
    .map((record) => path.join(workspacePath, record.relativePath))
    .slice(0, options.maxFiles ?? 6);
}

function normalizeWorkspaceMention(value: string) {
  return value
    .trim()
    .replace(/^[`"'([{]+|[`"')\]}.,:;!?]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

function formatUploadLimit(sizeBytes: number) {
  if (sizeBytes % (1024 * 1024 * 1024) === 0) {
    return `${sizeBytes / (1024 * 1024 * 1024)} GB`;
  }

  return `${Math.round(sizeBytes / (1024 * 1024))} MB`;
}

function extractStrategistKeywords(value: string) {
  const tokens = value
    .toLowerCase()
    .replace(/[\\/._-]+/g, " ")
    .split(/[^a-z0-9가-힣]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STRATEGIST_KEYWORD_STOPWORDS.has(token));

  return new Set(tokens);
}

function truncateInline(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function resolveStrategistPromptLanguage(samples: string[]) {
  return samples.some((sample) => /[\u3131-\u318E\uAC00-\uD7A3]/.test(sample)) ? "ko" : "en";
}
