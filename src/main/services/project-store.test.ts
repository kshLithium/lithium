import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "./project-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupTempDirs(tempDirs.splice(0));
});

describe("ProjectStore", () => {
  it("initializes durable project memory files", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();

    await store.initProject(workspace);

    const paths = store.buildPaths(workspace);
    await expect(access(paths.projectMemoryFile)).resolves.toBeUndefined();
    await expect(access(paths.memoryBriefFile)).resolves.toBeUndefined();
    await expect(access(paths.memoryOpenQuestionsFile)).resolves.toBeUndefined();
    await expect(access(paths.memorySessionSummaryFile)).resolves.toBeUndefined();
  });

  it("includes project memory in the strategist context bundle", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();

    await store.initProject(workspace);
    await store.writeProjectMemory(workspace, {
      projectBrief: "Investigate the Lithium strategist loop.",
      researchGoal: "Ship the smallest useful research cockpit.",
      openQuestions: ["How should memory be persisted?"]
    });

    const [bundlePath] = await store.buildContextBundle(workspace, "Plan the next slice.");
    const content = await readFile(bundlePath, "utf8");

    expect(content).toContain("## Project Memory");
    expect(content).toContain("Investigate the Lithium strategist loop.");
    expect(content.indexOf("## Project Memory")).toBeLessThan(content.indexOf("## Latest Decision"));
  });

  it("creates a default thread and includes other thread summaries in the context bundle", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();

    const project = await store.initProject(workspace);
    const defaultSnapshot = await store.getSnapshot(workspace);
    expect(defaultSnapshot.activeThreadId).toBe(project.activeThreadId);
    expect(defaultSnapshot.threads).toHaveLength(1);
    expect(defaultSnapshot.activeThread?.title).toBe("Main thread");

    const secondThread = await store.createThread(workspace, "Literature sweep");
    await store.updateThread(workspace, secondThread.id, {
      summary: "Track related SVM papers and baselines."
    });
    await store.selectThread(workspace, project.defaultThreadId);

    const [bundlePath] = await store.buildContextBundle(workspace, "Summarize the workspace state.");
    const content = await readFile(bundlePath, "utf8");

    expect(content).toContain("## Active Thread");
    expect(content).toContain("Main thread");
    expect(content).toContain("## Other Thread Summaries");
    expect(content).toContain("Literature sweep");
    expect(content).toContain("Track related SVM papers and baselines.");
  });

  it("writes artifact-specific lane context packs", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();

    await store.initProject(workspace);
    const snapshot = await store.getSnapshot(workspace);

    await store.updateThread(workspace, snapshot.activeThreadId!, {
      memory: "Keep the builder lane focused on reproducible experiment scripts."
    });

    const [bundlePath] = await store.buildContextBundle(workspace, "Implement the next builder step.", {
      lane: "builder",
      artifactId: "R001"
    });
    const content = await readFile(bundlePath, "utf8");

    expect(bundlePath).toContain("R001.builder.md");
    expect(content).toContain("Lane: builder");
    expect(content).toContain("## Active Thread");
    expect(content).toContain("Manual memory: Keep the builder lane focused on reproducible experiment scripts.");
    expect(content).toContain("## Latest Decision");
    expect(content).toContain("## Output Contract");
    expect(content).not.toContain("## Thread Memory");
  });

  it("builds a thin runtime context without the heavy artifact sections", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();

    await store.initProject(workspace);
    const snapshot = await store.getSnapshot(workspace);
    const decisionId = (await store.allocateDecision(workspace)).id;
    const taskId = (await store.allocateTask(workspace)).id;
    await store.writeProjectMemory(workspace, {
      projectBrief: "Investigate a simpler orchestration context.",
      researchGoal: "Keep model inputs small and stable.",
      openQuestions: ["Should runtime context carry explicit open questions?"],
      activeHypotheses: ["The builder should see the strategist next task directly."],
      preferences: {
        strategistStyle: "Hypothesis-first.",
        builderStyle: "Bounded artifact updates."
      },
      sessionSummary: "The strategist just finished a workspace summary."
    });
    await store.updateThread(workspace, snapshot.activeThreadId!, {
      summary: "Track the minimum context needed for the next run.",
      memory: "Favor thin runtime state over giant bundles."
    });
    await store.writeDecision(workspace, {
      id: decisionId,
      threadId: snapshot.activeThreadId!,
      prompt: "Find the next bounded step.",
      displayPrompt: "Find the next bounded step.",
      model: "gpt-5.4",
      summary: "Summarize the current orchestration trade-off.",
      nextTask: "Update notes/runtime-context.md with the missing context fields.",
      rationale: "The next run needs a sharper handoff.",
      rawOutput: [
        "Summarize the current orchestration trade-off in one clean builder-facing plan.",
        "",
        "LITHIUM_HANDOFF",
        JSON.stringify({
          summary: "Summarize the current orchestration trade-off.",
          rationale: "The next run needs a sharper handoff."
        })
      ].join("\n"),
      command: { command: "npx", args: ["oracle"], cwd: workspace },
      engine: "browser",
      status: "completed",
      stdoutPath: path.join(workspace, ".lithium", "decisions", `${decisionId}.stdout.log`),
      stderrPath: path.join(workspace, ".lithium", "decisions", `${decisionId}.stderr.log`),
      outputPath: path.join(workspace, ".lithium", "decisions", `${decisionId}.output.txt`),
      contextPackPath: undefined,
      handoff: undefined,
      createdAt: "2026-03-20T00:00:00.000Z",
    });
    await store.writeTask(workspace, {
      id: taskId,
      threadId: snapshot.activeThreadId!,
      sourceDecisionId: decisionId,
      title: "Update notes/runtime-context.md",
      prompt: "Update notes/runtime-context.md with the missing context fields.",
      status: "pending",
      createdAt: "2026-03-20T00:00:02.000Z",
      updatedAt: "2026-03-20T00:00:02.000Z"
    });

    const runtimeContext = await store.buildRuntimeContext(
      workspace,
      "Continue with the next builder task.",
      {
        lane: "builder"
      }
    );

    expect(runtimeContext.content).toContain("# Lithium Runtime Context");
    expect(runtimeContext.content).toContain("## Project Memory");
    expect(runtimeContext.content).toContain("## Active Thread");
    expect(runtimeContext.content).toContain("## Latest State");
    expect(runtimeContext.content).toContain("## Active Attachments");
    expect(runtimeContext.content).toContain("Open Questions: Should runtime context carry explicit open questions?");
    expect(runtimeContext.content).toContain("Active Hypotheses: The builder should see the strategist next task directly.");
    expect(runtimeContext.content).toContain(
      "Latest strategist reply: Summarize the current orchestration trade-off in one clean builder-facing plan."
    );
    expect(runtimeContext.content).toContain(
      "Latest Task Prompt: Update notes/runtime-context.md with the missing context fields."
    );
    expect(runtimeContext.content).not.toContain("## Output Contract");
    expect(runtimeContext.content).not.toContain("## Other Thread Summaries");
    expect(runtimeContext.content).not.toContain("Key Files:");
  });

  it("allocates new artifact ids when partial logs already exist", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const paths = store.buildPaths(workspace);

    await store.initProject(workspace);
    await mkdir(paths.decisionsDir, { recursive: true });
    await writeFile(path.join(paths.decisionsDir, "D001.stdout.log"), "in-flight strategist run", "utf8");

    const decisionPaths = await store.allocateDecision(workspace);

    expect(decisionPaths.id).toBe("D002");
    expect(decisionPaths.stdoutPath).toContain("D002.stdout.log");
    expect(decisionPaths.outputPath).toContain("D002.output.txt");
  });

  it("reads and writes workspace files while rejecting workspace escapes", async () => {
    const workspace = await createWorkspace();
    const outsideDir = await createTempDir("lithium-store-outside-");
    const store = new ProjectStore();
    const outsideFile = path.join(outsideDir, "outside.txt");

    await writeFile(outsideFile, "secret\n", "utf8");

    const created = await store.writeWorkspaceFile(workspace, "experiments/quickstart.py", "print('hello')\n");
    const readBack = await store.readWorkspaceFile(workspace, "experiments/quickstart.py");
    const bytes = await store.readWorkspaceFileBytes(workspace, "experiments/quickstart.py");

    expect(created.relativePath).toBe("experiments/quickstart.py");
    expect(readBack.content).toContain("print('hello')");
    expect(Buffer.from(bytes).toString("utf8")).toContain("print('hello')");

    await expect(store.readWorkspaceFile(workspace, "../outside.txt")).rejects.toThrow(
      "Workspace files must stay inside the selected workspace."
    );
    await expect(store.readWorkspaceFileBytes(workspace, "../outside.txt")).rejects.toThrow(
      "Workspace files must stay inside the selected workspace."
    );
    await expect(store.writeWorkspaceFile(workspace, "../outside.py", "print('nope')\n")).rejects.toThrow(
      "Workspace files must stay inside the selected workspace."
    );
  });

  it("rejects symlink escapes that point outside the workspace", async () => {
    const workspace = await createWorkspace();
    const outsideDir = await createTempDir("lithium-store-symlink-outside-");
    const store = new ProjectStore();
    const outsideFile = path.join(outsideDir, "secret.txt");
    const symlinkPath = path.join(workspace, "linked-secret.txt");

    await writeFile(outsideFile, "secret\n", "utf8");
    await symlink(outsideFile, symlinkPath);

    await expect(store.readWorkspaceFile(workspace, "linked-secret.txt")).rejects.toThrow(
      "Workspace files must stay inside the selected workspace."
    );
    await expect(store.readWorkspaceFileBytes(workspace, "linked-secret.txt")).rejects.toThrow(
      "Workspace files must stay inside the selected workspace."
    );
  });

  it("lists every indexed workspace file instead of truncating after the first 200", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();

    await mkdir(path.join(workspace, "src"), { recursive: true });
    await Promise.all(
      Array.from({ length: 240 }, (_, index) =>
        writeFile(
          path.join(workspace, "src", `file-${String(index).padStart(3, "0")}.ts`),
          `export const value${index} = ${index};\n`,
          "utf8"
        )
      )
    );

    const files = await store.listWorkspaceFiles(workspace);

    expect(files).toHaveLength(240);
    expect(files[0]?.relativePath).toBe("src/file-000.ts");
    expect(files.at(-1)?.relativePath).toBe("src/file-239.ts");
  });

  it("ignores virtualenv directories when indexing workspace files", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();

    await mkdir(path.join(workspace, ".venv", "bin"), { recursive: true });
    await mkdir(path.join(workspace, "venv", "lib"), { recursive: true });
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, ".venv", "bin", "python3"), "", "utf8");
    await writeFile(path.join(workspace, "venv", "lib", "site.py"), "", "utf8");
    await writeFile(path.join(workspace, "src", "index.ts"), "export const value = 1;\n", "utf8");

    const files = await store.listWorkspaceFiles(workspace);

    expect(files.map((file) => file.relativePath)).toEqual(["src/index.ts"]);
  });

  it("imports attachments into the active thread and includes them in the context bundle", async () => {
    const workspace = await createWorkspace();
    const sourceDir = await createTempDir("lithium-attachment-source-");
    const store = new ProjectStore();

    await store.initProject(workspace);
    const snapshot = await store.getSnapshot(workspace);
    const notesPath = path.join(sourceDir, "notes.md");
    const metricsPath = path.join(sourceDir, "metrics.csv");

    await writeFile(notesPath, "# Notes\n\nTrack the next ablation and explain the failure mode.\n", "utf8");
    await writeFile(metricsPath, "step,score\n1,0.42\n2,0.51\n", "utf8");

    const imported = await store.importAttachments(workspace, snapshot.activeThreadId!, [
      notesPath,
      metricsPath
    ]);
    const nextSnapshot = await store.getSnapshot(workspace);
    const [bundlePath] = await store.buildContextBundle(workspace, "Review the imported evidence.");
    const bundle = await readFile(bundlePath, "utf8");

    expect(imported).toHaveLength(2);
    expect(nextSnapshot.activeThreadAttachments).toHaveLength(2);
    expect(nextSnapshot.activeThreadAttachments.map((record) => record.kind).sort()).toEqual([
      "csv",
      "text"
    ]);
    await expect(access(path.join(workspace, imported[0].relativePath))).resolves.toBeUndefined();
    await expect(
      access(path.join(store.buildPaths(workspace).attachmentRecordsDir, `${imported[0].id}.json`))
    ).resolves.toBeUndefined();
    expect(bundle).toContain("## Thread Attachments");
    expect(bundle).toContain("attachments/TH001/notes.md");
    expect(bundle).toContain("Track the next ablation and explain the failure mode.");
    expect(bundle).toContain("metrics.csv");
  });

  it("skips malformed record files instead of failing the snapshot", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const paths = store.buildPaths(workspace);

    await store.initProject(workspace);
    await writeFile(path.join(paths.decisionsDir, "D999.json"), "{not valid json");

    const snapshot = await store.getSnapshot(workspace);

    expect(snapshot.project).toBeTruthy();
    expect(snapshot.latestDecision).toBeNull();
  });

  it("backfills missing thread ids on legacy decision artifacts", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const paths = store.buildPaths(workspace);
    const now = "2026-03-18T00:00:00.000Z";

    await mkdir(paths.decisionsDir, { recursive: true });
    await writeFile(
      paths.projectFile,
      JSON.stringify(
        {
          id: "project-legacy",
          name: "Legacy",
          workspacePath: workspace,
          lithiumPath: paths.root,
          manuscriptPath: paths.resultsSection,
          oracleModel: "gpt-5.4-pro",
          codexModel: "gpt-5.4",
          createdAt: now,
          updatedAt: now
        },
        null,
        2
      )
    );
    await writeFile(
      path.join(paths.decisionsDir, "D001.json"),
      JSON.stringify(
        {
          id: "D001",
          prompt: "Legacy prompt",
          rawOutput: "SUMMARY: Legacy summary",
          summary: "Legacy summary",
          nextTask: "Legacy task",
          rationale: "Legacy rationale",
          model: "gpt-5.4-pro",
          engine: "browser",
          status: "completed",
          command: {
            command: "npx",
            args: ["oracle"],
            cwd: workspace
          },
          stdoutPath: path.join(paths.decisionsDir, "D001.stdout.log"),
          stderrPath: path.join(paths.decisionsDir, "D001.stderr.log"),
          outputPath: path.join(paths.decisionsDir, "D001.output.txt"),
          createdAt: now
        },
        null,
        2
      )
    );

    const snapshot = await store.getSnapshot(workspace);
    const persisted = JSON.parse(await readFile(path.join(paths.decisionsDir, "D001.json"), "utf8")) as {
      threadId?: string;
    };

    expect(snapshot.project?.defaultThreadId).toBeTruthy();
    expect(snapshot.latestDecision?.threadId).toBe(snapshot.project?.defaultThreadId);
    expect(persisted.threadId).toBe(snapshot.project?.defaultThreadId);
  });

  it("repairs strategist decisions from raw output when trailing references broke the original parse", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const now = "2026-03-19T00:00:00.000Z";

    await store.initProject(workspace);
    const snapshot = await store.getSnapshot(workspace);
    const decisionPaths = await store.allocateDecision(workspace);
    const rawOutput = [
      "운영 메모: 공식 소스를 사용했다.",
      "",
      "LITHIUM_HANDOFF",
      JSON.stringify({
        summary: "자연스럽게 정리된 최종 답변.",
        next_task: "필요하면 치트시트로 압축한다.",
        rationale: "The workspace had no local notes."
      }),
      "",
      '[1]: https://example.com "Example source"'
    ].join("\n");

    await store.writeDecision(workspace, {
      id: decisionPaths.id,
      threadId: snapshot.activeThreadId!,
      prompt: "오버워치 2 캐릭터를 정리해줘",
      rawOutput,
      summary: "운영 메모: 공식 소스를 사용했다.",
      nextTask: "Wait for the user's next request and do not change any files.",
      rationale: "Oracle did not return a structured rationale.",
      model: "gpt-5.4",
      engine: "browser",
      status: "completed",
      command: { command: "npx", args: ["oracle"], cwd: workspace },
      stdoutPath: decisionPaths.stdoutPath,
      stderrPath: decisionPaths.stderrPath,
      outputPath: decisionPaths.outputPath,
      createdAt: now
    });

    const repaired = await store.getSnapshot(workspace);

    expect(repaired.latestDecision?.summary).toBe("자연스럽게 정리된 최종 답변.");
    expect(repaired.latestDecision?.nextTask).toBeUndefined();
    expect(repaired.latestDecision?.rationale).toBe("The workspace had no local notes.");
  });

  it("builds a context bundle even when a legacy run omits changedFiles", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const paths = store.buildPaths(workspace);
    const now = "2026-03-19T00:00:00.000Z";

    await store.initProject(workspace);
    const snapshot = await store.getSnapshot(workspace);
    const taskPaths = await store.allocateTask(workspace);
    const runPaths = await store.allocateRun(workspace);

    await store.writeTask(workspace, {
      id: taskPaths.id,
      threadId: snapshot.activeThreadId!,
      title: "Legacy run task",
      prompt: "Legacy run task",
      status: "completed",
      createdAt: now,
      updatedAt: now
    });

    await writeFile(
      path.join(paths.runsDir, `${runPaths.id}.json`),
      JSON.stringify(
        {
          id: runPaths.id,
          threadId: snapshot.activeThreadId,
          taskId: taskPaths.id,
          prompt: "Legacy run task",
          model: "gpt-5.4",
          status: "completed",
          exitCode: 0,
          pid: null,
          command: { command: "codex", args: ["exec"], cwd: workspace },
          stdoutPath: runPaths.stdoutPath,
          stderrPath: runPaths.stderrPath,
          finalMessagePath: runPaths.outputPath,
          finalMessage: "Completed legacy run.",
          finalization: "auto",
          createdAt: now,
          startedAt: now,
          endedAt: now
        },
        null,
        2
      )
    );

    const [bundlePath] = await store.buildContextBundle(workspace, "Summarize the legacy run.");
    const content = await readFile(bundlePath, "utf8");

    expect(content).toContain("Paper artifact changed: no");
    expect(content).toContain("Changed files: none");
  });

  it("renames and deletes threads while cleaning thread artifacts", async () => {
    const workspace = await createWorkspace();
    const sourceDir = await createTempDir("lithium-thread-attachments-");
    const store = new ProjectStore();
    const project = await store.initProject(workspace);
    const paths = store.buildPaths(workspace);
    const secondThread = await store.createThread(workspace, "Second thread");
    const thirdThread = await store.createThread(workspace, "Third thread");

    await store.renameThread(workspace, secondThread.id, "  Literature sweep  ");
    const renamedThread = (await store.listThreads(workspace)).find((thread) => thread.id === secondThread.id);
    expect(renamedThread?.title).toBe("Literature sweep");

    const notesPath = path.join(sourceDir, "thread-notes.md");
    await writeFile(notesPath, "Thread-specific literature findings.\n", "utf8");
    const [attachment] = await store.importAttachments(workspace, secondThread.id, [notesPath]);

    const decisionPaths = await store.allocateDecision(workspace);
    const taskPaths = await store.allocateTask(workspace);
    const runPaths = await store.allocateRun(workspace);
    const sessionPaths = await store.allocateTerminalSession(workspace);
    const now = "2026-03-18T00:00:00.000Z";

    await Promise.all([
      writeFile(decisionPaths.stdoutPath, "decision stdout"),
      writeFile(decisionPaths.stderrPath, "decision stderr"),
      writeFile(decisionPaths.outputPath, "decision output"),
      writeFile(runPaths.stdoutPath, "run stdout"),
      writeFile(runPaths.stderrPath, "run stderr"),
      writeFile(runPaths.outputPath, "run output"),
      writeFile(sessionPaths.transcriptPath, "terminal stdout\nterminal stderr"),
      writeFile(sessionPaths.stdoutPath, ""),
      writeFile(sessionPaths.stderrPath, "")
    ]);

    await store.writeDecision(workspace, {
      id: decisionPaths.id,
      threadId: secondThread.id,
      prompt: "Thread decision",
      rawOutput: "SUMMARY: Thread decision",
      summary: "Thread decision",
      nextTask: "Thread task",
      rationale: "Thread rationale",
      model: "gpt-5.4-pro",
      engine: "browser",
      status: "completed",
      command: { command: "npx", args: ["oracle"], cwd: workspace },
      stdoutPath: decisionPaths.stdoutPath,
      stderrPath: decisionPaths.stderrPath,
      outputPath: decisionPaths.outputPath,
      createdAt: now
    });

    await store.writeTask(workspace, {
      id: taskPaths.id,
      threadId: secondThread.id,
      title: "Thread task",
      prompt: "Thread task",
      status: "completed",
      createdAt: now,
      updatedAt: now
    });

    await store.writeRun(workspace, {
      id: runPaths.id,
      threadId: secondThread.id,
      taskId: taskPaths.id,
      prompt: "Thread run",
      model: "gpt-5.4",
      status: "completed",
      exitCode: 0,
      pid: null,
      command: { command: "codex", args: ["exec"], cwd: workspace },
      stdoutPath: runPaths.stdoutPath,
      stderrPath: runPaths.stderrPath,
      finalMessagePath: runPaths.outputPath,
      finalMessage: "SUMMARY: thread run",
      changedFiles: [],
      finalization: "auto",
      createdAt: now,
      startedAt: now,
      endedAt: now
    });

    await store.writeTerminalSession(workspace, {
      id: sessionPaths.id,
      threadId: secondThread.id,
      workspacePath: workspace,
      shell: "zsh",
      cwd: workspace,
      status: "completed",
      exitCode: 0,
      pid: null,
      transcriptPath: sessionPaths.transcriptPath,
      stdoutPath: sessionPaths.stdoutPath,
      stderrPath: sessionPaths.stderrPath,
      cols: 120,
      rows: 32,
      startedAt: now,
      endedAt: now
    });

    await store.deleteThread(workspace, secondThread.id);
    const snapshot = await store.getSnapshot(workspace);

    expect(snapshot.threads).toHaveLength(2);
    expect(snapshot.activeThreadId).toBe(thirdThread.id);
    expect(snapshot.project?.defaultThreadId).toBe(project.defaultThreadId);
    await expect(access(path.join(paths.threadsDir, `${secondThread.id}.json`))).rejects.toThrow();
    await expect(access(path.join(paths.decisionsDir, `${decisionPaths.id}.json`))).rejects.toThrow();
    await expect(access(path.join(paths.tasksDir, `${taskPaths.id}.json`))).rejects.toThrow();
    await expect(access(path.join(paths.runsDir, `${runPaths.id}.json`))).rejects.toThrow();
    await expect(access(path.join(paths.terminalsDir, `${sessionPaths.id}.json`))).rejects.toThrow();
    await expect(access(path.join(paths.attachmentRecordsDir, `${attachment.id}.json`))).rejects.toThrow();
    await expect(access(decisionPaths.outputPath)).rejects.toThrow();
    await expect(access(runPaths.outputPath)).rejects.toThrow();
    await expect(access(sessionPaths.transcriptPath)).rejects.toThrow();
    await expect(access(path.join(workspace, attachment.relativePath))).rejects.toThrow();

    await store.deleteThread(workspace, thirdThread.id);
    await expect(store.deleteThread(workspace, project.defaultThreadId)).rejects.toThrow(
      "Cannot delete the last thread."
    );
  });
});

async function createWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lithium-store-"));
  tempDirs.push(workspace);
  return workspace;
}

async function cleanupTempDirs(dirs: string[]) {
  await Promise.all(
    dirs.map(async (dir) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    })
  );
}

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
