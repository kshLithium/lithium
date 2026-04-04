import { appendFile, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import process from "node:process";
import type {
  BranchRecord,
  DaemonStatus,
  ObjectiveCreateInput,
  RpcRequest,
  RpcResponse,
  RunRecord,
  SourceAddInput,
  TaskRecord
} from "../../shared/types";
import { buildProjectPaths } from "../services/workspace-layout";
import { Dispatcher } from "./dispatcher";
import { PolicyEngine } from "./policy-engine";
import { RunManager } from "./run-manager";
import { ResearchStore } from "./store";
import { coerceErrorMessage, nowIso } from "./utils";

export class WorkspaceDaemon {
  private server: net.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tickInFlight = false;

  constructor(
    private readonly workspacePath: string,
    private readonly deps: {
      store: ResearchStore;
      runManager: RunManager;
      policy: PolicyEngine;
      dispatcher: Dispatcher;
    }
  ) {}

  async start() {
    if (this.running) {
      return;
    }
    await this.deps.store.initializeWorkspace(this.workspacePath);
    await this.recoverRunningTasks();
    await this.startServer();
    await this.writePidFile();
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.log(`tick error: ${coerceErrorMessage(error)}`));
    }, 500);
    this.timer.unref?.();
    await this.log(`daemon started for ${this.workspacePath}`);
  }

  async stop() {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const projection = this.deps.store.getProjection(this.workspacePath);
    for (const run of projection.runs.filter((entry) => entry.status === "active")) {
      this.deps.dispatcher.terminateRun(run.id);
    }
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      if (!this.server) {
        resolve();
      }
    });
    this.server = null;
    const paths = buildProjectPaths(this.workspacePath);
    await rm(paths.pidFile, { force: true });
    await unlink(paths.socketPath).catch(() => undefined);
    await this.log(`daemon stopped for ${this.workspacePath}`);
  }

  async status(): Promise<DaemonStatus> {
    const paths = buildProjectPaths(this.workspacePath);
    return {
      running: this.running,
      pid: process.pid,
      socketPath: paths.socketPath,
      workspacePath: this.workspacePath
    };
  }

  async handleRpc(request: RpcRequest): Promise<RpcResponse> {
    try {
      const result = await this.dispatchRpc(request.method, request.params ?? {});
      return {
        id: request.id,
        ok: true,
        result
      };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: coerceErrorMessage(error)
      };
    }
  }

  async tick() {
    if (!this.running || this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;
    try {
      const projection = this.deps.store.getProjection(this.workspacePath);
      for (const run of projection.runs.filter((entry) => entry.status === "active")) {
        await this.tickRun(run);
      }
      for (const completion of this.deps.dispatcher.drainCompletions()) {
        const freshRun = this.deps.store.readProjection(this.workspacePath, "run", completion.handle.run.id);
        const freshTask = this.deps.store.readProjection(this.workspacePath, "task", completion.handle.task.id);
        const freshWorkerRun = this.deps.store.readProjection(this.workspacePath, "worker_run", completion.handle.workerRun.id);
        if (freshRun && freshTask && freshWorkerRun) {
          await this.deps.runManager.handleTaskOutcome({
            workspacePath: this.workspacePath,
            task: freshTask,
            run: freshRun,
            workerRun: freshWorkerRun,
            lease: completion.handle.lease,
            outcome: completion.outcome
          });
        }
        this.deps.dispatcher.completeTask(completion.handle.task.id);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async tickRun(run: RunRecord) {
    if (run.startedAt) {
      const elapsed = Date.now() - new Date(run.startedAt).getTime();
      if (elapsed >= run.budget.wallClockMs) {
        this.deps.store.upsertProjection(this.workspacePath, "run", {
          ...run,
          status: "paused",
          stopReason: "Run reached the wall clock budget.",
          updatedAt: nowIso()
        });
        return;
      }
    }

    const projection = this.deps.store.getProjection(this.workspacePath);
    const objective = projection.objectives.find((entry) => entry.id === run.objectiveId);
    if (!objective) {
      return;
    }
    this.deps.runManager.enqueuePlanIfNeeded(this.workspacePath, run.id, objective.id);
    const refreshed = this.deps.store.getProjection(this.workspacePath);
    const tasks = refreshed.tasks.filter((entry) => entry.runId === run.id);
    const branches = refreshed.branches.filter((entry) => entry.objectiveId === objective.id);
    const activeTasks = this.deps.dispatcher.listActive(run.id).map((entry) => entry.task);
    const runnable = this.deps.policy.selectRunnableTasks({
      run,
      tasks,
      branches,
      activeTasks
    });

    for (const task of runnable) {
      const latestRun = this.deps.store.readProjection(this.workspacePath, "run", run.id);
      if (!latestRun || latestRun.status !== "active") {
        return;
      }
      const latestObjective = this.deps.store.readProjection(this.workspacePath, "objective", objective.id);
      const branch = this.deps.store.readProjection(this.workspacePath, "branch", task.branchId);
      if (!latestObjective) {
        return;
      }
      try {
        const handle = await this.deps.dispatcher.start({
          workspacePath: this.workspacePath,
          objective: latestObjective,
          branch,
          run: latestRun,
          task
        });
        const marked = this.deps.runManager.markTaskRunning({
          workspacePath: this.workspacePath,
          run: latestRun,
          task,
          workerRun: handle.workerRun,
          lease: handle.lease
        });
        this.deps.dispatcher.patchActive(task.id, {
          task: marked.task,
          run: marked.run,
          branch,
          workerRun: handle.workerRun,
          lease: handle.lease
        });
      } catch (error) {
        await this.deps.runManager.recoverTask(this.workspacePath, task, latestRun, coerceErrorMessage(error));
      }
    }
  }

  private async recoverRunningTasks() {
    const projection = this.deps.store.getProjection(this.workspacePath);
    for (const task of projection.tasks.filter((entry) => entry.status === "running")) {
      const run = projection.runs.find((entry) => entry.id === task.runId);
      const objective = projection.objectives.find((entry) => entry.id === task.objectiveId);
      const branch = projection.branches.find((entry) => entry.id === task.branchId) ?? null;
      const workerRun = task.workerRunId
        ? projection.workerRuns.find((entry) => entry.id === task.workerRunId) ?? null
        : null;
      const lease = projection.leases.find((entry) => entry.taskId === task.id) ?? null;

      if (!run || !objective || !workerRun) {
        continue;
      }

      const recovered = await this.deps.dispatcher.recover({
        workspacePath: this.workspacePath,
        objective,
        branch,
        run,
        task,
        workerRun,
        lease
      });
      if (!recovered) {
        await this.deps.runManager.recoverTask(
          this.workspacePath,
          task,
          run,
          "The daemon restarted and could not reattach to the prior worker process."
        );
      }
    }
  }

  private async startServer() {
    const paths = buildProjectPaths(this.workspacePath);
    await unlink(paths.socketPath).catch(() => undefined);
    await mkdir(paths.runtimeDir, { recursive: true });
    this.server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes("\n")) {
          return;
        }
        const line = buffer.slice(0, buffer.indexOf("\n"));
        buffer = "";
        void this.reply(socket, line);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(paths.socketPath, resolve);
    });
  }

  private async reply(socket: net.Socket, line: string) {
    try {
      const request = JSON.parse(line) as RpcRequest;
      const response = await this.handleRpc(request);
      socket.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      socket.write(
        `${JSON.stringify({
          id: "unknown",
          ok: false,
          error: coerceErrorMessage(error)
        })}\n`
      );
    } finally {
      socket.end();
    }
  }

  private async dispatchRpc(method: RpcRequest["method"], params: Record<string, unknown>) {
    switch (method) {
      case "daemon.status":
        return await this.status();
      case "daemon.stop":
        setTimeout(() => {
          void this.stop();
        }, 10);
        return {
          stopping: true
        };
      case "status.snapshot":
        return this.deps.runManager.getStatusSnapshot(this.workspacePath, {
          running: this.running,
          pid: process.pid,
          socketPath: buildProjectPaths(this.workspacePath).socketPath
        });
      case "objective.create":
        return this.deps.runManager.createObjective(this.workspacePath, params as unknown as ObjectiveCreateInput);
      case "objective.list":
        return this.deps.runManager.listObjectives(this.workspacePath);
      case "objective.show":
        return this.deps.runManager.showObjective(this.workspacePath, readOptionalString(params.objectiveId));
      case "run.start":
        return this.deps.runManager.startRun(this.workspacePath, readOptionalString(params.objectiveId));
      case "run.pause":
        return this.deps.runManager.pauseRun(this.workspacePath, readOptionalString(params.objectiveId));
      case "run.resume":
        return this.deps.runManager.resumeRun(this.workspacePath, readOptionalString(params.objectiveId));
      case "run.stop":
        this.deps.dispatcher.terminateRun(readOptionalString(params.runId) ?? "");
        return this.deps.runManager.stopRun(this.workspacePath, readOptionalString(params.objectiveId));
      case "source.add":
        return await this.deps.runManager.addSources(this.workspacePath, params as unknown as SourceAddInput);
    }
  }

  private async writePidFile() {
    const paths = buildProjectPaths(this.workspacePath);
    await writeFile(paths.pidFile, String(process.pid), "utf8");
  }

  private async log(message: string) {
    const paths = buildProjectPaths(this.workspacePath);
    await appendFile(paths.daemonLogFile, `[${nowIso()}] ${message}\n`, "utf8").catch(() => undefined);
  }
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
