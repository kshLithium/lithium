import { appendFile, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  AttachmentKind,
  AttachmentRecord,
  AutomationCycleRecord,
  AutomationCheckpointRecord,
  AutomationSessionRecord,
  AutomationStepRecord,
  ConversationEntryRecord,
  ContextPackLane,
  DecisionRecord,
  LithiumHandoff,
  ProjectMemoryLayer,
  ProjectMemoryRecord,
  ProjectRecord,
  ProjectSnapshot,
  RouterTraceRecord,
  ThreadRecord,
  RunRecord,
  TaskRecord,
  WorkspaceFileRecord
} from "../../shared/types";
import { DEFAULT_PROJECT_RESEARCH_GOAL } from "../../shared/types";
import {
  handoffMachineSummary,
  handoffUserMessage,
  isOperationalAutomationMessage
} from "../../shared/handoff-utils";
import { extractFinalSummary } from "./run-artifacts";
import { parseOracleOutput } from "./protocol";
import { pathExists } from "./fs-utils";
import { classifyWorkspaceFile, walkWorkspaceIndex } from "./workspace-index";

const LITHIUM_DIR = ".lithium";
const PROJECT_FILE = "project.json";
const ACTIVITY_LOG = "activity.log";
const PROMPT_LOG = "prompt-log.jsonl";
const RECORD_READ_BATCH_SIZE = 32;
const DOCUMENT_ATTACHMENT_EXCERPT =
  "Document attachment. Reference the file path directly when asking the model to inspect it.";
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".rtf",
  ".odt",
  ".ods",
  ".odp"
]);

type ProjectPaths = {
  root: string;
  threadsDir: string;
  conversationEntriesDir: string;
  attachmentRecordsDir: string;
  decisionsDir: string;
  tasksDir: string;
  runsDir: string;
  routesDir: string;
  automationDir: string;
  automationSessionsDir: string;
  automationCyclesDir: string;
  automationStepsDir: string;
  automationCheckpointsDir: string;
  contextDir: string;
  memoryDir: string;
  projectFile: string;
  activityLog: string;
  promptLog: string;
  contextBundle: string;
  projectMemoryFile: string;
  memoryBriefFile: string;
  memoryOpenQuestionsFile: string;
  memorySessionSummaryFile: string;
  memoryDurableContextFile: string;
  memoryWorkingContextFile: string;
  memoryEvidenceContextFile: string;
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
  writeCanonical?: boolean;
};

type RuntimeContextOptions = {
  lane?: ContextPackLane | "router";
  artifactId?: string;
};

export class ProjectStore {
  buildPaths(workspacePath: string): ProjectPaths {
    const root = path.join(workspacePath, LITHIUM_DIR);

    return {
      root,
      threadsDir: path.join(root, "threads"),
      conversationEntriesDir: path.join(root, "conversation"),
      attachmentRecordsDir: path.join(root, "attachments"),
      decisionsDir: path.join(root, "decisions"),
      tasksDir: path.join(root, "tasks"),
      runsDir: path.join(root, "runs"),
      routesDir: path.join(root, "routes"),
      automationDir: path.join(root, "automation"),
      automationSessionsDir: path.join(root, "automation", "sessions"),
      automationCyclesDir: path.join(root, "automation", "cycles"),
      automationStepsDir: path.join(root, "automation", "steps"),
      automationCheckpointsDir: path.join(root, "automation", "checkpoints"),
      contextDir: path.join(root, "context"),
      memoryDir: path.join(root, "memory"),
      projectFile: path.join(root, PROJECT_FILE),
      activityLog: path.join(root, ACTIVITY_LOG),
      promptLog: path.join(root, PROMPT_LOG),
      contextBundle: path.join(root, "context", "current-context.md"),
      projectMemoryFile: path.join(root, "memory", "project-memory.json"),
      memoryBriefFile: path.join(root, "memory", "brief.md"),
      memoryOpenQuestionsFile: path.join(root, "memory", "open-questions.md"),
      memorySessionSummaryFile: path.join(root, "memory", "session-summary.md"),
      memoryDurableContextFile: path.join(root, "memory", "durable-context.md"),
      memoryWorkingContextFile: path.join(root, "memory", "working-context.md"),
      memoryEvidenceContextFile: path.join(root, "memory", "evidence-context.md"),
      memoryPreferencesFile: path.join(root, "memory", "preferences.json"),
      workspaceAttachmentsDir: path.join(workspacePath, "attachments")
    };
  }

  async initProject(workspacePath: string, projectPatch: Partial<ProjectRecord> = {}) {
    const paths = this.buildPaths(workspacePath);

    await mkdir(paths.decisionsDir, { recursive: true });
    await mkdir(paths.threadsDir, { recursive: true });
    await mkdir(paths.conversationEntriesDir, { recursive: true });
    await mkdir(paths.attachmentRecordsDir, { recursive: true });
    await mkdir(paths.tasksDir, { recursive: true });
    await mkdir(paths.runsDir, { recursive: true });
    await mkdir(paths.routesDir, { recursive: true });
    await mkdir(paths.automationDir, { recursive: true });
    await mkdir(paths.automationSessionsDir, { recursive: true });
    await mkdir(paths.automationCyclesDir, { recursive: true });
    await mkdir(paths.automationStepsDir, { recursive: true });
    await mkdir(paths.automationCheckpointsDir, { recursive: true });
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
      defaultThreadId: projectPatch.defaultThreadId ?? defaultThread.id,
      activeThreadId: projectPatch.activeThreadId ?? activeThread.id,
      updatedAt: now
    };

    await this.writeJson(paths.projectFile, merged);
    await this.ensureThreadIds(workspacePath, merged.defaultThreadId);
    await this.ensureProjectMemory(workspacePath, merged.name);

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
          isAttachmentRecordActive(record) &&
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

  async consumeAttachments(
    workspacePath: string,
    attachmentIds: string[],
    usage: Pick<AttachmentRecord, "conversationEntryId" | "decisionId" | "runId">
  ) {
    const now = new Date().toISOString();

    await Promise.all(
      attachmentIds.map(async (attachmentId) => {
        const current = await this.readAttachment(workspacePath, attachmentId);

        if (!current || !isAttachmentRecordActive(current)) {
          return;
        }

        await this.writeAttachment(workspacePath, {
          ...current,
          consumedAt: now,
          conversationEntryId: usage.conversationEntryId,
          decisionId: usage.decisionId,
          runId: usage.runId,
          updatedAt: now
        });
      })
    );
  }

  async updateThread(
    workspacePath: string,
    threadId: string,
    patch: Partial<
      Pick<ThreadRecord, "title" | "summary" | "memory" | "strategistContextFingerprint">
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
      updatedAt: new Date().toISOString()
    };

    await this.writeJson(path.join(paths.threadsDir, `${threadId}.json`), nextThread);
    return nextThread;
  }

  async readProjectMemory(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    const memory = await this.readJson<ProjectMemoryRecord>(paths.projectMemoryFile);

    if (!memory) {
      return null;
    }

    const project = await this.readProject(workspacePath);
    return normalizeProjectMemoryRecord(memory, project?.name ?? path.basename(workspacePath));
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
    const nextLayers = mergeProjectMemoryLayers(existing.layers, patch.layers, {
      projectBrief: patch.projectBrief,
      researchGoal: patch.researchGoal,
      constraints: patch.constraints,
      openQuestions: patch.openQuestions,
      activeHypotheses: patch.activeHypotheses,
      sessionSummary: patch.sessionSummary
    });
    const merged: ProjectMemoryRecord = {
      projectBrief: patch.projectBrief ?? nextLayers.narrative.activeStory,
      researchGoal: patch.researchGoal ?? nextLayers.narrative.northStar,
      constraints: patch.constraints ?? nextLayers.narrative.constraints,
      preferences: {
        ...existing.preferences,
        ...patch.preferences
      },
      openQuestions: patch.openQuestions ?? nextLayers.projectModel.openQuestions,
      activeHypotheses: patch.activeHypotheses ?? nextLayers.projectModel.activeHypotheses,
      sessionSummary: patch.sessionSummary ?? nextLayers.executionJournal.sessionSummary,
      layers: nextLayers,
      memoryMap: mergeProjectMemoryMap(existing.memoryMap, patch.memoryMap, nextLayers),
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

    const latestStrategistSummary = snapshot.latestDecision?.summary?.trim() || "";
    const latestStrategistReply = extractVisibleStrategistReply(snapshot.latestDecision?.rawOutput || "", 260);
    const latestContextRun = resolveLatestMeaningfulBuilderRun(snapshot.runs);
    const latestOperationalRun =
      snapshot.latestRun && snapshot.latestRun.id !== latestContextRun?.id ? snapshot.latestRun : null;
    const latestContextRunSummary = latestContextRun?.finalMessage
      ? extractFinalSummary(latestContextRun.finalMessage)
      : "none";
    const latestCycle = snapshot.latestAutomationCycle ?? null;
    const latestConversationBody = snapshot.latestConversationEntry?.body?.trim() || "";
    const summaryLanguage = resolveContextLanguage([
      latestConversationBody,
      snapshot.latestAutomationSession?.displayObjective || "",
      snapshot.latestAutomationSession?.objective || ""
    ]);

    const sessionSummary = [
      `Project: ${snapshot.project.name}`,
      `Active Thread: ${snapshot.activeThread?.title || "none"}`,
      `Active attachments: ${snapshot.activeThreadAttachments.length || 0}`,
      latestConversationBody ? `Latest chat reply: ${truncateInline(latestConversationBody, 220)}` : null,
      snapshot.latestDecision ? `Latest strategist summary: ${latestStrategistSummary || "none"}` : "Latest strategist summary: none",
      latestStrategistReply && !isRedundantInlineSummary(latestStrategistReply, latestStrategistSummary)
        ? `Latest strategist reply: ${latestStrategistReply}`
        : null,
      latestContextRun
        ? `Latest research run: ${latestContextRun.id} (${latestContextRun.status}, exit ${latestContextRun.exitCode ?? "unknown"})`
        : "Latest research run: none",
      latestContextRun ? `Latest builder summary: ${latestContextRunSummary}` : "Latest builder summary: none",
      formatAutomationSessionSummary(snapshot.latestAutomationSession, summaryLanguage),
      formatAutomationCycleSummary(latestCycle, summaryLanguage),
      latestOperationalRun?.finalMessage
        ? `Latest operational issue: ${extractFinalSummary(latestOperationalRun.finalMessage)}`
        : null
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    const updatedMemory = await this.writeProjectMemory(workspacePath, {
      sessionSummary,
      layers: {
        narrative: {
          northStar: snapshot.memory.researchGoal,
          activeStory: snapshot.memory.projectBrief,
          collaborationContract: snapshot.memory.constraints.slice(0, 6),
          currentFocus:
            snapshot.latestAutomationSession?.currentStepSummary ||
            snapshot.latestAutomationSession?.displayObjective ||
            snapshot.latestAutomationSession?.objective ||
            latestConversationBody ||
            "none",
          recentDirections: [latestConversationBody].filter(Boolean),
          constraints: snapshot.memory.constraints
        },
        projectModel: {
          openQuestions: snapshot.memory.openQuestions,
          activeHypotheses: snapshot.memory.activeHypotheses,
          stableFacts: [snapshot.project.name, snapshot.memory.projectBrief].filter(Boolean),
          keyDecisions: [latestStrategistSummary, latestContextRunSummary].filter(Boolean),
          metrics: [latestContextRun ? `${latestContextRun.id}: ${latestContextRunSummary}` : ""].filter(Boolean),
          learnedPatterns: [latestCycle?.summary || ""].filter(Boolean)
        },
        executionJournal: {
          sessionSummary,
          activeAutomationSummary:
            formatAutomationSessionSummary(snapshot.latestAutomationSession, summaryLanguage) || "none",
          recentArtifacts: [
            snapshot.latestDecision?.id || "",
            latestContextRun?.id || "",
            latestCycle?.id || ""
          ].filter(Boolean),
          recentCommands: [latestContextRun?.command.command || ""].filter(Boolean),
          recentLogs: logsToLines(snapshot.logs, 3),
          recoveryNotes: [latestOperationalRun?.finalMessage ? extractFinalSummary(latestOperationalRun.finalMessage) : ""].filter(Boolean)
        }
      },
      memoryMap: {
        narrative: {
          summary: [snapshot.memory.projectBrief, snapshot.memory.researchGoal].filter(Boolean).join(" "),
          bullets: [
            ...snapshot.memory.constraints.slice(0, 6),
            ...snapshot.memory.activeHypotheses.slice(0, 6)
          ].filter(Boolean)
        },
        knowledge: {
          summary: [
            latestConversationBody ? `Latest chat: ${truncateInline(latestConversationBody, 160)}` : "",
            formatAutomationSessionSummary(snapshot.latestAutomationSession, summaryLanguage) || "",
            formatAutomationCycleSummary(latestCycle, summaryLanguage) || ""
          ]
            .filter(Boolean)
            .join(" | "),
          bullets: [
            snapshot.latestAutomationSession?.currentStepSummary || "",
            ...snapshot.memory.openQuestions.slice(0, 4)
          ].filter(Boolean)
        },
        execution: {
          summary: [
            latestStrategistSummary ? `Strategist: ${truncateInline(latestStrategistSummary, 140)}` : "",
            latestContextRun ? `${latestContextRun.id}: ${truncateInline(latestContextRunSummary, 140)}` : "",
            latestCycle ? `${latestCycle.id}: ${truncateInline(latestCycle.summary, 140)}` : ""
          ]
            .filter(Boolean)
            .join(" | "),
          bullets: [
            latestStrategistReply
              ? `Decision ${snapshot.latestDecision?.id ?? "latest"}: ${truncateInline(latestStrategistReply, 180)}`
              : "",
            latestContextRun
              ? `Run ${latestContextRun.id}: ${truncateInline(latestContextRunSummary, 180)}`
              : "",
            latestOperationalRun?.finalMessage
              ? `Operational issue: ${truncateInline(extractFinalSummary(latestOperationalRun.finalMessage), 180)}`
              : ""
          ].filter(Boolean)
        }
      }
    });

    await this.buildContextBundle(
      workspacePath,
      "Refresh the workspace context bundle after updating the session summary."
    );

    return updatedMemory;
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

  async allocateConversationEntry(workspacePath: string) {
    const id = await this.nextId(this.buildPaths(workspacePath).conversationEntriesDir, "M");

    return {
      id,
      jsonPath: path.join(this.buildPaths(workspacePath).conversationEntriesDir, `${id}.json`)
    };
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

  async allocateAutomationCycle(workspacePath: string) {
    const id = await this.nextId(this.buildPaths(workspacePath).automationCyclesDir, "AY");

    return {
      id,
      jsonPath: path.join(this.buildPaths(workspacePath).automationCyclesDir, `${id}.json`)
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

  async writeDecision(workspacePath: string, decision: DecisionRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).decisionsDir, `${decision.id}.json`);
    await this.writeJson(jsonPath, decision);
  }

  async readDecision(workspacePath: string, decisionId: string) {
    const jsonPath = path.join(this.buildPaths(workspacePath).decisionsDir, `${decisionId}.json`);
    return this.readJson<DecisionRecord>(jsonPath);
  }

  async writeThread(workspacePath: string, thread: ThreadRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).threadsDir, `${thread.id}.json`);
    await this.writeJson(jsonPath, thread);
  }

  async writeAttachment(workspacePath: string, attachment: AttachmentRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).attachmentRecordsDir, `${attachment.id}.json`);
    await this.writeJson(jsonPath, attachment);
  }

  async readAttachment(workspacePath: string, attachmentId: string) {
    const jsonPath = path.join(this.buildPaths(workspacePath).attachmentRecordsDir, `${attachmentId}.json`);
    return await this.readJson<AttachmentRecord>(jsonPath);
  }

  async writeConversationEntry(workspacePath: string, entry: ConversationEntryRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).conversationEntriesDir, `${entry.id}.json`);
    await this.writeJson(jsonPath, entry);
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

  async writeAutomationCycle(workspacePath: string, cycle: AutomationCycleRecord) {
    const jsonPath = path.join(this.buildPaths(workspacePath).automationCyclesDir, `${cycle.id}.json`);
    await this.writeJson(jsonPath, cycle);
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

  async readAutomationCycle(workspacePath: string, cycleId: string) {
    const jsonPath = path.join(this.buildPaths(workspacePath).automationCyclesDir, `${cycleId}.json`);
    const cycle = await this.readJson<AutomationCycleRecord>(jsonPath);
    return cycle ? normalizeAutomationCycleRecord(cycle) : null;
  }

  async listAutomationCycles(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    return (await this.readRecordDirectory<AutomationCycleRecord>(paths.automationCyclesDir)).map(
      normalizeAutomationCycleRecord
    );
  }

  async listAutomationSteps(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    return (await this.readRecordDirectory<AutomationStepRecord>(paths.automationStepsDir)).map(
      normalizeAutomationStepRecord
    );
  }

  async listAutomationCheckpoints(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    return this.readRecordDirectory<AutomationCheckpointRecord>(paths.automationCheckpointsDir);
  }

  async listConversationEntries(workspacePath: string) {
    const paths = this.buildPaths(workspacePath);
    return this.readRecordDirectory<ConversationEntryRecord>(paths.conversationEntriesDir);
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
    const recentConversation = (snapshot.conversationEntries ?? [])
      .slice(-6)
      .map((entry) => {
        const speaker =
          entry.role === "user" ? "User" : entry.role === "assistant" ? "Assistant" : "System";
        return `- ${speaker}: ${truncateInline(entry.body, 220)}`;
      })
      .join("\n") || "- none";
    const contextLanguage = resolveContextLanguage([
      prompt,
      recentConversation,
      snapshot.latestConversationEntry?.body || "",
      snapshot.latestAutomationSession?.displayObjective || "",
      snapshot.latestAutomationSession?.objective || ""
    ]);
    const latestStrategistSummary = snapshot.latestDecision?.summary?.trim() || "";
    const latestStrategistReply = extractVisibleStrategistReply(snapshot.latestDecision?.rawOutput || "", 420);
    const latestContextRun = resolveLatestMeaningfulBuilderRun(snapshot.runs);
    const latestRunChangedFiles = latestContextRun?.changedFiles ?? [];
    const latestRunSummary = latestContextRun?.finalMessage
      ? extractFinalSummary(latestContextRun.finalMessage)
      : "none";
    const latestOperationalRun =
      snapshot.latestRun && snapshot.latestRun.id !== latestContextRun?.id ? snapshot.latestRun : null;
    const latestCycle = snapshot.latestAutomationCycle ?? null;
    const attachmentLines = snapshot.activeThreadAttachments.length
      ? snapshot.activeThreadAttachments
          .slice(0, 8)
          .map((record) => formatRuntimeAttachment(record))
          .join("\n")
      : "- none";
    const automationState = formatAutomationContextState(snapshot.latestAutomationSession, contextLanguage);
    const latestStateLines =
      lane === "strategist"
        ? [
            `Latest builder status: ${latestContextRun?.status || snapshot.latestRun?.status || "none"}`,
            `Latest builder summary: ${truncateInline(latestRunSummary, 220)}`,
            latestRunChangedFiles.length
              ? `Latest changed files: ${latestRunChangedFiles.slice(0, 6).join(", ")}`
              : "Latest changed files: none",
            latestOperationalRun?.finalMessage
              ? `Latest operational issue: ${truncateInline(extractFinalSummary(latestOperationalRun.finalMessage), 220)}`
              : null,
            automationState,
            latestCycle ? `Latest automation cycle: ${truncateInline(latestCycle.summary || latestCycle.id, 220)}` : null
          ].filter((line): line is string => Boolean(line))
        : [
            `Latest strategist summary: ${truncateInline(latestStrategistSummary || "none", 260)}`,
            latestStrategistReply && !isRedundantInlineSummary(latestStrategistReply, latestStrategistSummary)
              ? `Latest strategist reply: ${truncateInline(latestStrategistReply, 420)}`
              : null,
            `Latest strategist rationale: ${truncateInline(snapshot.latestDecision?.rationale || "none", 220)}`,
            `Latest builder status: ${latestContextRun?.status || snapshot.latestRun?.status || "none"}`,
            `Latest builder summary: ${truncateInline(latestRunSummary, 220)}`,
            latestRunChangedFiles.length
              ? `Latest changed files: ${latestRunChangedFiles.slice(0, 6).join(", ")}`
              : "Latest changed files: none",
            latestOperationalRun?.finalMessage
              ? `Latest operational issue: ${truncateInline(extractFinalSummary(latestOperationalRun.finalMessage), 220)}`
              : null,
            automationState,
            latestCycle ? `Latest automation cycle: ${truncateInline(latestCycle.summary || latestCycle.id, 220)}` : null
          ].filter((line): line is string => Boolean(line));
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
      "# Runtime Context",
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
            `Session Summary: ${truncateInline(memory.sessionSummary || "none", 220)}`,
            `Narrative Memory: ${truncateInline(memory.memoryMap.narrative.summary || "none", 220)}`,
            `Knowledge Memory: ${truncateInline(memory.memoryMap.knowledge.summary || "none", 220)}`,
            `Execution Memory: ${truncateInline(memory.memoryMap.execution.summary || "none", 220)}`
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
      "## Recent Conversation",
      recentConversation,
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
      attachmentLines
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
    const latestDecisionSummary = snapshot.latestDecision?.summary?.trim() || "";
    const latestDecisionReply = extractVisibleStrategistReply(snapshot.latestDecision?.rawOutput || "", 500);
    const latestContextRun = resolveLatestMeaningfulBuilderRun(snapshot.runs);
    const latestRunHandoff = deriveRunHandoff(latestContextRun);
    const latestRunChangedFiles = latestContextRun?.changedFiles ?? [];
    const latestCycle = snapshot.latestAutomationCycle ?? null;
    const contextLanguage = resolveContextLanguage([
      prompt,
      snapshot.latestConversationEntry?.body || "",
      snapshot.latestAutomationSession?.displayObjective || "",
      snapshot.latestAutomationSession?.objective || ""
    ]);
    const workingSet = [
      snapshot.latestTask ? `Latest task: ${snapshot.latestTask.title}` : "Latest task: none",
      latestRunChangedFiles.length
        ? `Changed files: ${latestRunChangedFiles.join(", ")}`
        : "Changed files: none",
      formatAutomationWorkingSetLine(snapshot.latestAutomationSession, contextLanguage),
      latestCycle
        ? `Latest automation cycle: ${latestCycle.id} (${latestCycle.phase}) — ${latestCycle.summary || "none"}`
        : "Latest automation cycle: none",
      snapshot.activeThreadAttachments.length
        ? `Attachments: ${snapshot.activeThreadAttachments.map((record) => record.relativePath).join(", ")}`
        : "Attachments: none"
    ].join("\n");

    const sections = [
      {
        title: "# Context Pack",
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
          ? `Name: ${snapshot.project.name}\nWorkspace: ${snapshot.project.workspacePath}`
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
              `Session Summary: ${memory.sessionSummary || "none"}`,
              `Narrative Memory: ${memory.memoryMap.narrative.summary || "none"}`,
              `Knowledge Memory: ${memory.memoryMap.knowledge.summary || "none"}`,
              `Execution Memory: ${memory.memoryMap.execution.summary || "none"}`
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
          ? [
              latestDecisionReply && !isRedundantInlineSummary(latestDecisionReply, latestDecisionSummary)
                ? `Visible Reply: ${latestDecisionReply}`
                : null,
              formatHandoff(latestDecisionHandoff)
            ]
              .filter(Boolean)
              .join("\n")
          : "No strategist handoff yet."
      },
      {
        title: "## Latest Run",
        body: latestRunHandoff
          ? formatHandoff(latestRunHandoff)
          : "No builder handoff yet."
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
    const shouldWriteCanonical = !options.artifactId || options.writeCanonical === true;

    if (shouldWriteCanonical) {
      await writeFile(paths.contextBundle, bundle, "utf8");
    }

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
        automationSessions: [],
        automationCycles: [],
        automationSteps: [],
        automationCheckpoints: [],
        latestAutomationSession: null,
        latestAutomationCycle: null,
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
    const activeThreadAttachments = attachments.filter(
      (record) => record.threadId === activeThreadId && isAttachmentRecordActive(record)
    );
    const conversationEntries = (await this.readRecordDirectory<ConversationEntryRecord>(paths.conversationEntriesDir))
      .filter((record) => record.threadId === activeThreadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const decisions = (await this.readRecordDirectory<DecisionRecord>(paths.decisionsDir))
      .map((record) => normalizeDecisionRecord(record, project.defaultThreadId))
      .filter((record) => record.threadId === activeThreadId);
    const tasks = (await this.readRecordDirectory<TaskRecord>(paths.tasksDir))
      .map((record) => normalizeTaskRecord(record, project.defaultThreadId))
      .filter((record) => record.threadId === activeThreadId);
    const runs = (await this.readRecordDirectory<RunRecord>(paths.runsDir))
      .map((record) => normalizeRunRecord(record, project.defaultThreadId))
      .filter((record) => record.threadId === activeThreadId);
    const routerTraces = (await this.readRecordDirectory<RouterTraceRecord>(paths.routesDir))
      .filter((record) => record.threadId === activeThreadId)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
    const automationSessions = (await this.readRecordDirectory<AutomationSessionRecord>(paths.automationSessionsDir))
      .map(normalizeAutomationSessionRecord)
      .filter((record) => record.threadId === activeThreadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const automationCycles = (await this.readRecordDirectory<AutomationCycleRecord>(paths.automationCyclesDir))
      .filter((record) => record.threadId === activeThreadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const automationSteps = (await this.readRecordDirectory<AutomationStepRecord>(paths.automationStepsDir))
      .map(normalizeAutomationStepRecord)
      .filter((record) => record.threadId === activeThreadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const automationCheckpoints = (
      await this.readRecordDirectory<AutomationCheckpointRecord>(paths.automationCheckpointsDir)
    )
      .filter((record) => record.threadId === activeThreadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const logContent = await this.safeRead(paths.activityLog);

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
      conversationEntries,
      latestConversationEntry: conversationEntries[conversationEntries.length - 1] ?? null,
      attachments,
      activeThreadAttachments,
      decisions,
      tasks,
      runs,
      routerTraces,
      latestDecision: decisions[0] ?? null,
      latestTask: tasks[0] ?? null,
      latestRun: runs[0] ?? null,
      latestRouterTrace: routerTraces[0] ?? null,
      automationSessions,
      automationCycles,
      automationSteps,
      automationCheckpoints,
      latestAutomationSession: automationSessions[0] ?? null,
      latestAutomationCycle: automationCycles[0] ?? null,
      latestAutomationCheckpoint: automationCheckpoints[0] ?? null,
      logs
    };
  }

  async listWorkspaceFiles(workspacePath: string): Promise<WorkspaceFileRecord[]> {
    const output: WorkspaceFileRecord[] = [];
    await walkWorkspaceIndex(workspacePath, (entry) => {
      output.push({
        path: entry.path,
        relativePath: entry.relativePath,
        name: entry.name,
        kind: entry.kind,
        artifactKind: entry.artifactKind
      });
    });

    return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  async computeWorkspaceContextFingerprint(workspacePath: string): Promise<string> {
    const hash = createHash("sha1");
    await walkWorkspaceIndex(
      workspacePath,
      (entry) => {
        hash.update(entry.relativePath);
        hash.update("\0");
        hash.update(entry.kind);
        hash.update("\0");
        hash.update(entry.artifactKind);
        hash.update("\0");
        hash.update(String(entry.stats?.size ?? -1));
        hash.update("\0");
        hash.update(entry.stats?.mtime.toISOString() ?? "");
        hash.update("\n");
      },
      { includeStats: true }
    );
    return hash.digest("hex");
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

    if (kind === "document") {
      return DOCUMENT_ATTACHMENT_EXCERPT;
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

  private async ensureThreadIds(workspacePath: string, defaultThreadId: string) {
    const paths = this.buildPaths(workspacePath);

    await this.ensureThreadIdsInDirectory<DecisionRecord>(paths.decisionsDir, defaultThreadId);
    await this.ensureThreadIdsInDirectory<TaskRecord>(paths.tasksDir, defaultThreadId);
    await this.ensureThreadIdsInDirectory<RunRecord>(paths.runsDir, defaultThreadId);
  }

  private async ensureThreadIdsInDirectory<T extends { id: string; threadId?: string }>(
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
    prefix: "D" | "Q" | "R",
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

    const entries = (await readdir(directory).catch(() => [] as string[]))
      .filter((entry) => entry.endsWith(".json"))
      .sort(compareRecordFiles)
      .reverse();
    const records: T[] = [];

    for (let index = 0; index < entries.length; index += RECORD_READ_BATCH_SIZE) {
      const batch = entries.slice(index, index + RECORD_READ_BATCH_SIZE);
      const batchRecords = await Promise.all(
        batch.map(async (entry) => {
          try {
            const content = await readFile(path.join(directory, entry), "utf8");
            return JSON.parse(content) as T;
          } catch {
            return null;
          }
        })
      );

      for (const record of batchRecords) {
        if (record !== null) {
          records.push(record);
        }
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
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  }

  private async removeFileIfExists(filePath: string) {
    await unlink(filePath).catch(() => undefined);
  }

  private async safeRead(filePath: string) {
    if (!(await this.exists(filePath))) {
      return null;
    }

    return readFile(filePath, "utf8");
  }

  private async exists(targetPath: string) {
    return await pathExists(targetPath);
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
    await writeFile(
      paths.memoryDurableContextFile,
      renderMemoryLayer("Narrative Memory", memory.memoryMap.narrative),
      "utf8"
    );
    await writeFile(
      paths.memoryWorkingContextFile,
      renderMemoryLayer("Knowledge Memory", memory.memoryMap.knowledge),
      "utf8"
    );
    await writeFile(
      paths.memoryEvidenceContextFile,
      renderMemoryLayer("Execution Memory", memory.memoryMap.execution),
      "utf8"
    );
    await this.writeJson(paths.memoryPreferencesFile, memory.preferences);
  }

}

function createDefaultProjectMemory(projectName: string): ProjectMemoryRecord {
  const projectBrief = `${projectName} is the active research workspace.`;
  const researchGoal = DEFAULT_PROJECT_RESEARCH_GOAL;
  const constraints = ["Local-first", "Single-user", "Prototype-first"];
  const openQuestions = ["What is the next concrete experiment or validation step?"];
  const activeHypotheses: string[] = [];
  const sessionSummary = "No session summary yet.";
  const layers = createDefaultProjectMemoryLayers();

  layers.narrative = {
    ...layers.narrative,
    northStar: researchGoal,
    activeStory: projectBrief,
    constraints
  };
  layers.projectModel = {
    ...layers.projectModel,
    openQuestions,
    activeHypotheses
  };
  layers.executionJournal = {
    ...layers.executionJournal,
    sessionSummary
  };

  return {
    projectBrief,
    researchGoal,
    constraints,
    preferences: {
      strategistStyle: "Direct, critical, high-level.",
      builderStyle: "Concrete tasks with minimal narration."
    },
    openQuestions,
    activeHypotheses,
    sessionSummary,
    layers,
    memoryMap: synthesizeProjectMemoryMapFromLayers(layers),
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

function renderMemoryLayer(title: string, layer: ProjectMemoryLayer) {
  return [
    `# ${title}`,
    "",
    layer.summary || "No summary yet.",
    "",
    "## Key Points",
    "",
    ...(layer.bullets.length ? layer.bullets.map((item) => `- ${item}`) : ["- none"]),
    ""
  ].join("\n");
}

function createDefaultProjectMemoryMap(): ProjectMemoryRecord["memoryMap"] {
  return {
    narrative: {
      summary: "No durable context yet.",
      bullets: []
    },
    knowledge: {
      summary: "No knowledge summary yet.",
      bullets: []
    },
    execution: {
      summary: "No execution context yet.",
      bullets: []
    }
  } satisfies ProjectMemoryRecord["memoryMap"];
}

function createDefaultProjectMemoryLayers(): ProjectMemoryRecord["layers"] {
  return {
    narrative: {
      northStar: DEFAULT_PROJECT_RESEARCH_GOAL,
      activeStory: "No active story yet.",
      collaborationContract: [],
      currentFocus: "none",
      recentDirections: [],
      constraints: []
    },
    projectModel: {
      openQuestions: ["What is the next concrete experiment or validation step?"],
      activeHypotheses: [],
      stableFacts: [],
      keyDecisions: [],
      metrics: [],
      learnedPatterns: []
    },
    executionJournal: {
      sessionSummary: "No session summary yet.",
      activeAutomationSummary: "No automation running.",
      recentArtifacts: [],
      recentCommands: [],
      recentLogs: [],
      recoveryNotes: []
    }
  } satisfies ProjectMemoryRecord["layers"];
}

function synthesizeProjectMemoryMapFromLayers(layers: ProjectMemoryRecord["layers"]) {
  return {
    narrative: {
      summary: [layers.narrative.activeStory, layers.narrative.northStar].filter(Boolean).join(" | "),
      bullets: compactList([
        ...layers.narrative.constraints,
        ...layers.narrative.recentDirections,
        ...layers.narrative.collaborationContract
      ]).slice(0, 8)
    },
    knowledge: {
      summary: compactList([
        layers.projectModel.keyDecisions[0] || "",
        layers.projectModel.metrics[0] || "",
        layers.projectModel.learnedPatterns[0] || ""
      ]).join(" | "),
      bullets: compactList([
        ...layers.projectModel.openQuestions,
        ...layers.projectModel.activeHypotheses,
        ...layers.projectModel.stableFacts
      ]).slice(0, 8)
    },
    execution: {
      summary: compactList([
        layers.executionJournal.activeAutomationSummary,
        layers.executionJournal.sessionSummary
      ]).join(" | "),
      bullets: compactList([
        ...layers.executionJournal.recentArtifacts,
        ...layers.executionJournal.recentCommands,
        ...layers.executionJournal.recoveryNotes
      ]).slice(0, 8)
    }
  } satisfies ProjectMemoryRecord["memoryMap"];
}

function mergeProjectMemoryLayer(
  existing: ProjectMemoryLayer,
  patch: Partial<ProjectMemoryLayer> | undefined
): ProjectMemoryLayer {
  return {
    summary: patch?.summary ?? existing.summary,
    bullets: patch?.bullets ?? existing.bullets
  };
}

function mergeProjectMemoryMap(
  existing: ProjectMemoryRecord["memoryMap"] | undefined,
  patch: Partial<ProjectMemoryRecord["memoryMap"]> | undefined,
  layers?: ProjectMemoryRecord["layers"]
) {
  const synthesized = synthesizeProjectMemoryMapFromLayers(layers ?? createDefaultProjectMemoryLayers());
  const base = existing ?? synthesized;

  return {
    narrative: mergeProjectMemoryLayer(base.narrative ?? synthesized.narrative, patch?.narrative),
    knowledge: mergeProjectMemoryLayer(base.knowledge ?? synthesized.knowledge, patch?.knowledge),
    execution: mergeProjectMemoryLayer(base.execution ?? synthesized.execution, patch?.execution)
  } satisfies ProjectMemoryRecord["memoryMap"];
}

function mergeProjectMemoryLayers(
  existing: ProjectMemoryRecord["layers"] | undefined,
  patch: Partial<ProjectMemoryRecord["layers"]> | undefined,
  aliases: {
    projectBrief?: string;
    researchGoal?: string;
    constraints?: string[];
    openQuestions?: string[];
    activeHypotheses?: string[];
    sessionSummary?: string;
  } = {}
) {
  const base = existing ?? createDefaultProjectMemoryLayers();

  return {
    narrative: {
      ...base.narrative,
      ...patch?.narrative,
      northStar: aliases.researchGoal ?? patch?.narrative?.northStar ?? base.narrative.northStar,
      activeStory: aliases.projectBrief ?? patch?.narrative?.activeStory ?? base.narrative.activeStory,
      constraints: aliases.constraints ?? patch?.narrative?.constraints ?? base.narrative.constraints
    },
    projectModel: {
      ...base.projectModel,
      ...patch?.projectModel,
      openQuestions:
        aliases.openQuestions ?? patch?.projectModel?.openQuestions ?? base.projectModel.openQuestions,
      activeHypotheses:
        aliases.activeHypotheses ??
        patch?.projectModel?.activeHypotheses ??
        base.projectModel.activeHypotheses
    },
    executionJournal: {
      ...base.executionJournal,
      ...patch?.executionJournal,
      sessionSummary:
        aliases.sessionSummary ??
        patch?.executionJournal?.sessionSummary ??
        base.executionJournal.sessionSummary
    }
  } satisfies ProjectMemoryRecord["layers"];
}

function normalizeProjectMemoryRecord(
  record: ProjectMemoryRecord,
  projectName: string
): ProjectMemoryRecord {
  const defaults = createDefaultProjectMemory(projectName);
  const layers = mergeProjectMemoryLayers(record.layers, undefined, {
    projectBrief: record.projectBrief,
    researchGoal: record.researchGoal,
    constraints: record.constraints,
    openQuestions: record.openQuestions,
    activeHypotheses: record.activeHypotheses,
    sessionSummary: record.sessionSummary
  });

  return {
    ...defaults,
    ...record,
    projectBrief: record.projectBrief || layers.narrative.activeStory,
    researchGoal: record.researchGoal || layers.narrative.northStar,
    constraints: record.constraints?.length ? record.constraints : layers.narrative.constraints,
    openQuestions: record.openQuestions?.length ? record.openQuestions : layers.projectModel.openQuestions,
    activeHypotheses:
      record.activeHypotheses?.length ? record.activeHypotheses : layers.projectModel.activeHypotheses,
    sessionSummary: record.sessionSummary || layers.executionJournal.sessionSummary,
    layers,
    memoryMap: mergeProjectMemoryMap(record.memoryMap, undefined, layers),
    preferences: {
      ...defaults.preferences,
      ...record.preferences
    },
    updatedAt: record.updatedAt || defaults.updatedAt
  };
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
  const handoff = structured ?? record.handoff;

  return {
    ...record,
    threadId: record.threadId || defaultThreadId,
    summary: handoffMachineSummary(structured) || structured?.summary || record.summary,
    rationale: structured?.rationale ?? record.rationale,
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
    status: record.status === "running" ? "running" : "idle",
    activeLaneStepIds: Array.isArray(record.activeLaneStepIds) ? record.activeLaneStepIds.filter(Boolean) : []
  };
}

function normalizeAutomationCycleRecord(record: AutomationCycleRecord): AutomationCycleRecord {
  return {
    ...record,
    title: record.title || "Automation cycle",
    status: record.status || "running",
    activeLaneStepIds: Array.isArray(record.activeLaneStepIds) ? record.activeLaneStepIds.filter(Boolean) : [],
    completedLaneStepIds: Array.isArray(record.completedLaneStepIds)
      ? record.completedLaneStepIds.filter(Boolean)
      : [],
    laneStates: Array.isArray(record.laneStates) ? record.laneStates : [],
    startedAt: record.startedAt || record.createdAt
  };
}

function normalizeAutomationStepRecord(record: AutomationStepRecord): AutomationStepRecord {
  return {
    ...record,
    workerMode:
      record.workerMode ?? (record.lane === "controller" ? "planner" : record.lane === "builder" ? "async" : "sync"),
    startedSideEffects: Array.isArray(record.startedSideEffects) ? record.startedSideEffects.filter(Boolean) : [],
    completedSideEffects: Array.isArray(record.completedSideEffects)
      ? record.completedSideEffects.filter(Boolean)
      : []
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
      machineSummary: record.summary,
      rationale: record.rationale,
      files: [],
      risks: [],
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
      machineSummary: extractFinalSummary(record.finalMessage || ""),
      result: record.status === "completed" ? "success" : "failed",
      files: record.changedFiles ?? [],
      risks: [],
      runActions: [],
      successCriteria: [],
      openQuestions: []
    }
  );
}

function resolveLatestMeaningfulBuilderRun(runs: RunRecord[]) {
  const latestBuilderRun = runs[0] ?? null;

  return (
    runs.find((run) => {
      const summary =
        handoffMachineSummary(run.handoff) ||
        extractFinalSummary(run.finalMessage || "");

      if (!summary) {
        return false;
      }

      return !isOperationalAutomationMessage(summary);
    }) ?? latestBuilderRun
  );
}

function formatHandoff(handoff: LithiumHandoff) {
  const machineSummary = handoffMachineSummary(handoff);
  const userMessage = handoffUserMessage(handoff);

  return [
    `Role: ${handoff.role}`,
    userMessage ? `User Message: ${userMessage}` : null,
    `Machine Summary: ${machineSummary || handoff.summary}`,
    handoff.rationale ? `Rationale: ${handoff.rationale}` : null,
    handoff.result ? `Result: ${handoff.result}` : null,
    `Files: ${handoff.files.join("; ") || "none"}`,
    `Risks: ${handoff.risks.join("; ") || "none"}`,
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
      'Prefer "machine_summary" for the compact internal handoff and use "user_message" only when a shorter user-facing restatement helps.'
    ].join("\n");
  }

  if (lane === "builder") {
    return [
      "Reply naturally first.",
      "Then append LITHIUM_STATUS with one compact JSON object for the app.",
      'Prefer "machine_summary" for the compact internal handoff and use "user_message" only when a shorter user-facing restatement helps.',
      "Keep result in success, partial, or failed."
    ].join("\n");
  }

  return "";
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

function isAttachmentRecordActive(record: AttachmentRecord) {
  return !record.consumedAt && !record.conversationEntryId && !record.decisionId && !record.runId;
}

function truncateAttachmentExcerpt(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function extractVisibleStrategistReply(rawOutput: string, maxChars: number) {
  const stripped = rawOutput
    .replace(/\n*LITHIUM_HANDOFF[\s\S]*$/m, "")
    .replace(/\n\s*입니다\.\s*(?=\n|$)/g, "")
    .trim();

  if (!stripped || looksLikeStructuredStrategistOnly(stripped)) {
    return "";
  }

  return truncateInline(stripped, maxChars);
}

function looksLikeStructuredStrategistOnly(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return true;
  }

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || trimmed === "LITHIUM_HANDOFF") {
    return true;
  }

  const meaningfulLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return meaningfulLines.every((line) =>
    /^(summary|machine_summary|user_message|next[_ ]task|rationale|files|risks|run_actions|success_criteria|open_questions)\s*:/i.test(
      line
    )
  );
}

function isRedundantInlineSummary(left: string, right: string) {
  const normalizedLeft = left.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedRight = right.replace(/\s+/g, " ").trim().toLowerCase();

  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  );
}

function truncateInline(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function compactList(values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean);
}

function logsToLines(lines: string[] | undefined, maxCount: number) {
  return (lines ?? []).slice(0, maxCount).filter(Boolean);
}

function resolveContextLanguage(samples: string[]) {
  return samples.some(containsHangul) ? "ko" : "en";
}

function containsHangul(value: string) {
  return /[\u3131-\u318E\uAC00-\uD7A3]/.test(value);
}

function formatAutomationContextState(
  session: ProjectSnapshot["latestAutomationSession"],
  language: "ko" | "en"
) {
  if (!session) {
    return language === "ko" ? "자동 연구: 없음" : "Automation: none";
  }

  const summary = humanizeAutomationContextSummary(
    session.currentStepSummary || session.displayObjective || session.objective,
    language
  );
  const status = formatAutomationStatusToken(session.status, language);

  return language === "ko"
    ? `자동 연구: ${status} — ${truncateInline(summary, 220)}`
    : `Automation: ${status} — ${truncateInline(summary, 220)}`;
}

function formatAutomationWorkingSetLine(
  session: ProjectSnapshot["latestAutomationSession"],
  language: "ko" | "en"
) {
  if (!session) {
    return language === "ko" ? "자동 연구 상태: 없음" : "Automation status: none";
  }

  const status = formatAutomationStatusToken(session.status, language);
  return language === "ko" ? `자동 연구 상태: ${status}` : `Automation status: ${status}`;
}

function formatAutomationSessionSummary(
  session: ProjectSnapshot["latestAutomationSession"],
  language: "ko" | "en"
) {
  if (!session) {
    return null;
  }

  const status = formatAutomationStatusToken(session.status, language);
  const summary = humanizeAutomationContextSummary(
    session.currentStepSummary || session.displayObjective || session.objective,
    language
  );

  return language === "ko"
    ? `최신 자동 연구 상태: ${status} — ${truncateInline(summary, 220)}`
    : `Latest automation status: ${status} — ${truncateInline(summary, 220)}`;
}

function formatAutomationCycleSummary(
  cycle: ProjectSnapshot["latestAutomationCycle"],
  language: "ko" | "en"
) {
  if (!cycle) {
    return null;
  }

  const summary = truncateInline(cycle.summary || "none", 220);

  return language === "ko"
    ? `최신 자동 연구 cycle: ${cycle.id} (${cycle.phase}) — ${summary}`
    : `Latest automation cycle: ${cycle.id} (${cycle.phase}) — ${summary}`;
}

function formatAutomationStatusToken(status: string, language: "ko" | "en") {
  if (language !== "ko") {
    return status;
  }

  if (status === "running") {
    return "진행 중";
  }

  if (status === "idle") {
    return "대기";
  }

  if (status === "completed") {
    return "완료";
  }

  return status;
}

function humanizeAutomationContextSummary(value: string, language: "ko" | "en") {
  const trimmed = value.trim();

  if (!trimmed) {
    return language === "ko" ? "아직 요약이 없습니다." : "No summary yet.";
  }

  if (language !== "ko") {
    return trimmed;
  }

  if (/plan the next bounded research step/i.test(trimmed)) {
    return "다음 연구 단계를 작게 쪼개서 정리하고 있습니다.";
  }

  if (/automation started\. planning the next bounded step/i.test(trimmed)) {
    return "자동 연구를 시작했고 바로 다음 단계를 정리하고 있습니다.";
  }

  if (/continuing the current step\. the latest instruction will be applied next/i.test(trimmed)) {
    return "현재 단계는 마저 끝내고, 방금 보낸 지시는 다음 단계부터 반영합니다.";
  }

  if (/automation resumed/i.test(trimmed)) {
    return "이전 상태에서 자동 연구를 다시 이어가고 있습니다.";
  }

  if (/automation was interrupted when lithium restarted/i.test(trimmed)) {
    return "앱 재시작 이후 자동 연구를 복구할 준비를 하고 있습니다.";
  }

  return trimmed;
}

function classifyAttachmentKind(filePath: string): AttachmentKind {
  const extension = path.extname(filePath).toLowerCase();

  if ([".json"].includes(extension)) {
    return "json";
  }

  if ([".csv", ".tsv"].includes(extension)) {
    return "csv";
  }

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return "document";
  }

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(extension)) {
    return "image";
  }

  if (
    [
      ".txt",
      ".md",
      ".py",
      ".sh",
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".mjs",
      ".cjs",
      ".css",
      ".html",
      ".xml",
      ".toml",
      ".rs",
      ".go",
      ".java",
      ".c",
      ".cc",
      ".cpp",
      ".h",
      ".hpp",
      ".yaml",
      ".yml"
    ].includes(extension)
  ) {
    return "text";
  }

  return "other";
}
