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
      projectBrief: "Investigate the strategist loop.",
      researchGoal: "Ship the smallest useful research cockpit.",
      openQuestions: ["How should memory be persisted?"]
    });

    const [bundlePath] = await store.buildContextBundle(workspace, "Plan the next slice.");
    const content = await readFile(bundlePath, "utf8");

    expect(content).toContain("## Project Memory");
    expect(content).toContain("Investigate the strategist loop.");
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
      summary: "Track related SVM baselines and evidence."
    });
    await store.selectThread(workspace, project.defaultThreadId);

    const [bundlePath] = await store.buildContextBundle(workspace, "Summarize the workspace state.");
    const content = await readFile(bundlePath, "utf8");

    expect(content).toContain("## Active Thread");
    expect(content).toContain("Main thread");
    expect(content).toContain("## Other Thread Summaries");
    expect(content).toContain("Literature sweep");
    expect(content).toContain("Track related SVM baselines and evidence.");
  });

  it("writes artifact-specific lane context packs", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();

    await store.initProject(workspace);
    const snapshot = await store.getSnapshot(workspace);

    await store.updateThread(workspace, snapshot.activeThreadId!, {
      memory: "Keep the builder lane focused on reproducible experiment scripts."
    });

    const canonicalPath = store.buildPaths(workspace).contextBundle;
    await store.buildContextBundle(workspace, "Summarize the current workspace state.");
    const canonicalBefore = await readFile(canonicalPath, "utf8");

    const [bundlePath] = await store.buildContextBundle(workspace, "Implement the next builder step.", {
      lane: "builder",
      artifactId: "R001"
    });
    const content = await readFile(bundlePath, "utf8");
    const canonicalAfter = await readFile(canonicalPath, "utf8");

    expect(bundlePath).toContain("R001.builder.md");
    expect(content).toContain("Lane: builder");
    expect(content).toContain("## Active Thread");
    expect(content).toContain("Manual memory: Keep the builder lane focused on reproducible experiment scripts.");
    expect(content).toContain("## Latest Decision");
    expect(content).toContain("## Output Contract");
    expect(content).not.toContain("## Thread Memory");
    expect(canonicalBefore).toBe(canonicalAfter);
    expect(canonicalAfter).toContain("Lane: strategist");
  });

  it("allocates unique automation step ids under concurrent requests", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();

    await store.initProject(workspace);

    const allocations = await Promise.all(
      Array.from({ length: 6 }, () => store.allocateAutomationStep(workspace))
    );
    const ids = allocations.map((allocation) => allocation.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["AS001", "AS002", "AS003", "AS004", "AS005", "AS006"]);
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
      activeHypotheses: ["The execution loop should see the latest research task directly."],
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

    expect(runtimeContext.content).toContain("# Runtime Context");
    expect(runtimeContext.content).toContain("## Project Memory");
    expect(runtimeContext.content).toContain("## Active Thread");
    expect(runtimeContext.content).toContain("## Latest State");
    expect(runtimeContext.content).toContain("## Active Attachments");
    expect(runtimeContext.content).toContain("Open Questions: Should runtime context carry explicit open questions?");
    expect(runtimeContext.content).toContain("Active Hypotheses: The execution loop should see the latest research task directly.");
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

  it("does not duplicate the live user request inside runtime context conversation scaffolding", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();

    const project = await store.initProject(workspace);
    const firstEntry = await store.allocateConversationEntry(workspace);
    await store.writeConversationEntry(workspace, {
      id: firstEntry.id,
      threadId: project.activeThreadId,
      role: "user",
      source: "user",
      body: "Research more diverse approaches and keep the strategist actively advising.",
      createdAt: "2026-03-28T00:00:00.000Z"
    });
    const secondEntry = await store.allocateConversationEntry(workspace);
    await store.writeConversationEntry(workspace, {
      id: secondEntry.id,
      threadId: project.activeThreadId,
      role: "assistant",
      source: "orchestrator",
      body: "The latest bounded run finished and I am deciding what to do next.",
      createdAt: "2026-03-28T00:00:01.000Z"
    });

    const runtimeContext = await store.buildRuntimeContext(
      workspace,
      "Research more diverse approaches and keep the strategist actively advising.",
      { lane: "builder" }
    );

    expect(runtimeContext.content).toContain(
      "Guidance: use this request directly, but do not begin by repeating it verbatim."
    );
    expect(runtimeContext.content).toContain(
      "The latest bounded run finished and I am deciding what to do next."
    );
    expect(runtimeContext.content).not.toContain(
      "- User: Research more diverse approaches and keep the strategist actively advising."
    );
  });

  it("prefers the latest meaningful research run over a newer operational failure in runtime context and session summary", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();

    await store.initProject(workspace);
    const snapshot = await store.getSnapshot(workspace);

    await store.writeRun(workspace, {
      id: "R041",
      threadId: snapshot.activeThreadId!,
      taskId: "T041",
      prompt: "Run the full baseline eval.",
      displayPrompt: "Run the full baseline eval.",
      model: "gpt-5.4",
      status: "completed",
      exitCode: 0,
      pid: null,
      command: { command: "codex", args: ["exec"], cwd: workspace },
      stdoutPath: path.join(workspace, ".lithium", "runs", "R041.stdout.log"),
      stderrPath: path.join(workspace, ".lithium", "runs", "R041.stderr.log"),
      finalMessagePath: path.join(workspace, ".lithium", "runs", "R041.output.txt"),
      finalMessage: [
        "Full eval finished.",
        "",
        "LITHIUM_STATUS",
        "SUMMARY: full eval reached 2.45 bpb",
        "FILES: official/logs/full_eval.txt",
        "RESULT: success"
      ].join("\n"),
      changedFiles: ["official/logs/full_eval.txt"],
      finalization: "auto",
      createdAt: "2026-03-24T13:00:00.000Z",
      startedAt: "2026-03-24T13:00:00.000Z",
      endedAt: "2026-03-24T13:10:00.000Z"
    });
    await store.writeRun(workspace, {
      id: "R042",
      threadId: snapshot.activeThreadId!,
      taskId: "T042",
      prompt: "Continue the automation.",
      displayPrompt: "[autopilot] continue",
      model: "gpt-5.4",
      status: "cancelled",
      exitCode: null,
      pid: null,
      command: { command: "codex", args: ["exec"], cwd: workspace },
      stdoutPath: path.join(workspace, ".lithium", "runs", "R042.stdout.log"),
      stderrPath: path.join(workspace, ".lithium", "runs", "R042.stderr.log"),
      finalMessagePath: path.join(workspace, ".lithium", "runs", "R042.output.txt"),
      finalMessage: [
        "The app terminated a detached builder process after restart left it running without an active session.",
        "",
        "LITHIUM_STATUS",
        '{"machine_summary":"The app terminated a detached builder process after restart left it running without an active session.","result":"partial"}'
      ].join("\n"),
      changedFiles: [],
      finalization: "auto",
      createdAt: "2026-03-24T13:20:00.000Z",
      startedAt: "2026-03-24T13:20:00.000Z",
      endedAt: "2026-03-24T13:21:00.000Z"
    });

    await store.updateSessionSummary(workspace);
    const runtimeContext = await store.buildRuntimeContext(workspace, "Summarize the latest research state.", {
      lane: "strategist"
    });
    const memory = await store.readProjectMemory(workspace);

    expect(runtimeContext.content).toContain("Latest builder status: completed");
    expect(runtimeContext.content).toContain("Latest builder summary: Full eval finished.");
    expect(runtimeContext.content).toContain(
      "Latest operational issue: The app terminated a detached builder process after restart left it running without an active session."
    );
    expect(memory?.sessionSummary).toContain("Latest research run: R041 (completed, exit 0)");
    expect(memory?.sessionSummary).toContain("Latest builder summary: Full eval finished.");
    expect(memory?.sessionSummary).toContain(
      "Latest operational issue: The app terminated a detached builder process after restart left it running without an active session."
    );
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
    const reportPath = path.join(sourceDir, "report.pdf");
    const slidesPath = path.join(sourceDir, "slides.pptx");

    await writeFile(notesPath, "# Notes\n\nTrack the next ablation and explain the failure mode.\n", "utf8");
    await writeFile(metricsPath, "step,score\n1,0.42\n2,0.51\n", "utf8");
    await writeFile(reportPath, "%PDF-1.4\n%dummy\n", "utf8");
    await writeFile(slidesPath, "PK\x03\x04dummy\n", "utf8");

    const imported = await store.importAttachments(workspace, snapshot.activeThreadId!, [
      notesPath,
      metricsPath,
      reportPath,
      slidesPath
    ]);
    const nextSnapshot = await store.getSnapshot(workspace);
    const [bundlePath] = await store.buildContextBundle(workspace, "Review the imported evidence.");
    const bundle = await readFile(bundlePath, "utf8");

    expect(imported).toHaveLength(4);
    expect(nextSnapshot.activeThreadAttachments).toHaveLength(4);
    expect(nextSnapshot.activeThreadAttachments.map((record) => record.kind).sort()).toEqual([
      "csv",
      "document",
      "document",
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
    expect(bundle).toContain("report.pdf");
    expect(bundle).toContain("Document attachment. Reference the file path directly when asking the model to inspect it.");
  });

  it("keeps recently consumed thread attachments in strategist runtime and context packs", async () => {
    const workspace = await createWorkspace();
    const sourceDir = await createTempDir("lithium-consumed-attachment-source-");
    const store = new ProjectStore();

    await store.initProject(workspace);
    const snapshot = await store.getSnapshot(workspace);
    const notesPath = path.join(sourceDir, "handoff-notes.md");

    await writeFile(notesPath, "Keep this file visible even after the first strategist turn.\n", "utf8");

    const [imported] = await store.importAttachments(workspace, snapshot.activeThreadId!, [notesPath]);
    await store.consumeAttachments(workspace, [imported.id], {
      conversationEntryId: undefined,
      decisionId: "D001",
      runId: undefined
    });

    const runtimeContext = await store.buildRuntimeContext(workspace, "Use the prior evidence again.", {
      lane: "strategist"
    });
    const [bundlePath] = await store.buildContextBundle(workspace, "Use the prior evidence again.");
    const bundle = await readFile(bundlePath, "utf8");

    expect(runtimeContext.content).toContain("attachments/TH001/handoff-notes.md");
    expect(runtimeContext.content).toContain("[text, consumed]");
    expect(bundle).toContain("attachments/TH001/handoff-notes.md");
    expect(bundle).toContain("Status: consumed");
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

  it("backfills missing thread ids on stored decision records", async () => {
    const workspace = await createWorkspace();
    const store = new ProjectStore();
    const paths = store.buildPaths(workspace);
    const now = "2026-03-18T00:00:00.000Z";

    await mkdir(paths.decisionsDir, { recursive: true });
    await writeFile(
      paths.projectFile,
      JSON.stringify(
        {
          id: "project-history",
          name: "History",
          workspacePath: workspace,
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
          prompt: "Historical prompt",
          rawOutput: "Historical summary",
          summary: "Historical summary",
          rationale: "Historical rationale",
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
    expect(repaired.latestDecision?.rationale).toBe("The workspace had no local notes.");
  });

  it("builds a context bundle even when a stored run omits changedFiles", async () => {
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
      title: "Recovered run task",
      prompt: "Recovered run task",
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
          prompt: "Recovered run task",
          model: "gpt-5.4",
          status: "completed",
          exitCode: 0,
          pid: null,
          command: { command: "codex", args: ["exec"], cwd: workspace },
          stdoutPath: runPaths.stdoutPath,
          stderrPath: runPaths.stderrPath,
          finalMessagePath: runPaths.outputPath,
          finalMessage: "Completed recovered run.",
          finalization: "auto",
          createdAt: now,
          startedAt: now,
          endedAt: now
        },
        null,
        2
      )
    );

    const [bundlePath] = await store.buildContextBundle(workspace, "Summarize the recovered run.");
    const content = await readFile(bundlePath, "utf8");

    expect(content).toContain("Changed files: none");
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
