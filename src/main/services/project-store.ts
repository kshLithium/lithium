import { appendFile, copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AttachmentKind,
  AttachmentRecord,
  ArtifactKind,
  AutomationCheckpointRecord,
  AutomationSessionRecord,
  AutomationStepRecord,
  ContextPackLane,
  DecisionRecord,
  ManuscriptSectionRecord,
  LithiumHandoff,
  ProjectMemoryRecord,
  ProjectRecord,
  ProjectSnapshot,
  RouterTraceRecord,
  ThreadRecord,
  RunRecord,
  TerminalSessionSummary,
  TerminalSessionRecord,
  TaskRecord,
  WorkspaceFileContent,
  WorkspaceFileKind,
  WorkspaceFileRecord
} from "../../shared/types";
import { DEFAULT_PROJECT_RESEARCH_GOAL } from "../../shared/types";
import { extractFinalSummary, readTailText } from "./run-artifacts";
import { parseOracleOutput } from "./protocol";
import { parseTerminalCapture } from "./terminal-session";
import { resolveWorkspaceMemberPath } from "./workspace-paths";

const LITHIUM_DIR = ".lithium";
const PROJECT_FILE = "project.json";
const ACTIVITY_LOG = "activity.log";
const PROMPT_LOG = "prompt-log.jsonl";
const WORKSPACE_INDEX_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  LITHIUM_DIR,
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox"
]);

type ProjectPaths = {
  root: string;
  threadsDir: string;
  attachmentRecordsDir: string;
  decisionsDir: string;
  tasksDir: string;
  runsDir: string;
  routesDir: string;
  automationDir: string;
  automationSessionsDir: string;
  automationStepsDir: string;
  automationCheckpointsDir: string;
  terminalsDir: string;
  manuscriptDir: string;
  sectionsDir: string;
  contextDir: string;
  memoryDir: string;
  projectFile: string;
  activityLog: string;
  promptLog: string;
  resultsSection: string;
  contextBundle: string;
  projectMemoryFile: string;
  memoryBriefFile: string;
  memoryOpenQuestionsFile: string;
  memorySessionSummaryFile: string;
  memoryPreferencesFile: string;
  workspaceAttachmentsDir: string;
};

type ArtifactPaths = {
  id: string;
  jsonPath: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  transcriptPath: string;
};

type ContextPackOptions = {
  lane?: ContextPackLane;
  artifactId?: string;
};

type RuntimeContextOptions = {
  lane?: ContextPackLane | "router";
  artifactId?: string;
  includeManuscript?: boolean;
};

export class ProjectStore {
  buildPaths(workspacePath: string): ProjectPaths {
    const root = path.join(workspacePath, LITHIUM_DIR);

    return {
      root,
      threadsDir: path.join(root, "threads"),
      attachmentRecordsDir: path.join(root, "attachments"),
      decisionsDir: path.join(root, "decisions"),
      tasksDir: path.join(root, "tasks"),
      runsDir: path.join(root, "runs"),
      routesDir: path.join(root, "routes"),
      automationDir: path.join(root, "automation"),
      automationSessionsDir: path.join(root, "automation", "sessions"),
      automationStepsDir: path.join(root, "automation", "steps"),
      automationCheckpointsDir: path.join(root, "automation", "checkpoints"),
      terminalsDir: path.join(root, "terminals"),
      manuscriptDir: path.join(root, "manuscript"),
      sectionsDir: path.join(root, "manuscript", "sections"),
      contextDir: path.join(root, "context"),
      memoryDir: path.join(root, "memory"),
      projectFile: path.join(root, PROJECT_FILE),
      activityLog: path.join(root, ACTIVITY_LOG),
      promptLog: path.join(root, PROMPT_LOG),
      resultsSection: path.join(root, "manuscript", "sections", "results.md"),
      contextBundle: path.join(root, "context", "current-context.md"),
      projectMemoryFile: path.join(root, "memory", "project-memory.json"),
      memoryBriefFile: path.join(root, "memory", "brief.md"),
      memoryOpenQuestionsFile: path.join(root, "memory", "open-questions.md"),
      memorySessionSummaryFile: path.join(root, "memory", "session-summary.md"),
      memoryPreferencesFile: path.join(root, "memory", "preferences.json"),
      workspaceAttachmentsDir: path.join(workspacePath, "attachments")
    };
  }

  async initProject(workspacePath: string, projectPatch: Partial<ProjectRecord> = {}) {
    const paths = this.buildPaths(workspacePath);

    await mkdir(paths.decisionsDir, { recursive: true });
    await mkdir(paths.threadsDir, { recursive: true });
    await mkdir(paths.attachmentRecordsDir, { recursive: true });
    await mkdir(paths.tasksDir, { recursive: true });
    await mkdir(paths.runsDir, { recursive: true });
    await mkdir(paths.routesDir, { recursive: true });
    await mkdir(paths.automationSessionsDir, { recursive: true });
    await mkdir(paths.automationStepsDir, { recursive: true });
    await mkdir(paths.automationCheckpointsDir, { recursive: true });
    await mkdir(paths.terminalsDir, { recursive: true });
    await mkdir(paths.sectionsDir, { recursive: true });
    await mkdir(paths.contextDir, { recursive: true });
    await mkdir(paths.memoryDir, { recursive: true });
    await mkdir(paths.workspaceAttachmentsDir, { recursive: true });

    const existing = await this.readProject(workspacePath);
    const createdFresh = !existing;
    const now = new Date().toISOString();

    const project: ProjectRecord = existing ?? {
      id: `project-${randomUUID()}`,
      name: path.basename(workspacePath),
      workspacePath,
      lithiumPath: paths.root,
      manuscriptPath: paths.resultsSection,
      oracleModel: "gpt-5.4",
      codexModel: "gpt-5.4",
      defaultThreadId: "",
      activeThreadId: "",
      createdAt: now,
      updatedAt: now
    };

    const existingThreads = await this.readRecordDirectory<ThreadRecord>(paths.threadsDir);
    let defaultThread = existingThreads.find((thread) => thread.id === project.defaultThreadId) ?? null;
    let activeThread = existingThreads.find((thread) => thread.id === project.activeThreadId) ?? null;

    if (!defaultThread) {
      defaultThread = await this.createThreadRecord(workspacePath, {
        title: "Main thread"
      });
    }

    if (!activeThread) {
      activeThread = defaultThread;
    }

    const merged: ProjectRecord = {
      ...project,
      ...projectPatch,
      workspacePath,
      lithiumPath: paths.root,
      manuscriptPath: paths.resultsSection,
      defaultThreadId: projectPatch.defaultThreadId ?? defaultThread.id,
      activeThreadId: projectPatch.activeThreadId ?? activeThread.id,
      updatedAt: now
    };

    await this.writeJson(paths.projectFile, merged);
    await this.backfillLegacyThreadIds(workspacePath, merged.defaultThreadId);
    await this.ensureProjectMemory(workspacePath, merged.name);

    if (!(await this.exists(paths.resultsSection))) {
      const initialSection = [
        "# Results",
        "",
        "Lithium will project strategist decisions and builder runs into this section.",
        ""
      ].join("\n");

      await writeFile(paths.resultsSection, initialSection, "utf8");
    }

    if (createdFresh) {
      await this.appendActivity(workspacePath, `project initialized at ${workspacePath}`);
    }

    return merged;
  }

  async readProject(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);

    return this.readJson<ProjectRecord>(paths.projectFile);
  }

  async listThreads(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    const threads = await this.readRecordDirectory<ThreadRecord>(paths.threadsDir);
    return [...threads].sort(compareThreadsByRecency);
  }

  async listAttachments(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    const records = await this.readRecordDirectory<AttachmentRecord>(paths.attachmentRecordsDir);
    return [...records].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createThread(workspacePath: string, title?: string) {
    const project = await this.initProject(workspacePath);
    const thread = await this.createThreadRecord(workspacePath, {
      title: title?.trim() || nextThreadTitle(await this.listThreads(workspacePath))
    });
    await this.writeJson(this.buildPaths(workspacePath).projectFile, {
      ...project,
      activeThreadId: thread.id,
      updatedAt: new Date().toISOString()
    } satisfies ProjectRecord);
    await this.appendActivity(workspacePath, `${thread.id} created`);
    return thread;
  }

  async selectThread(workspacePath: string, threadId: string) {
    const project = await this.initProject(workspacePath);
    const threads = await this.listThreads(workspacePath);
    const nextThread = threads.find((thread) => thread.id === threadId);

    if (!nextThread) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    const updatedProject: ProjectRecord = {
      ...project,
      activeThreadId: threadId,
      updatedAt: new Date().toISOString()
    };

    await this.writeJson(this.buildPaths(workspacePath).projectFile, updatedProject);
    return updatedProject;
  }

  async renameThread(workspacePath: string, threadId: string, title: string) {
    const normalizedTitle = normalizeThreadTitle(title);
    const paths = this.buildPaths(workspacePath);
    const existing = await this.readJson<ThreadRecord>(path.join(paths.threadsDir, `${threadId}.json`));

    if (!existing) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    const nextThread: ThreadRecord = {
      ...existing,
      title: normalizedTitle,
      updatedAt: new Date().toISOString()
    };

    await this.writeThread(workspacePath, nextThread);
    await this.appendActivity(workspacePath, `${threadId} renamed to "${normalizedTitle}"`);
    return nextThread;
  }

  async importAttachments(workspacePath: string, threadId: string, filePaths: string[]) {
    const paths = this.buildPaths(workspacePath);
    const existing = await this.listAttachments(workspacePath);
    const imported: AttachmentRecord[] = [];

    for (const filePath of filePaths) {
      const absoluteSourcePath = path.resolve(filePath);
      const sourceStat = await stat(absoluteSourcePath);

      if (!sourceStat.isFile()) {
        continue;
      }

      const duplicate = existing.find(
        (record) =>
          record.threadId === threadId &&
          record.sourcePath === absoluteSourcePath &&
          record.sizeBytes === sourceStat.size
      );

      if (duplicate && (await this.exists(path.join(workspacePath, duplicate.relativePath)))) {
        imported.push(duplicate);
        continue;
      }

      const allocation = await this.allocateAttachment(workspacePath);
      const destination = await this.allocateAttachmentDestination(
        paths.workspaceAttachmentsDir,
        threadId,
        path.basename(absoluteSourcePath)
      );
      const now = new Date().toISOString();
      await mkdir(path.dirname(destination.absolutePath), { recursive: true });
      await copyFile(absoluteSourcePath, destination.absolutePath);

      const record: AttachmentRecord = {
        id: allocation.id,
        threadId,
        name: destination.fileName,
        relativePath: destination.relativePath,
        sourcePath: absoluteSourcePath,
        kind: classifyAttachmentKind(destination.absolutePath),
        sizeBytes: sourceStat.size,
        excerpt: await this.buildAttachmentExcerpt(destination.absolutePath),
        importedAt: now,
        updatedAt: now
      };

      await this.writeJson(allocation.jsonPath, record);
      imported.push(record);
      existing.unshift(record);
    }

    return imported;
  }

  async removeAttachment(workspacePath: string, attachmentId: string) {
    const paths = this.buildPaths(workspacePath);
    const jsonPath = path.join(paths.attachmentRecordsDir, `${attachmentId}.json`);
    const record = await this.readJson<AttachmentRecord>(jsonPath);

    if (!record) {
      return null;
    }

    await this.removeFileIfExists(jsonPath);
    await this.removeFileIfExists(path.join(workspacePath, record.relativePath));
    return record;
  }

  async deleteThread(workspacePath: string, threadId: string) {
    const project = await this.readProject(workspacePath);
    if (!project) {
      throw new Error("Project is not initialized.");
    }

    const threads = await this.listThreads(workspacePath);
    if (threads.length <= 1) {
      throw new Error("Cannot delete the last thread.");
    }

    if (!threads.some((thread) => thread.id === threadId)) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    const remainingThreads = threads.filter((thread) => thread.id !== threadId);
    const nextThread =
      remainingThreads.find((thread) => thread.id === project.activeThreadId) ??
      remainingThreads.find((thread) => thread.id === project.defaultThreadId) ??
      remainingThreads[0] ??
      null;

    if (!nextThread) {
      throw new Error("No remaining thread to activate.");
    }

    const updatedProject: ProjectRecord = {
      ...project,
      activeThreadId: nextThread.id,
      defaultThreadId: project.defaultThreadId === threadId ? nextThread.id : project.defaultThreadId,
      updatedAt: new Date().toISOString()
    };

    await this.deleteThreadArtifacts(workspacePath, threadId);
    await this.deleteThreadJson(workspacePath, threadId);
    await this.writeJson(this.buildPaths(workspacePath).projectFile, updatedProject);
    await this.appendActivity(workspacePath, `${threadId} deleted`);
    await this.updateSessionSummary(workspacePath);
    await this.buildContextBundle(
      workspacePath,
      "Refresh the Lithium context bundle after deleting a thread."
    );

    return updatedProject;
  }

  async updateThread(
    workspacePath: string,
    threadId: string,
    patch: Partial<
      Pick<
        ThreadRecord,
        "title" | "summary" | "memory" | "strategistContextFingerprint" | "strategistLastContextAttachedAt"
      >
    >
  ) {
    const paths = this.buildPaths(workspacePath);
    const existing = await this.readJson<ThreadRecord>(path.join(paths.threadsDir, `${threadId}.json`));

    if (!existing) {
      return null;
    }

    const nextThread: ThreadRecord = {
      ...existing,
      title: patch.title ?? existing.title,
      summary: patch.summary ?? existing.summary,
      memory: patch.memory ?? existing.memory ?? "",
      strategistContextFingerprint:
        patch.strategistContextFingerprint ?? existing.strategistContextFingerprint,
      strategistLastContextAttachedAt:
        patch.strategistLastContextAttachedAt ?? existing.strategistLastContextAttachedAt,
      updatedAt: new Date().toISOString()
    };

    await this.writeJson(path.join(paths.threadsDir, `${threadId}.json`), nextThread);
    return nextThread;
  }

  async readProjectMemory(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    return this.readJson<ProjectMemoryRecord>(paths.projectMemoryFile);
  }

  async writeProjectMemory(
    workspacePath: string,
    patch: Omit<Partial<ProjectMemoryRecord>, "preferences"> & {
      preferences?: Partial<ProjectMemoryRecord["preferences"]>;
    }
  ) {
    const project = (await this.readProject(workspacePath)) ?? (await this.initProject(workspacePath));
    const existing =
      (await this.readProjectMemory(workspacePath)) ?? createDefaultProjectMemory(project.name);
    const merged: ProjectMemoryRecord = {
      projectBrief: patch.projectBrief ?? existing.projectBrief,
      researchGoal: patch.researchGoal ?? existing.researchGoal,
      constraints: patch.constraints ?? existing.constraints,
      openQuestions: patch.openQuestions ?? existing.openQuestions,
      activeHypotheses: patch.activeHypotheses ?? existing.activeHypotheses,
      sessionSummary: patch.sessionSummary ?? existing.sessionSummary,
      preferences: {
        ...existing.preferences,
        ...patch.preferences
      },
      updatedAt: new Date().toISOString()
    };

    await this.writeProjectMemoryRecord(this.buildPaths(workspacePath), merged);
    return merged;
  }

  async updateSessionSummary(workspacePath: string) {
    const snapshot = await this.getSnapshot(workspacePath);

    if (!snapshot.project || !snapshot.memory) {
      return null;
    }

    const sessionSummary = [
      `Project: ${snapshot.project.name}`,
      `Active Thread: ${snapshot.activeThread?.title || "none"}`,
      `Active attachments: ${snapshot.activeThreadAttachments.length || 0}`,
      snapshot.latestDecision ? `Latest strategist summary: ${snapshot.latestDecision.summary}` : "Latest strategist summary: none",
      snapshot.latestRun
        ? `Latest run: ${snapshot.latestRun.id} (${snapshot.latestRun.status}, exit ${snapshot.latestRun.exitCode ?? "unknown"})`
        : "Latest run: none",
      snapshot.latestRun?.finalMessage
        ? `Latest builder summary: ${extractFinalSummary(snapshot.latestRun.finalMessage)}`
        : "Latest builder summary: none"
    ].join("\n");

    return this.writeProjectMemory(workspacePath, { sessionSummary });
  }

  async allocateDecision(workspacePath: string) {
    return this.allocateArtifacts(workspacePath, "D", this.buildPaths(workspacePath).decisionsDir);
  }

  async allocateThread(workspacePath: string) {
    const id = await this.nextId(this.buildPaths(workspacePath).threadsDir, "TH");

    return {
      id,
      jsonPath: path.join(this.buildPaths(workspacePath).threadsDir, `${id}.json`)
    };
  }

  async allocateTask(workspacePath: string) {
    const id = await this.nextId(this.buildPaths(workspacePath).tasksDir, "T");

    return {
      id,
      jsonPath: path.join(this.buildPaths(workspacePath).tasksDir, `${id}.json`)
    };
  }

  async allocateAttachment(workspacePath: string) {
    const id = await this.nextId(this.buildPaths(workspacePath).attachmentRecordsDir, "A");

    return {
      id,
      jsonPath: path.join(this.buildPaths(workspacePath).attachmentRecordsDir, `${id}.json`)
    };
  }

  async allocateRun(workspacePath: string) {
    return this.allocateArtifacts(workspacePath, "R", this.buildPaths(workspacePath).runsDir);
  }

  async allocateRouteTrace(workspacePath: string) {
    return this.allocateArtifacts(workspacePath, "Q", this.buildPaths(workspacePath).routesDir);
  }

  async allocateAutomationSession(workspacePath: string) {
    const id = await this.nextId(this.buildPaths(workspacePath).automationSessionsDir, "AU");

    return {
      id,
      jsonPath: path.join(this.buildPaths(workspacePath).automationSessionsDir, `${id}.json`)
    };
  }

  async allocateAutomationStep(workspacePath: string) {
    const id = await this.nextId(this.buildPaths(workspacePath).automationStepsDir, "AS");

    return {
      id,
      jsonPath: path.join(this.buildPaths(workspacePath).automationStepsDir, `${id}.json`)
    };
  }

  async allocateAutomationCheckpoint(workspacePath: string) {
    const id = await this.nextId(this.buildPaths(workspacePath).automationCheckpointsDir, "AC");

    return {
      id,
      jsonPath: path.join(this.buildPaths(workspacePath).automationCheckpointsDir, `${id}.json`)
    };
  }

  async allocateTerminalSession(workspacePath: string) {
    return this.allocateArtifacts(workspacePath, "S", this.buildPaths(workspacePath).terminalsDir);
  }

  async writeDecision(workspacePath: string, decision: DecisionRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).decisionsDir, `${decision.id}.json`);
    await this.writeJson(jsonPath, decision);
  }

  async writeThread(workspacePath: string, thread: ThreadRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).threadsDir, `${thread.id}.json`);
    await this.writeJson(jsonPath, thread);
  }

  async writeAttachment(workspacePath: string, attachment: AttachmentRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).attachmentRecordsDir, `${attachment.id}.json`);
    await this.writeJson(jsonPath, attachment);
  }

  async writeTask(workspacePath: string, task: TaskRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).tasksDir, `${task.id}.json`);
    await this.writeJson(jsonPath, task);
  }

  async writeRun(workspacePath: string, run: RunRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).runsDir, `${run.id}.json`);
    await this.writeJson(jsonPath, run);
  }

  async writeRouterTrace(workspacePath: string, trace: RouterTraceRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).routesDir, `${trace.id}.json`);
    await this.writeJson(jsonPath, trace);
  }

  async writeAutomationSession(workspacePath: string, session: AutomationSessionRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).automationSessionsDir, `${session.id}.json`);
    await this.writeJson(jsonPath, session);
  }

  async writeAutomationStep(workspacePath: string, step: AutomationStepRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).automationStepsDir, `${step.id}.json`);
    await this.writeJson(jsonPath, step);
  }

  async writeAutomationCheckpoint(workspacePath: string, checkpoint: AutomationCheckpointRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).automationCheckpointsDir, `${checkpoint.id}.json`);
    await this.writeJson(jsonPath, checkpoint);
  }

  async readRun(workspacePath: string, runId: string) {
    const jsonPath = path.join(this.buildPaths(workspacePath).runsDir, `${runId}.json`);
    return this.readJson<RunRecord>(jsonPath);
  }

  async listRuns(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    return this.readRecordDirectory<RunRecord>(paths.runsDir);
  }

  async writeTerminalSession(workspacePath: string, session: TerminalSessionRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).terminalsDir, `${session.id}.json`);
    await this.writeJson(jsonPath, session);
  }

  async readTerminalSession(workspacePath: string, sessionId: string) {
    const jsonPath = path.join(this.buildPaths(workspacePath).terminalsDir, `${sessionId}.json`);
    return this.readJson<TerminalSessionRecord>(jsonPath);
  }

  async listTerminalSessions(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    return this.readRecordDirectory<TerminalSessionRecord>(paths.terminalsDir);
  }

  async readAutomationSession(workspacePath: string, sessionId: string) {
    const jsonPath = path.join(this.buildPaths(workspacePath).automationSessionsDir, `${sessionId}.json`);
    const session = await this.readJson<AutomationSessionRecord>(jsonPath);
    return session ? normalizeAutomationSessionRecord(session) : null;
  }

  async listAutomationSessions(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    return (await this.readRecordDirectory<AutomationSessionRecord>(paths.automationSessionsDir)).map(
      normalizeAutomationSessionRecord
    );
  }

  async listAutomationSteps(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    return this.readRecordDirectory<AutomationStepRecord>(paths.automationStepsDir);
  }

  async listAutomationCheckpoints(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    return this.readRecordDirectory<AutomationCheckpointRecord>(paths.automationCheckpointsDir);
  }

  async writeManuscriptSection(workspacePath: string, content: string) {
    const paths = this.buildPaths(workspacePath);
    await writeFile(paths.resultsSection, content, "utf8");

    return {
      section: "results",
      path: paths.resultsSection,
      content,
      updatedAt: new Date().toISOString()
    } satisfies ManuscriptSectionRecord;
  }

  async appendActivity(workspacePath: string, message: string) {
    const paths = this.buildPaths(workspacePath);
    await mkdir(paths.root, { recursive: true });

    const existing = (await this.exists(paths.activityLog))
      ? await readFile(paths.activityLog, "utf8")
      : "";
    const entry = `[${new Date().toISOString()}] ${message}`;
    const next = existing ? `${existing}\n${entry}` : entry;

    await writeFile(paths.activityLog, next, "utf8");
  }

  async appendPromptLog(workspacePath: string, entry: Record<string, unknown>) {
    const paths = this.buildPaths(workspacePath);
    await mkdir(paths.root, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry
    });
    await appendFile(paths.promptLog, `${line}\n`, "utf8");
  }

  async buildRuntimeContext(
    workspacePath: string,
    prompt: string,
    options: RuntimeContextOptions = {}
  ) {
    const paths = this.buildPaths(workspacePath);
    await mkdir(paths.contextDir, { recursive: true });

    const snapshot = await this.getSnapshot(workspacePath);
    const lane = options.lane ?? "strategist";
    const runtimePath = options.artifactId
      ? path.join(paths.contextDir, `${options.artifactId}.${lane}.runtime.md`)
      : path.join(paths.contextDir, "current-runtime.md");
    const workspaceFiles =
      lane === "strategist" ? await this.listWorkspaceFiles(workspacePath) : [];
    const memory = snapshot.memory;
    const latestRunChangedFiles = snapshot.latestRun?.changedFiles ?? [];
    const latestRunSummary = snapshot.latestRun?.finalMessage
      ? extractFinalSummary(snapshot.latestRun.finalMessage)
      : "none";
    const attachmentLines = snapshot.activeThreadAttachments.length
      ? snapshot.activeThreadAttachments
          .slice(0, 8)
          .map((record) => formatRuntimeAttachment(record))
          .join("\n")
      : "- none";
    const manuscriptExcerpt = snapshot.manuscript?.content
      ? truncateRuntimeExcerpt(snapshot.manuscript.content, 320)
      : "none";
    const automationState = snapshot.latestAutomationSession
      ? `Automation: ${snapshot.latestAutomationSession.status} — ${truncateInline(snapshot.latestAutomationSession.currentStepSummary || snapshot.latestAutomationSession.objective, 220)}`
      : "Automation: none";
    const latestStateLines =
      lane === "strategist"
        ? [
            `Latest builder status: ${snapshot.latestRun?.status || "none"}`,
            `Latest builder summary: ${truncateInline(latestRunSummary, 220)}`,
            latestRunChangedFiles.length
              ? `Latest changed files: ${latestRunChangedFiles.slice(0, 6).join(", ")}`
              : "Latest changed files: none",
            automationState,
            snapshot.latestTerminalSession?.cwd
              ? `Latest terminal cwd: ${snapshot.latestTerminalSession.cwd}`
              : "Latest terminal cwd: none",
            snapshot.manuscript?.content ? "Manuscript content: available" : "Manuscript content: none"
          ]
        : [
            `Latest strategist summary: ${truncateInline(snapshot.latestDecision?.summary || "none", 260)}`,
            `Latest strategist rationale: ${truncateInline(snapshot.latestDecision?.rationale || "none", 220)}`,
            `Latest builder status: ${snapshot.latestRun?.status || "none"}`,
            `Latest builder summary: ${truncateInline(latestRunSummary, 220)}`,
            latestRunChangedFiles.length
              ? `Latest changed files: ${latestRunChangedFiles.slice(0, 6).join(", ")}`
              : "Latest changed files: none",
            automationState,
            snapshot.latestTerminalSession?.cwd
              ? `Latest terminal cwd: ${snapshot.latestTerminalSession.cwd}`
              : "Latest terminal cwd: none",
            snapshot.manuscript?.content ? "Manuscript content: available" : "Manuscript content: none"
          ];
    const keyFiles =
      lane === "strategist"
        ? workspaceFiles
            .filter((file) => !file.relativePath.startsWith(".lithium/"))
            .slice(0, 12)
            .map((file) => `- ${file.relativePath} (${file.kind})`)
            .join("\n") || "- none"
        : "";
    const readmeFile =
      lane === "strategist"
        ? workspaceFiles.find(
            (file) => !file.relativePath.startsWith(".lithium/") && /^readme(\.[^.]+)?$/i.test(file.name)
          )
        : undefined;
    const readmeExcerpt =
      lane === "strategist" && readmeFile
        ? truncateRuntimeExcerpt(
            await readFile(path.join(workspacePath, readmeFile.relativePath), "utf8").catch(() => ""),
            900
          ) || "none"
        : "none";
    const note = [
      "# Lithium Runtime Context",
      `Lane: ${lane}`,
      `Workspace: ${workspacePath}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "## User Request",
      prompt.trim() || "none",
      "",
      "## Project Memory",
      memory
        ? [
            `Brief: ${truncateInline(memory.projectBrief || "none", 220)}`,
            `Goal: ${truncateInline(memory.researchGoal || "none", 220)}`,
            `Constraints: ${memory.constraints.join("; ") || "none"}`,
            `Open Questions: ${memory.openQuestions.join("; ") || "none"}`,
            `Active Hypotheses: ${memory.activeHypotheses.join("; ") || "none"}`,
            `Strategist Style: ${truncateInline(memory.preferences.strategistStyle || "none", 160)}`,
            `Builder Style: ${truncateInline(memory.preferences.builderStyle || "none", 160)}`,
            `Session Summary: ${truncateInline(memory.sessionSummary || "none", 220)}`
          ].join("\n")
        : "No project memory yet.",
      "",
      "## Active Thread",
      snapshot.activeThread
        ? [
            `Title: ${snapshot.activeThread.title}`,
            `Summary: ${truncateInline(snapshot.activeThread.summary || "none", 260)}`,
            `Memory: ${truncateInline(snapshot.activeThread.memory || "none", 220)}`,
            snapshot.latestTask ? `Latest Task: ${truncateInline(snapshot.latestTask.title, 140)}` : "Latest Task: none",
            snapshot.latestTask
              ? `Latest Task Prompt: ${truncateInline(snapshot.latestTask.prompt, 220)}`
              : "Latest Task Prompt: none"
          ].join("\n")
        : "No active thread yet.",
      "",
      "## Latest State",
      latestStateLines.join("\n"),
      lane === "strategist" ? "" : "",
      lane === "strategist" ? "## Key Files" : "",
      lane === "strategist" ? keyFiles : "",
      lane === "strategist" ? "" : "",
      lane === "strategist" ? "## README Excerpt" : "",
      lane === "strategist" ? readmeExcerpt : "",
      "",
      "## Active Attachments",
      attachmentLines,
      options.includeManuscript
        ? ["", "## Manuscript Excerpt", manuscriptExcerpt].join("\n")
        : ""
    ]
      .filter(Boolean)
      .join("\n");

    await writeFile(runtimePath, note, "utf8");

    return {
      content: note,
      path: runtimePath
    };
  }

  async buildContextBundle(workspacePath: string, prompt: string, options: ContextPackOptions = {}) {
    const paths = this.buildPaths(workspacePath);
    await mkdir(paths.contextDir, { recursive: true });

    const snapshot = await this.getSnapshot(workspacePath);
    const lane = options.lane ?? "strategist";
    const memory = snapshot.memory;
    const workspaceFiles = await this.listWorkspaceFiles(workspacePath);
    const packPath = options.artifactId
      ? path.join(paths.contextDir, `${options.artifactId}.${lane}.md`)
      : paths.contextBundle;
    const keyFiles = workspaceFiles
      .filter((file) => !file.relativePath.startsWith(".lithium/"))
      .slice(0, 16)
      .map((file) => `- ${file.relativePath} (${file.kind})`)
      .join("\n");
    const otherThreads = snapshot.threads.filter((thread) => thread.id !== snapshot.activeThreadId);
    const latestDecisionHandoff = deriveDecisionHandoff(snapshot.latestDecision);
    const latestRunHandoff = deriveRunHandoff(snapshot.latestRun);
    const latestRunChangedFiles = snapshot.latestRun?.changedFiles ?? [];
    const manuscriptExcerpt = snapshot.manuscript?.content
      ? snapshot.manuscript.content.slice(0, lane === "paper" ? 1200 : 420)
      : "No manuscript content yet.";
    const paperStatus = snapshot.latestRun
      ? [
          `Latest paper-related run: ${snapshot.latestRun.id}`,
          `Status: ${snapshot.latestRun.status}`,
          `Paper artifact changed: ${latestRunChangedFiles.includes("paper/main.pdf") ? "yes" : "no"}`
        ].join("\n")
      : "No paper compile state yet.";
    const workingSet = [
      snapshot.latestTask ? `Latest task: ${snapshot.latestTask.title}` : "Latest task: none",
      latestRunChangedFiles.length
        ? `Changed files: ${latestRunChangedFiles.join(", ")}`
        : "Changed files: none",
      snapshot.latestAutomationSession
        ? `Automation status: ${snapshot.latestAutomationSession.status}`
        : "Automation status: none",
      snapshot.activeThreadAttachments.length
        ? `Attachments: ${snapshot.activeThreadAttachments.map((record) => record.relativePath).join(", ")}`
        : "Attachments: none",
      snapshot.latestTerminalSession
        ? `Latest terminal cwd: ${snapshot.latestTerminalSession.cwd}`
        : "Latest terminal cwd: none"
    ].join("\n");

    const sections = [
      {
        title: "# Lithium Context Pack",
        body: [
          `Lane: ${lane}`,
          `Workspace: ${workspacePath}`,
          `Generated: ${new Date().toISOString()}`
        ].join("\n")
      },
      { title: "## User Request", body: prompt },
      {
        title: "## Project",
        body: snapshot.project
          ? `Name: ${snapshot.project.name}\nWorkspace: ${snapshot.project.workspacePath}\nStore: ${snapshot.project.lithiumPath}`
          : "Project is not initialized yet."
      },
      {
        title: "## Project Memory",
        body: memory
          ? [
              `Project Brief: ${memory.projectBrief}`,
              `Research Goal: ${memory.researchGoal}`,
              `Constraints: ${memory.constraints.join("; ") || "none"}`,
              `Strategist Style: ${memory.preferences.strategistStyle}`,
              `Builder Style: ${memory.preferences.builderStyle}`,
              `Open Questions: ${memory.openQuestions.join("; ") || "none"}`,
              `Active Hypotheses: ${memory.activeHypotheses.join("; ") || "none"}`,
              `Session Summary: ${memory.sessionSummary || "none"}`
            ].join("\n")
          : "No project memory yet."
      },
      {
        title: "## Active Thread",
        body: snapshot.activeThread
          ? [
              `Title: ${snapshot.activeThread.title}`,
              `Summary: ${snapshot.activeThread.summary || "none"}`,
              `Manual memory: ${snapshot.activeThread.memory || "none"}`,
              `Thread ID: ${snapshot.activeThread.id}`,
              snapshot.latestTask ? `Latest task title: ${snapshot.latestTask.title}` : "Latest task title: none",
              snapshot.latestTask ? `Latest task prompt: ${snapshot.latestTask.prompt}` : "Latest task prompt: none"
            ].join("\n")
          : "No active thread yet."
      },
      {
        title: "## Thread Attachments",
        body: snapshot.activeThreadAttachments.length
          ? snapshot.activeThreadAttachments
              .slice(0, 8)
              .map((record) => formatAttachment(record))
              .join("\n\n")
          : "No thread attachments yet."
      },
      lane === "strategist"
        ? {
            title: "## Other Thread Summaries",
            body: otherThreads.length
              ? otherThreads
                  .slice(0, 8)
                  .map(
                    (thread) =>
                      `- ${thread.title}: ${thread.summary || "No summary yet."} (updated ${thread.updatedAt})`
                  )
                  .join("\n")
              : "- none"
          }
        : null,
      {
        title: "## Latest Decision",
        body: latestDecisionHandoff
          ? formatHandoff(latestDecisionHandoff)
          : "No strategist handoff yet."
      },
      {
        title: "## Latest Run",
        body: latestRunHandoff
          ? formatHandoff(latestRunHandoff)
          : "No builder handoff yet."
      },
      {
        title: "## Paper State",
        body:
          lane === "builder"
            ? paperStatus
            : `${paperStatus}\n\n${manuscriptExcerpt}`
      },
      {
        title: "## Working Set",
        body: `${workingSet}\n\nKey Files:\n${keyFiles || "- No indexed files."}`
      },
      {
        title: "## Output Contract",
        body: renderOutputContract(lane)
      }
    ].filter((section): section is { title: string; body: string } => Boolean(section));

    const bundle = sections.map((section) => `${section.title}\n${section.body}`).join("\n\n");

    await writeFile(paths.contextBundle, bundle, "utf8");

    if (packPath !== paths.contextBundle) {
      await writeFile(packPath, bundle, "utf8");
    }

    return [packPath];
  }

  async getSnapshot(workspacePath: string): Promise<ProjectSnapshot> {
    let project = await this.readProject(workspacePath);

    if (project && (!project.defaultThreadId || !project.activeThreadId)) {
      project = await this.initProject(workspacePath);
    }

    if (!project) {
      return {
        project: null,
        memory: null,
        threads: [],
        activeThreadId: null,
        activeThread: null,
        attachments: [],
        activeThreadAttachments: [],
        decisions: [],
        tasks: [],
        runs: [],
        routerTraces: [],
        latestDecision: null,
        latestTask: null,
        latestRun: null,
        latestRouterTrace: null,
        terminalSessions: [],
        latestTerminalSession: null,
        manuscript: null,
        automationSessions: [],
        automationSteps: [],
        automationCheckpoints: [],
        latestAutomationSession: null,
        latestAutomationCheckpoint: null,
        logs: []
      };
    }

    const paths = this.buildPaths(workspacePath);
    const memory = await this.readProjectMemory(workspacePath);
    const threads = await this.listThreads(workspacePath);
    const activeThreadId = resolveActiveThreadId(project, threads);
    const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
    const attachments = await this.listAttachments(workspacePath);
    const activeThreadAttachments = attachments.filter((record) => record.threadId === activeThreadId);
    const decisions = (await this.readRecordDirectory<DecisionRecord>(paths.decisionsDir))
      .map((record) => normalizeDecisionRecord(record, project.defaultThreadId))
      .filter((record) => record.threadId === activeThreadId);
    const tasks = (await this.readRecordDirectory<TaskRecord>(paths.tasksDir))
      .map((record) => normalizeTaskRecord(record, project.defaultThreadId))
      .filter((record) => record.threadId === activeThreadId);
    const runs = (await this.readRecordDirectory<RunRecord>(paths.runsDir))
      .map((record) => normalizeRunRecord(record, project.defaultThreadId))
      .filter((record) => record.threadId === activeThreadId);
    const latestBuilderRun = runs.find((run) => run.model !== "tectonic") ?? null;
    const routerTraces = (await this.readRecordDirectory<RouterTraceRecord>(paths.routesDir))
      .filter((record) => record.threadId === activeThreadId)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
    const terminalSessions = await Promise.all(
      (await this.readRecordDirectory<TerminalSessionRecord>(paths.terminalsDir))
        .filter((record) => record.threadId === activeThreadId)
        .slice(0, 16)
        .map(async (record) => this.readTerminalSessionSummary(record))
    );
    const automationSessions = (await this.readRecordDirectory<AutomationSessionRecord>(paths.automationSessionsDir))
      .filter((record) => record.threadId === activeThreadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const automationSteps = (await this.readRecordDirectory<AutomationStepRecord>(paths.automationStepsDir))
      .filter((record) => record.threadId === activeThreadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const automationCheckpoints = (
      await this.readRecordDirectory<AutomationCheckpointRecord>(paths.automationCheckpointsDir)
    )
      .filter((record) => record.threadId === activeThreadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const manuscriptContent = await this.safeRead(paths.resultsSection);
    const logContent = await this.safeRead(paths.activityLog);

    const manuscript = manuscriptContent
      ? ({
          section: "results",
          path: paths.resultsSection,
          content: manuscriptContent,
          updatedAt: (await stat(paths.resultsSection)).mtime.toISOString()
        } satisfies ManuscriptSectionRecord)
      : null;

    const logs = logContent
      ? logContent
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-40)
          .reverse()
      : [];

    return {
      project,
      memory,
      threads,
      activeThreadId,
      activeThread,
      attachments,
      activeThreadAttachments,
      decisions,
      tasks,
      runs,
      routerTraces,
      latestDecision: decisions[0] ?? null,
      latestTask: tasks[0] ?? null,
      latestRun: latestBuilderRun,
      latestRouterTrace: routerTraces[0] ?? null,
      terminalSessions,
      latestTerminalSession: terminalSessions[0] ?? null,
      manuscript,
      automationSessions,
      automationSteps,
      automationCheckpoints,
      latestAutomationSession: automationSessions[0] ?? null,
      latestAutomationCheckpoint: automationCheckpoints[0] ?? null,
      logs
    };
  }

  async listWorkspaceFiles(workspacePath: string): Promise<WorkspaceFileRecord[]> {
    const output: WorkspaceFileRecord[] = [];
    await this.collectWorkspaceFiles(workspacePath, workspacePath, output);

    return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  async readWorkspaceFile(workspacePath: string, filePath: string): Promise<WorkspaceFileContent> {
    const absolutePath = await resolveWorkspaceMemberPath(workspacePath, filePath);
    const relativePath = path.relative(path.resolve(workspacePath), absolutePath) || path.basename(absolutePath);
    const fileMeta = classifyWorkspaceFile(absolutePath) ?? {
      kind: "artifact",
      artifactKind: "text" as const
    };
    const content = fileMeta.artifactKind === "pdf"
      ? ""
      : (await this.safeRead(absolutePath)) ?? "";

    return {
      path: absolutePath,
      relativePath,
      name: path.basename(absolutePath),
      kind: fileMeta.kind,
      artifactKind: fileMeta.artifactKind,
      content
    };
  }

  async readWorkspaceFileBytes(workspacePath: string, filePath: string): Promise<Uint8Array> {
    const absolutePath = await resolveWorkspaceMemberPath(workspacePath, filePath);
    return await readFile(absolutePath);
  }

  async writeWorkspaceFile(workspacePath: string, filePath: string, content: string) {
    const absolutePath = await resolveWorkspaceMemberPath(workspacePath, filePath);
    const extension = path.extname(absolutePath).toLowerCase();

    if (extension === ".pdf") {
      throw new Error("PDF files are binary and cannot be edited in the text editor.");
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");

    return this.readWorkspaceFile(workspacePath, absolutePath);
  }

  private async allocateAttachmentDestination(
    workspaceAttachmentsDir: string,
    threadId: string,
    sourceName: string
  ) {
    const safeName = sanitizeAttachmentFileName(sourceName);
    const extension = path.extname(safeName);
    const stem = extension ? safeName.slice(0, -extension.length) : safeName;
    const threadDir = path.join(workspaceAttachmentsDir, threadId);
    let index = 0;

    while (index < 500) {
      const fileName = index === 0 ? safeName : `${stem}-${index + 1}${extension}`;
      const absolutePath = path.join(threadDir, fileName);

      if (!(await this.exists(absolutePath))) {
        return {
          fileName,
          absolutePath,
          relativePath: path.relative(path.dirname(workspaceAttachmentsDir), absolutePath)
        };
      }

      index += 1;
    }

    throw new Error("Could not allocate an attachment file name.");
  }

  private async buildAttachmentExcerpt(filePath: string) {
    const kind = classifyAttachmentKind(filePath);

    if (kind === "pdf") {
      return "PDF attachment. Reference the file path directly when asking the model to inspect it.";
    }

    if (kind === "image") {
      return "Image attachment. Reference the file path directly when asking the model to inspect it.";
    }

    if (kind === "other") {
      return "Binary attachment stored in the workspace attachments directory.";
    }

    const content = await readFile(filePath, "utf8").catch(() => "");
    const lines = content
      .split("\n")
      .slice(0, 20)
      .join("\n")
      .trim();

    return lines ? truncateAttachmentExcerpt(lines, 1200) : "Text attachment with no readable preview.";
  }

  private async createThreadRecord(
    workspacePath: string,
    input: {
      title: string;
      summary?: string;
    }
  ) {
    const allocation = await this.allocateThread(workspacePath);
    const now = new Date().toISOString();
    const thread: ThreadRecord = {
      id: allocation.id,
      title: input.title,
      summary: input.summary ?? "No thread summary yet.",
      memory: "",
      createdAt: now,
      updatedAt: now
    };
    await this.writeThread(workspacePath, thread);
    return thread;
  }

  private async deleteThreadJson(workspacePath: string, threadId: string) {
    const jsonPath = path.join(this.buildPaths(workspacePath).threadsDir, `${threadId}.json`);
    await this.removeFileIfExists(jsonPath);
  }

  private async deleteThreadArtifacts(workspacePath: string, threadId: string) {
    const paths = this.buildPaths(workspacePath);
    const attachmentRecords = await this.readRecordDirectory<AttachmentRecord>(paths.attachmentRecordsDir);
    const decisionRecords = await this.readRecordDirectory<DecisionRecord>(paths.decisionsDir);
    const taskRecords = await this.readRecordDirectory<TaskRecord>(paths.tasksDir);
    const runRecords = await this.readRecordDirectory<RunRecord>(paths.runsDir);
    const routeRecords = await this.readRecordDirectory<RouterTraceRecord>(paths.routesDir);
    const terminalRecords = await this.readRecordDirectory<TerminalSessionRecord>(paths.terminalsDir);

    await Promise.all([
      ...attachmentRecords.filter((record) => record.threadId === threadId).flatMap((record) => [
        this.removeFileIfExists(path.join(paths.attachmentRecordsDir, `${record.id}.json`)),
        this.removeFileIfExists(path.join(workspacePath, record.relativePath))
      ]),
      ...decisionRecords.filter((record) => record.threadId === threadId).flatMap((record) => [
        this.removeFileIfExists(path.join(paths.decisionsDir, `${record.id}.json`)),
        this.removeFileIfExists(record.stdoutPath),
        this.removeFileIfExists(record.stderrPath),
        this.removeFileIfExists(record.outputPath)
      ]),
      ...taskRecords
        .filter((record) => record.threadId === threadId)
        .map((record) => this.removeFileIfExists(path.join(paths.tasksDir, `${record.id}.json`))),
      ...runRecords.filter((record) => record.threadId === threadId).flatMap((record) => [
        this.removeFileIfExists(path.join(paths.runsDir, `${record.id}.json`)),
        this.removeFileIfExists(record.stdoutPath),
        this.removeFileIfExists(record.stderrPath),
        this.removeFileIfExists(record.finalMessagePath)
      ]),
      ...routeRecords.filter((record) => record.threadId === threadId).flatMap((record) => [
        this.removeFileIfExists(path.join(paths.routesDir, `${record.id}.json`)),
        this.removeFileIfExists(record.stdoutPath),
        this.removeFileIfExists(record.stderrPath),
        this.removeFileIfExists(record.outputPath)
      ]),
      ...terminalRecords.filter((record) => record.threadId === threadId).flatMap((record) => [
        this.removeFileIfExists(path.join(paths.terminalsDir, `${record.id}.json`)),
        record.transcriptPath ? this.removeFileIfExists(record.transcriptPath) : Promise.resolve(),
        record.stdoutPath ? this.removeFileIfExists(record.stdoutPath) : Promise.resolve(),
        record.stderrPath ? this.removeFileIfExists(record.stderrPath) : Promise.resolve()
      ])
    ]);
  }

  private async backfillLegacyThreadIds(workspacePath: string, defaultThreadId: string) {
    const paths = this.buildPaths(workspacePath);

    await this.backfillThreadIdsInDirectory<DecisionRecord>(paths.decisionsDir, defaultThreadId);
    await this.backfillThreadIdsInDirectory<TaskRecord>(paths.tasksDir, defaultThreadId);
    await this.backfillThreadIdsInDirectory<RunRecord>(paths.runsDir, defaultThreadId);
    await this.backfillThreadIdsInDirectory<TerminalSessionRecord>(paths.terminalsDir, defaultThreadId);
  }

  private async backfillThreadIdsInDirectory<T extends { id: string; threadId?: string }>(
    directory: string,
    defaultThreadId: string
  ) {
    const records = await this.readRecordDirectory<T>(directory);

    await Promise.all(
      records.map(async (record) => {
        if (record.threadId) {
          return;
        }

        await this.writeJson(path.join(directory, `${record.id}.json`), {
          ...record,
          threadId: defaultThreadId
        });
      })
    );
  }

  private async allocateArtifacts(
    workspacePath: string,
    prefix: "D" | "Q" | "R" | "S",
    directory: string
  ): Promise<ArtifactPaths> {
    const id = await this.nextId(directory, prefix);

    return {
      id,
      jsonPath: path.join(directory, `${id}.json`),
      stdoutPath: path.join(directory, `${id}.stdout.log`),
      stderrPath: path.join(directory, `${id}.stderr.log`),
      outputPath: path.join(directory, `${id}.output.txt`),
      transcriptPath: path.join(directory, `${id}.transcript.log`)
    };
  }

  private async nextId(directory: string, prefix: string) {
    await mkdir(directory, { recursive: true });
    const entries = await readdir(directory);
    const next =
      entries
        .map((entry) => {
          const match = entry.match(new RegExp(`^${prefix}(\\d+)(?:\\.|$)`));
          return match ? Number(match[1]) : 0;
        })
        .reduce((max, value) => Math.max(max, value), 0) + 1;

    return `${prefix}${String(next).padStart(3, "0")}`;
  }

  private async readRecordDirectory<T>(directory: string) {
    if (!(await this.exists(directory))) {
      return [] as T[];
    }

    const entries = (await readdir(directory))
      .filter((entry) => entry.endsWith(".json"))
      .sort(compareRecordFiles)
      .reverse();
    const records: T[] = [];

    for (const entry of entries) {
      try {
        const content = await readFile(path.join(directory, entry), "utf8");
        records.push(JSON.parse(content) as T);
      } catch {
        continue;
      }
    }

    return records;
  }

  private async readJson<T>(filePath: string) {
    if (!(await this.exists(filePath))) {
      return null;
    }

    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  }

  private async writeJson(filePath: string, value: unknown) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private async removeFileIfExists(filePath: string) {
    await unlink(filePath).catch(() => undefined);
  }

  private async readTerminalSessionSummary(record: TerminalSessionRecord): Promise<TerminalSessionSummary> {
    const output = await this.readTerminalTranscriptTail(record);

    return {
      ...record,
      output
    };
  }

  private async readTerminalTranscriptTail(record: TerminalSessionRecord) {
    if (record.transcriptPath) {
      const output = await readTailText(record.transcriptPath, 24 * 1024);

      if (output) {
        return output.trimEnd();
      }
    }

    if (!record.stdoutPath && !record.stderrPath) {
      return "";
    }

    const [stdout, stderr] = await Promise.all([
      record.stdoutPath ? readTailText(record.stdoutPath, 24 * 1024) : Promise.resolve(""),
      record.stderrPath ? readTailText(record.stderrPath, 24 * 1024) : Promise.resolve("")
    ]);
    const parsed = parseTerminalCapture(stdout, stderr, record.cwd);
    return parsed.output;
  }

  private async safeRead(filePath: string) {
    if (!(await this.exists(filePath))) {
      return null;
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

  private async ensureProjectMemory(workspacePath: string, projectName: string) {
    const existing = await this.readProjectMemory(workspacePath);
    const record = existing ?? createDefaultProjectMemory(projectName);
    await this.writeProjectMemoryRecord(this.buildPaths(workspacePath), record);
    return record;
  }

  private async writeProjectMemoryRecord(paths: ProjectPaths, memory: ProjectMemoryRecord) {
    await this.writeJson(paths.projectMemoryFile, memory);
    await writeFile(paths.memoryBriefFile, renderBrief(memory), "utf8");
    await writeFile(paths.memoryOpenQuestionsFile, renderOpenQuestions(memory), "utf8");
    await writeFile(paths.memorySessionSummaryFile, renderSessionSummary(memory), "utf8");
    await this.writeJson(paths.memoryPreferencesFile, memory.preferences);
  }

  private async collectWorkspaceFiles(
    workspaceRoot: string,
    currentPath: string,
    output: WorkspaceFileRecord[]
  ) {
    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (WORKSPACE_INDEX_IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await this.collectWorkspaceFiles(workspaceRoot, fullPath, output);
        continue;
      }

      const fileMeta = classifyWorkspaceFile(fullPath);
      if (!fileMeta) {
        continue;
      }

      output.push({
        path: fullPath,
        relativePath: path.relative(workspaceRoot, fullPath),
        name: path.basename(fullPath),
        kind: fileMeta.kind,
        artifactKind: fileMeta.artifactKind
      });
    }
  }
}

function createDefaultProjectMemory(projectName: string): ProjectMemoryRecord {
  return {
    projectBrief: `${projectName} is the active Lithium workspace.`,
    researchGoal: DEFAULT_PROJECT_RESEARCH_GOAL,
    constraints: ["Local-first", "Single-user", "Prototype-first"],
    preferences: {
      strategistStyle: "Direct, critical, high-level.",
      builderStyle: "Concrete tasks with minimal narration.",
      manuscriptStyle: "Evidence-linked and concise."
    },
    openQuestions: ["What is the next concrete experiment or validation step?"],
    activeHypotheses: [],
    sessionSummary: "No session summary yet.",
    updatedAt: new Date().toISOString()
  };
}

function renderBrief(memory: ProjectMemoryRecord) {
  return [
    "# Project Brief",
    "",
    memory.projectBrief,
    "",
    "## Research Goal",
    "",
    memory.researchGoal,
    "",
    "## Constraints",
    "",
    ...(memory.constraints.length ? memory.constraints.map((item) => `- ${item}`) : ["- none"]),
    ""
  ].join("\n");
}

function renderOpenQuestions(memory: ProjectMemoryRecord) {
  return [
    "# Open Questions",
    "",
    ...(memory.openQuestions.length ? memory.openQuestions.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Active Hypotheses",
    "",
    ...(memory.activeHypotheses.length
      ? memory.activeHypotheses.map((item) => `- ${item}`)
      : ["- none"]),
    ""
  ].join("\n");
}

function renderSessionSummary(memory: ProjectMemoryRecord) {
  return ["# Session Summary", "", memory.sessionSummary || "No session summary yet.", ""].join("\n");
}

function resolveActiveThreadId(project: ProjectRecord, threads: ThreadRecord[]) {
  if (threads.some((thread) => thread.id === project.activeThreadId)) {
    return project.activeThreadId;
  }

  if (threads.some((thread) => thread.id === project.defaultThreadId)) {
    return project.defaultThreadId;
  }

  return threads[0]?.id ?? null;
}

function normalizeDecisionRecord(record: DecisionRecord, defaultThreadId: string): DecisionRecord {
  const structured =
    typeof record.rawOutput === "string" && record.rawOutput.includes("LITHIUM_HANDOFF")
      ? parseOracleOutput(record.rawOutput)
      : record.handoff;
  const handoff = structured
    ? stripLegacyNextTask(structured)
    : record.handoff
      ? stripLegacyNextTask(record.handoff)
      : undefined;

  return {
    ...record,
    threadId: record.threadId || defaultThreadId,
    summary: structured?.summary ?? record.summary,
    rationale: structured?.rationale ?? record.rationale,
    nextTask: undefined,
    handoff
  };
}

function normalizeTaskRecord(record: TaskRecord, defaultThreadId: string): TaskRecord {
  return {
    ...record,
    threadId: record.threadId || defaultThreadId
  };
}

function normalizeRunRecord(record: RunRecord, defaultThreadId: string): RunRecord {
  return {
    ...record,
    threadId: record.threadId || defaultThreadId
  };
}

function normalizeAutomationSessionRecord(record: AutomationSessionRecord): AutomationSessionRecord {
  return {
    ...record,
    status: record.status === "running" ? "running" : "idle"
  };
}

function deriveDecisionHandoff(record: DecisionRecord | null): LithiumHandoff | null {
  if (!record) {
    return null;
  }

  return (
    record.handoff ?? {
      schemaVersion: "lithium_handoff_v1",
      role: "strategist",
      summary: record.summary,
      rationale: record.rationale,
      files: [],
      risks: [],
      paperActions: [],
      runActions: [],
      successCriteria: [],
      openQuestions: []
    }
  );
}

function deriveRunHandoff(record: RunRecord | null): LithiumHandoff | null {
  if (!record) {
    return null;
  }

  return (
    record.handoff ?? {
      schemaVersion: "lithium_handoff_v1",
      role: "builder",
      summary: extractFinalSummary(record.finalMessage || ""),
      result: record.status === "completed" ? "success" : "failed",
      files: record.changedFiles ?? [],
      risks: [],
      paperActions: [],
      runActions: [],
      successCriteria: [],
      openQuestions: []
    }
  );
}

function formatHandoff(handoff: LithiumHandoff) {
  return [
    `Role: ${handoff.role}`,
    `Summary: ${handoff.summary}`,
    handoff.rationale ? `Rationale: ${handoff.rationale}` : null,
    handoff.result ? `Result: ${handoff.result}` : null,
    `Files: ${handoff.files.join("; ") || "none"}`,
    `Risks: ${handoff.risks.join("; ") || "none"}`,
    `Paper Actions: ${handoff.paperActions.join("; ") || "none"}`,
    `Run Actions: ${handoff.runActions.join("; ") || "none"}`,
    `Success Criteria: ${handoff.successCriteria.join("; ") || "none"}`,
    `Open Questions: ${handoff.openQuestions.join("; ") || "none"}`
  ]
    .filter(Boolean)
    .join("\n");
}

function renderOutputContract(lane: ContextPackLane) {
  if (lane === "strategist") {
    return [
      "Reply naturally first.",
      "Then append LITHIUM_HANDOFF with one compact JSON object for the app.",
      "Only include fields that actually help the next step."
    ].join("\n");
  }

  if (lane === "builder") {
    return [
      "Reply naturally first.",
      "Then append LITHIUM_STATUS with one compact JSON object for the app.",
      "Keep result in success, partial, or failed."
    ].join("\n");
  }

  return [
    "Produce artifact-grounded paper update guidance.",
    "Prefer evidence-linked section edits over free-form prose.",
    "Keep changes traceable back to local decisions, runs, and manuscript state."
  ].join("\n");
}

function compareRecordFiles(left: string, right: string) {
  const leftKey = parseRecordFileKey(left);
  const rightKey = parseRecordFileKey(right);

  if (leftKey && rightKey && leftKey.prefix === rightKey.prefix) {
    return leftKey.number - rightKey.number;
  }

  return left.localeCompare(right);
}

function parseRecordFileKey(fileName: string) {
  const match = fileName.match(/^([A-Za-z]+)(\d+)\.json$/);

  if (!match) {
    return null;
  }

  return {
    prefix: match[1],
    number: Number(match[2])
  };
}

function nextThreadTitle(threads: ThreadRecord[]) {
  const existingNumbers = threads
    .map((thread) => thread.title.match(/^New thread (\d+)$/i))
    .map((match) => (match ? Number(match[1]) : 0));
  const nextNumber = existingNumbers.reduce((max, value) => Math.max(max, value), 0) + 1;
  return `New thread ${nextNumber}`;
}

function compareThreadsByRecency(left: ThreadRecord, right: ThreadRecord) {
  const updatedAt = right.updatedAt.localeCompare(left.updatedAt);

  if (updatedAt !== 0) {
    return updatedAt;
  }

  const createdAt = right.createdAt.localeCompare(left.createdAt);

  if (createdAt !== 0) {
    return createdAt;
  }

  return left.id.localeCompare(right.id);
}

function normalizeThreadTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();

  if (!normalized) {
    throw new Error("Thread title cannot be empty.");
  }

  if (normalized.length > 64) {
    throw new Error("Thread title is too long.");
  }

  return normalized;
}

function formatAttachment(record: AttachmentRecord) {
  return [
    `- ${record.name} (${record.kind}, ${formatAttachmentSize(record.sizeBytes)})`,
    `  Path: ${record.relativePath}`,
    `  Source: ${record.sourcePath}`,
    `  Preview: ${record.excerpt || "none"}`
  ].join("\n");
}

function formatRuntimeAttachment(record: AttachmentRecord) {
  const excerpt = record.excerpt ? ` — ${truncateRuntimeExcerpt(record.excerpt, 120)}` : "";
  return `- ${record.relativePath} [${record.kind}]${excerpt}`;
}

function formatAttachmentSize(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateRuntimeExcerpt(value: string, limit: number) {
  const trimmed = value.replace(/\s+/g, " ").trim();

  if (trimmed.length <= limit) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function sanitizeAttachmentFileName(value: string) {
  const cleaned = value
    .replace(/[\\/]/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned || `attachment-${randomUUID().slice(0, 8)}`;
}

function stripLegacyNextTask(handoff: LithiumHandoff) {
  const { nextTask: _legacyNextTask, ...rest } = handoff;
  return rest;
}

function truncateAttachmentExcerpt(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function truncateInline(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function classifyAttachmentKind(filePath: string): AttachmentKind {
  const extension = path.extname(filePath).toLowerCase();

  if ([".json"].includes(extension)) {
    return "json";
  }

  if ([".csv", ".tsv"].includes(extension)) {
    return "csv";
  }

  if ([".pdf"].includes(extension)) {
    return "pdf";
  }

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(extension)) {
    return "image";
  }

  if ([".txt", ".md", ".tex", ".bib", ".py", ".sh", ".yaml", ".yml"].includes(extension)) {
    return "text";
  }

  return "other";
}

function classifyWorkspaceFile(filePath: string): { kind: WorkspaceFileKind; artifactKind: ArtifactKind } | null {
  const extension = path.extname(filePath).toLowerCase();

  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".css",
      ".sh",
      ".py",
      ".yaml",
      ".yml",
      ".toml",
      ".rs",
      ".go",
      ".java",
      ".c",
      ".cc",
      ".cpp",
      ".h",
      ".hpp"
    ].includes(extension)
  ) {
    return {
      kind: "code",
      artifactKind: "code"
    };
  }

  if ([".tex", ".bib", ".cls", ".sty"].includes(extension)) {
    return {
      kind: "paper",
      artifactKind: extension === ".bib" ? "bib" : "tex"
    };
  }

  if (extension === ".pdf") {
    return {
      kind: "paper",
      artifactKind: "pdf"
    };
  }

  if ([".json"].includes(extension)) {
    return {
      kind: "artifact",
      artifactKind: "json"
    };
  }

  if ([".csv", ".tsv"].includes(extension)) {
    return {
      kind: "artifact",
      artifactKind: "csv"
    };
  }

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(extension)) {
    return {
      kind: "artifact",
      artifactKind: "image"
    };
  }

  if ([".txt", ".md", ".log"].includes(extension)) {
    return {
      kind: "artifact",
      artifactKind: extension === ".log" ? "log" : "text"
    };
  }

  return null;
}
