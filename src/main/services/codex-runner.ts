import os from "node:os";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import type {
  AppSettings,
  BuilderModel,
  BuilderReasoningEffort,
  CommandSpec
} from "../../shared/types";
import { runCommand } from "./process-runner";

type CodexRunOptions = {
  workspacePath: string;
  commandCwd?: string;
  prompt: string;
  runtimeContext: string;
  artifactContext?: string;
  model: BuilderModel;
  reasoningEffort: BuilderReasoningEffort;
  promptLanguage?: AppSettings["autopilotPromptLanguage"];
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  env?: NodeJS.ProcessEnv;
};

export type CodexRunResult = {
  command: CommandSpec;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  finalMessage: string;
};

export class CodexRunner {
  async runTask(options: CodexRunOptions): Promise<CodexRunResult> {
    const command = this.buildTaskCommand(
      options.commandCwd ?? options.workspacePath,
      options.prompt,
      options.outputPath,
      options.runtimeContext,
      options.artifactContext,
      options.model,
      options.reasoningEffort,
      options.promptLanguage
    );

    const result = await runCommand({
      spec: command,
      timeoutMs: 30 * 60 * 1000,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      env: options.env
    });

    const finalMessage =
      (await this.readMaybe(options.outputPath)).trim() ||
      [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();

    return {
      command,
      finalMessage,
      ...result
    };
  }

  buildTaskCommand(
    workspacePath: string,
    prompt: string,
    outputPath: string,
    runtimeContext: string,
    artifactContext: string | undefined,
    model: BuilderModel,
    reasoningEffort: BuilderReasoningEffort,
    promptLanguage: AppSettings["autopilotPromptLanguage"] = "auto"
  ) {
    return {
      command: "codex",
      args: [
        "exec",
        "-c",
        `model_reasoning_effort="${reasoningEffort}"`,
        "--model",
        model,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--add-dir",
        resolveOracleHomeDir(),
        "--output-last-message",
        outputPath,
        this.normalizePrompt(prompt, runtimeContext, artifactContext, promptLanguage)
      ],
      cwd: workspacePath
    } satisfies CommandSpec;
  }

  private normalizePrompt(
    prompt: string,
    runtimeContext: string,
    artifactContext?: string,
    promptLanguage: AppSettings["autopilotPromptLanguage"] = "auto"
  ) {
    const language = resolveBuilderPromptLanguage(promptLanguage, [prompt, runtimeContext, artifactContext ?? ""]);

    if (language === "ko") {
      return [
        "당신은 현재 저장소 안에서 작업하는 Lithium builder입니다.",
        "코드, 파일, 명령 실행이 필요하면 요청된 작업을 직접 수행하세요.",
        "긴 채팅 히스토리 대신 아래 runtime context를 현재 프로젝트 상태로 사용하세요.",
        artifactContext ? "정말 필요할 때만 전체 artifact context를 참고하세요." : null,
        "사용자에게는 자연스러운 마크다운으로 답하고, 사용자가 원하는 깊이에 맞추세요.",
        "내부 자동화 상태, retry 수, checkpoint, raw tool log 같은 운영 디테일은 답변 본문에 노출하지 마세요.",
        "긴 작업 중에는 의미 있는 중간 단계가 끝날 때마다 현재 무엇을 하고 있는지 짧고 쉬운 문장으로만 설명하세요.",
        "스스로 다음 bounded step을 골랐다면, 그 선택을 사용자가 바로 이해할 수 있게 한 문장으로 먼저 설명하세요.",
        "파일 목록이나 내부 구현 디테일은 정말 필요할 때만 답변에 포함하세요.",
        "다음 단계가 사용자 판단에 크게 의존하거나 방향이 여러 갈래로 갈릴 때만, 짧은 질문 하나를 하세요.",
        "외부 공개 웹 소스를 참고했다면 답변 본문에 명시적인 마크다운 링크나 짧은 Sources 섹션을 포함하세요.",
        "답변 뒤에는 새 줄에 아래 마커를 정확히 추가하세요:",
        "LITHIUM_STATUS",
        '그다음 유효한 JSON 객체 하나만 출력하세요. 필수: {"summary":"...","result":"success|partial|failed"}. 필요할 때만 선택 필드: "files", "risks", "paper_actions", "run_actions", "success_criteria", "open_questions", "needs_user_checkpoint".',
        "JSON 앞뒤에 마크다운 코드 펜스를 쓰지 마세요.",
        "",
        "RUNTIME_CONTEXT:",
        runtimeContext.trim(),
        artifactContext
          ? ["", "FULL_ARTIFACT_CONTEXT:", artifactContext.trim()].join("\n")
          : null,
        "",
        `TASK: ${prompt.trim()}`
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    }

    return [
      "You are the Lithium builder running inside the active repository.",
      "Do the requested workspace task directly when code, files, or commands need to change.",
      "Use the runtime context below as the current project state instead of relying on long chat history.",
      artifactContext ? "Use the full artifact context only when it materially helps." : null,
      "Reply to the user naturally in markdown, matching the depth they seem to want.",
      "Do not surface internal automation states, retry counters, checkpoints, or raw tool logs in the answer body.",
      "During long tasks, emit a short plain-language progress note whenever you finish a meaningful sub-step.",
      "If you chose the next bounded step yourself, say that choice plainly before diving into details.",
      "Do not list files or implementation trivia unless it materially helps the user.",
      "Only ask the user a question when the next move genuinely depends on their choice or an ambiguous direction split.",
      "If you rely on external or public web sources, include explicit markdown links or a short Sources section in the answer body.",
      "After the answer, append this exact marker on a new line:",
      "LITHIUM_STATUS",
      'Then emit one valid JSON object. Required: {"summary":"...","result":"success|partial|failed"}. Optional when useful: "files", "risks", "paper_actions", "run_actions", "success_criteria", "open_questions", "needs_user_checkpoint".',
      "Do not use markdown fences around the JSON.",
      "",
      "RUNTIME_CONTEXT:",
      runtimeContext.trim(),
      artifactContext
        ? ["", "FULL_ARTIFACT_CONTEXT:", artifactContext.trim()].join("\n")
        : null,
      "",
      `TASK: ${prompt.trim()}`
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  private async readMaybe(filePath: string) {
    if (!(await this.exists(filePath))) {
      return "";
    }

    return readFile(filePath, "utf8");
  }

  private async exists(targetPath: string) {
    try {
      await stat(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}

function resolveBuilderPromptLanguage(
  preference: AppSettings["autopilotPromptLanguage"],
  samples: string[]
): "ko" | "en" {
  if (preference === "ko" || preference === "en") {
    return preference;
  }

  return samples.some((value) => /[\u3131-\u318E\uAC00-\uD7A3]/.test(value)) ? "ko" : "en";
}

function resolveOracleHomeDir() {
  return process.env.ORACLE_HOME_DIR?.trim() || path.join(os.homedir(), ".oracle");
}
