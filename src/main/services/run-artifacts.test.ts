import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectGitChangedFiles,
  extractFinalSummary,
  inferFinalRunStatus,
  inferRunStatus,
  normalizeGitChangedPath,
  parseChangedFilesFromFinalMessage,
  readWorkspaceFileDiff
} from "./run-artifacts";

describe("run-artifacts", () => {
  it("extracts changed files from a multi-line footer", () => {
    const finalMessage = [
      "Work complete.",
      "",
      "LITHIUM_STATUS",
      "SUMMARY: Done",
      "FILES:",
      "- paper/main.tex",
      "- paper/results.tex -> paper/results.tex",
      "RESULT: success"
    ].join("\n");

    expect(parseChangedFilesFromFinalMessage(finalMessage)).toEqual([
      "paper/main.tex",
      "paper/results.tex"
    ]);
  });

  it("returns no files for explicit empty markers", () => {
    expect(parseChangedFilesFromFinalMessage("FILES: none")).toEqual([]);
  });

  it("extracts structured fields from the JSON footer format", () => {
    const finalMessage = [
      "Implemented the context-pack builder.",
      "",
      "LITHIUM_STATUS",
      JSON.stringify({
        summary: "context-pack builder wired",
        result: "success",
        files: ["src/main/services/project-store.ts", "src/main/services/app-service.ts"],
        risks: [],
        paper_actions: ["sync results section"],
        run_actions: ["rerun smoke test"],
        success_criteria: ["npm test"],
        open_questions: []
      })
    ].join("\n");

    expect(parseChangedFilesFromFinalMessage(finalMessage)).toEqual([
      "src/main/services/project-store.ts",
      "src/main/services/app-service.ts"
    ]);
    expect(extractFinalSummary(finalMessage)).toBe("context-pack builder wired");
    expect(
      inferFinalRunStatus({
        exitCode: 0,
        finalMessage,
        timedOut: false
      })
    ).toBe("completed");
  });

  it("prefers awaiting finalization over hung when output already exists", () => {
    expect(
      inferRunStatus({
        run: {
          id: "R001",
          taskId: "T001",
          threadId: "TH001",
          prompt: "Finalize the completed run.",
          model: "gpt-5.4",
          command: { command: "codex", args: [], cwd: "/tmp/workspace" },
          status: "running",
          exitCode: null,
          pid: 123,
          stdoutPath: "/tmp/workspace/stdout.log",
          stderrPath: "/tmp/workspace/stderr.log",
          finalMessagePath: "/tmp/workspace/output.txt",
          changedFiles: [],
          handoff: null,
          finalMessage: "",
          finalization: null,
          createdAt: "2026-03-23T00:00:00.000Z",
          startedAt: "2026-03-23T00:00:00.000Z"
        },
        active: true,
        quietForMs: 180_000,
        outputText: "Done.\n\nLITHIUM_STATUS\n{\"summary\":\"done\",\"result\":\"success\"}"
      })
    ).toBe("awaiting-finalization");
  });

  it("does not mark a quiet active command as hung on the short idle threshold", () => {
    const previousHungThreshold = process.env.LITHIUM_RUN_HUNG_THRESHOLD_MS;
    const previousActiveHungThreshold = process.env.LITHIUM_RUN_ACTIVE_COMMAND_HUNG_THRESHOLD_MS;
    process.env.LITHIUM_RUN_HUNG_THRESHOLD_MS = "100";
    process.env.LITHIUM_RUN_ACTIVE_COMMAND_HUNG_THRESHOLD_MS = "1000";

    try {
      expect(
        inferRunStatus({
          run: {
            id: "R002",
            taskId: "T002",
            threadId: "TH002",
            prompt: "Run a long MLX compare.",
            model: "gpt-5.4",
            command: { command: "codex", args: [], cwd: "/tmp/workspace" },
            status: "running",
            exitCode: null,
            pid: 456,
            stdoutPath: "/tmp/workspace/stdout.log",
            stderrPath: "/tmp/workspace/stderr.log",
            finalMessagePath: "/tmp/workspace/output.txt",
            changedFiles: [],
            handoff: null,
            finalMessage: "",
            finalization: null,
            createdAt: "2026-03-23T00:00:00.000Z",
            startedAt: "2026-03-23T00:00:00.000Z"
          },
          active: true,
          quietForMs: 250,
          outputText: "",
          activeCommand: "RUN_ID_PREFIX=mlx ./scripts/run_mlx_eval_compare.sh"
        })
      ).toBe("running");
    } finally {
      if (typeof previousHungThreshold === "string") {
        process.env.LITHIUM_RUN_HUNG_THRESHOLD_MS = previousHungThreshold;
      } else {
        delete process.env.LITHIUM_RUN_HUNG_THRESHOLD_MS;
      }

      if (typeof previousActiveHungThreshold === "string") {
        process.env.LITHIUM_RUN_ACTIVE_COMMAND_HUNG_THRESHOLD_MS = previousActiveHungThreshold;
      } else {
        delete process.env.LITHIUM_RUN_ACTIVE_COMMAND_HUNG_THRESHOLD_MS;
      }
    }
  });

  it("filters git status paths that escape a nested workspace", () => {
    const workspacePath = "/repo/demo-loop";
    const gitRoot = "/repo";

    expect(
      normalizeGitChangedPath("demo-loop/experiments/run_experiment.py", workspacePath, gitRoot)
    ).toBe("experiments/run_experiment.py");
    expect(normalizeGitChangedPath("README.md", workspacePath, gitRoot)).toBeNull();
  });

  it("dequotes porcelain paths before normalizing them", () => {
    expect(normalizeGitChangedPath('"file with space.txt"', "/repo", "/repo")).toBe("file with space.txt");
    expect(normalizeGitChangedPath('"caf\\303\\251.txt"', "/repo", "/repo")).toBe("café.txt");
  });

  it("reads a tracked file diff relative to the workspace", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-diff-"));
    const filePath = path.join(workspacePath, "notes.md");

    execFileSync("git", ["init"], { cwd: workspacePath });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspacePath });
    execFileSync("git", ["config", "user.name", "Lithium Test"], { cwd: workspacePath });
    await writeFile(filePath, "hello\n", "utf8");
    execFileSync("git", ["add", "notes.md"], { cwd: workspacePath });
    execFileSync("git", ["commit", "-m", "init"], { cwd: workspacePath });

    await writeFile(filePath, "hello\nworld\n", "utf8");

    const diff = await readWorkspaceFileDiff(workspacePath, filePath);

    expect(diff?.relativePath).toBe("notes.md");
    expect(diff?.status).toBe("modified");
    expect(diff?.diffText).toContain("diff --git");
    expect(diff?.diffText).toContain("+world");
  });

  it("reads git status and diffs from a single nested repository", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-nested-diff-"));
    const repoPath = path.join(workspacePath, "official");
    const filePath = path.join(repoPath, "notes.md");

    await writeFile(path.join(workspacePath, "README.md"), "workspace root\n", "utf8");
    await mkdir(repoPath, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    execFileSync("git", ["config", "user.name", "Lithium Test"], { cwd: repoPath });
    await writeFile(filePath, "hello\n", "utf8");
    execFileSync("git", ["add", "notes.md"], { cwd: repoPath });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath });

    await writeFile(filePath, "hello\nnested\n", "utf8");

    const changedFiles = await collectGitChangedFiles(workspacePath);
    const diff = await readWorkspaceFileDiff(workspacePath, filePath);

    expect(changedFiles).toContain("official/notes.md");
    expect(diff?.relativePath).toBe("official/notes.md");
    expect(diff?.status).toBe("modified");
    expect(diff?.diffText).toContain("+nested");
  });

  it("collects untracked files with spaces from porcelain output", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "lithium-quoted-status-"));
    execFileSync("git", ["init"], { cwd: workspacePath });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspacePath });
    execFileSync("git", ["config", "user.name", "Lithium Test"], { cwd: workspacePath });
    await writeFile(path.join(workspacePath, "file with space.txt"), "hello\n", "utf8");

    const changedFiles = await collectGitChangedFiles(workspacePath);

    expect(changedFiles).toContain("file with space.txt");
  });
});
