import type {
  BuilderRunInspection,
  BuilderRequest,
  LithiumApi,
  ProjectMemoryUpdate,
  ProjectSnapshot,
  TerminalSessionCreateRequest,
  TerminalSessionState,
  ThreadCreateRequest,
  ThreadSelectionRequest,
  WorkspaceFileContent,
  WorkspaceFileRecord
} from "../shared/types";

type WaitOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export class LithiumAppDriver {
  private workspacePath = "";
  appState = null as Awaited<ReturnType<LithiumApi["getAppState"]>> | null;
  snapshot = createEmptySnapshot();

  constructor(private readonly api: LithiumApi) {}

  async boot(workspacePath?: string) {
    if (workspacePath?.trim()) {
      await this.openWorkspace(workspacePath);
      return this.snapshot;
    }

    return await this.refresh();
  }

  async refresh() {
    this.appState = await this.api.getAppState();
    this.workspacePath = this.appState.selectedWorkspacePath.trim();
    this.snapshot = this.workspacePath ? await this.api.getProjectSnapshot(this.workspacePath) : createEmptySnapshot();
    return this.snapshot;
  }

  async openWorkspace(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.snapshot = await this.api.getProjectSnapshot(workspacePath);
    this.appState = await this.api.getAppState();
    return this.snapshot;
  }

  async initProject(workspacePath?: string) {
    const resolvedWorkspacePath = this.requireWorkspacePath(workspacePath);
    const snapshot = await this.api.initProject(resolvedWorkspacePath);
    return await this.syncSnapshot(snapshot, resolvedWorkspacePath);
  }

  async listWorkspaceFiles() {
    return await this.api.listWorkspaceFiles(this.requireWorkspacePath());
  }

  async createThread(title?: string) {
    const snapshot = await this.api.createThread({
      workspacePath: this.requireWorkspacePath(),
      title
    } satisfies ThreadCreateRequest);
    return await this.syncSnapshot(snapshot);
  }

  async selectThread(threadId: string) {
    const snapshot = await this.api.selectThread({
      workspacePath: this.requireWorkspacePath(),
      threadId
    } satisfies ThreadSelectionRequest);
    return await this.syncSnapshot(snapshot);
  }

  async updateProjectMemory(update: ProjectMemoryUpdate) {
    const snapshot = await this.api.updateProjectMemory({
      workspacePath: this.requireWorkspacePath(),
      ...update
    });
    return await this.syncSnapshot(snapshot);
  }

  async updateThreadMemory(memory: string, threadId?: string) {
    const snapshot = await this.api.updateThreadMemory({
      workspacePath: this.requireWorkspacePath(),
      threadId,
      memory
    });
    return await this.syncSnapshot(snapshot);
  }

  async importAttachments(filePaths: string[], threadId?: string) {
    const snapshot = await this.api.importAttachments({
      workspacePath: this.requireWorkspacePath(),
      threadId,
      filePaths
    });
    return await this.syncSnapshot(snapshot);
  }

  async removeAttachment(attachmentId: string) {
    const snapshot = await this.api.removeAttachment({
      workspacePath: this.requireWorkspacePath(),
      attachmentId
    });
    return await this.syncSnapshot(snapshot);
  }

  async sendChat(prompt: string) {
    const snapshot = await this.api.sendChatMessage({
      workspacePath: this.requireWorkspacePath(),
      prompt
    });
    return await this.syncSnapshot(snapshot);
  }

  async consultStrategist(prompt: string) {
    const snapshot = await this.api.consultStrategist({
      workspacePath: this.requireWorkspacePath(),
      prompt
    });
    return await this.syncSnapshot(snapshot);
  }

  async startBuilder(prompt: string, overrides: Partial<BuilderRequest> = {}) {
    const snapshot = await this.api.startBuilderTask({
      workspacePath: this.requireWorkspacePath(),
      prompt,
      ...overrides
    });
    return await this.syncSnapshot(snapshot);
  }

  async runBuilder(prompt: string, overrides: Partial<BuilderRequest> = {}) {
    const snapshot = await this.api.runBuilderTask({
      workspacePath: this.requireWorkspacePath(),
      prompt,
      ...overrides
    });
    return await this.syncSnapshot(snapshot);
  }

  async inspectLatestRun() {
    const runId = this.snapshot.latestRun?.id;

    if (!runId) {
      return null;
    }

    return await this.api.inspectBuilderRun({
      workspacePath: this.requireWorkspacePath(),
      runId
    });
  }

  async waitForLatestRunToSettle(options: WaitOptions = {}) {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const inspection = await this.inspectLatestRun();

      if (!inspection) {
        throw new Error("No builder run is available.");
      }

      if (inspection.suggestedStatus !== "running") {
        return inspection;
      }

      await delay(pollIntervalMs);
    }

    throw new Error("Timed out while waiting for the latest builder run to settle.");
  }

  async completeLatestBuilderRun(options: WaitOptions = {}) {
    const inspection = await this.waitForLatestRunToSettle(options);
    const runId = inspection.run?.id ?? this.snapshot.latestRun?.id;

    if (!runId) {
      throw new Error("No builder run is available.");
    }

    if (inspection.run && inspection.run.finalization !== null && inspection.run.status !== "running") {
      return await this.refresh();
    }

    const snapshot = await this.api.finalizeBuilderRun({
      workspacePath: this.requireWorkspacePath(),
      runId
    });
    return await this.syncSnapshot(snapshot);
  }

  async saveFile(path: string, content: string) {
    const file = await this.api.saveWorkspaceFile({
      workspacePath: this.requireWorkspacePath(),
      path,
      content
    });
    await this.refresh();
    return file;
  }

  async readTextFile(path: string) {
    return await this.api.readWorkspaceFile({
      workspacePath: this.requireWorkspacePath(),
      path
    });
  }

  async updateManuscript() {
    const snapshot = await this.api.updateManuscript(this.requireWorkspacePath());
    return await this.syncSnapshot(snapshot);
  }

  async compilePaper() {
    const snapshot = await this.api.compilePaper(this.requireWorkspacePath());
    return await this.syncSnapshot(snapshot);
  }

  async createTerminalSession(request: Omit<TerminalSessionCreateRequest, "workspacePath"> = {}) {
    return await this.api.createTerminalSession({
      workspacePath: this.requireWorkspacePath(),
      ...request
    });
  }

  async waitForTerminalOutput(
    sessionId: string,
    matcher: string | RegExp,
    options: WaitOptions = {}
  ): Promise<TerminalSessionState> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const session = await this.api.getTerminalSession({
        workspacePath: this.requireWorkspacePath(),
        sessionId
      });

      if (session && matchesOutput(session.output, matcher)) {
        return session;
      }

      await delay(pollIntervalMs);
    }

    throw new Error(`Timed out while waiting for terminal output: ${String(matcher)}`);
  }

  async closeTerminalSession(sessionId: string) {
    return await this.api.closeTerminalSession({
      workspacePath: this.requireWorkspacePath(),
      sessionId
    });
  }

  async refreshFileList(): Promise<WorkspaceFileRecord[]> {
    return await this.api.listWorkspaceFiles(this.requireWorkspacePath());
  }

  get latestRun() {
    return this.snapshot.latestRun;
  }

  get latestDecision() {
    return this.snapshot.latestDecision;
  }

  get activeThread() {
    return this.snapshot.activeThread;
  }

  private async syncSnapshot(snapshot: ProjectSnapshot, workspacePath = this.workspacePath) {
    this.workspacePath = workspacePath;
    this.snapshot = snapshot;
    this.appState = await this.api.getAppState();
    return snapshot;
  }

  private requireWorkspacePath(workspacePath?: string) {
    const resolved =
      workspacePath?.trim() || this.workspacePath.trim() || this.appState?.selectedWorkspacePath.trim() || "";

    if (!resolved) {
      throw new Error("No workspace is selected.");
    }

    return resolved;
  }
}

function createEmptySnapshot(): ProjectSnapshot {
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
    logs: []
  };
}

function matchesOutput(output: string, matcher: string | RegExp) {
  return typeof matcher === "string" ? output.includes(matcher) : matcher.test(output);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
