import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, CommandSpec, RemoteWorkspaceProfile } from "../shared/types";
import { AppService } from "../main/services/app-service";
import type {
  RemoteWorkspaceCommandResult,
  RemoteWorkspaceMetadata,
  RemoteWorkspaceServiceLike
} from "../main/services/remote-workspace-service";
import { createInProcessLithiumApi } from "./in-process-lithium-api";
import { LithiumAppDriver } from "./lithium-app-driver";

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupTempDirs(tempDirs.splice(0));
});

describe("LithiumAppDriver", () => {
  it("drives a mixed strategist -> builder -> manuscript flow over the app API contract", async () => {
    const workspace = await createWorkspace();
    const routerRunner = {
      route: vi.fn(async () => ({
        decision: {
          route: "mixed" as const,
          rewrittenPrompt: "Decide the best results rewrite, then apply it.",
          reasonShort: "The request needs planning plus execution."
        },
        command: { command: "codex", args: ["exec"], cwd: workspace },
        startedAt: "2026-03-20T01:00:00.000Z",
        endedAt: "2026-03-20T01:00:01.000Z",
        exitCode: 0,
        timedOut: false,
        rawOutput: "LITHIUM_ROUTE\n{\"route\":\"mixed\"}"
      }))
    };
    const oracleRunner = {
      consult: vi.fn(async () => ({
        command: { command: "npx", args: ["oracle"], cwd: workspace },
        startedAt: "2026-03-20T01:00:02.000Z",
        endedAt: "2026-03-20T01:00:05.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        outputText: [
          "LITHIUM_HANDOFF",
          JSON.stringify({
            summary: "Planned the results rewrite from the latest evidence.",
            next_task: "Update paper/main.tex with the selected results rewrite.",
            rationale: "Mixed mode should hand off directly to the builder.",
            files: ["paper/main.tex"],
            risks: ["The paper text may drift from the latest run summary."],
            paper_actions: ["Revise the results paragraph."],
            run_actions: [],
            success_criteria: ["The manuscript reflects the new summary."],
            open_questions: []
          })
        ].join("\n")
      }))
    };
    const codexRunner = {
      runTask: vi.fn(async () => {
        throw new Error("runTask should not be called in this scenario.");
      }),
      buildTaskCommand: vi.fn((cwd: string, prompt: string, outputPath: string) =>
        buildImmediateBuilderCommand(cwd, prompt, outputPath)
      )
    };
    const app = new AppService(workspace, {
      routerRunner,
      oracleRunner,
      codexRunner
    });
    const driver = new LithiumAppDriver(
      createInProcessLithiumApi({
        appService: app,
        settings: createDefaultSettings()
      })
    );

    await driver.initProject(workspace);
    const routedSnapshot = await driver.sendChat("Figure out the right results rewrite and then apply it.");

    expect(routedSnapshot.latestDecision?.summary).toBe("Planned the results rewrite from the latest evidence.");
    expect(routedSnapshot.latestRun?.status).toBe("running");
    expect(routedSnapshot.latestRouterTrace?.finalRoute).toBe("mixed");

    const finalizedSnapshot = await driver.completeLatestBuilderRun();

    expect(finalizedSnapshot.latestRun?.status).toBe("completed");
    expect(finalizedSnapshot.latestRun?.handoff?.summary).toBe("builder applied the planned manuscript rewrite");
    expect(finalizedSnapshot.latestRun?.changedFiles).toContain("paper/main.tex");

    const paperSnapshot = await driver.updateManuscript();
    const manuscript = await driver.readTextFile(".lithium/manuscript/sections/results.md");

    expect(paperSnapshot.manuscript?.content).toContain("Planned the results rewrite from the latest evidence.");
    expect(manuscript.content).toContain("builder applied the planned manuscript rewrite");
  });

  it("switches threads, preserves thread-local memory, and rebuilds context after attachment actions", async () => {
    const workspace = await createWorkspace();
    const attachmentSourceDir = await createTempDir("lithium-driver-attachments-");
    const attachmentPath = path.join(attachmentSourceDir, "baseline-notes.md");
    const app = new AppService(workspace);
    const driver = new LithiumAppDriver(
      createInProcessLithiumApi({
        appService: app,
        settings: createDefaultSettings()
      })
    );

    await writeFile(
      attachmentPath,
      "Keep the baseline notes attached to the alpha thread only.\n",
      "utf8"
    );

    const alphaSnapshot = await driver.initProject(workspace);
    const alphaThreadId = alphaSnapshot.activeThreadId;

    expect(alphaThreadId).toBeTruthy();

    await driver.updateProjectMemory({
      projectBrief: "Shared research brief."
    });
    await driver.updateThreadMemory(
      "Alpha thread tracks the baseline experiment assumptions.",
      alphaThreadId ?? undefined
    );

    const betaSnapshot = await driver.createThread("Beta lane");
    await driver.updateThreadMemory("Beta lane tracks literature follow-up only.");
    expect(betaSnapshot.activeThread?.title).toBe("Beta lane");

    await driver.selectThread(alphaThreadId!);
    const importedSnapshot = await driver.importAttachments([attachmentPath]);
    const contextBeforeRemoval = await driver.readTextFile(".lithium/context/current-context.md");

    expect(importedSnapshot.activeThreadAttachments).toHaveLength(1);
    expect(contextBeforeRemoval.content).toContain("Project Brief: Shared research brief.");
    expect(contextBeforeRemoval.content).toContain(
      "Manual memory: Alpha thread tracks the baseline experiment assumptions."
    );
    expect(contextBeforeRemoval.content).toContain("baseline-notes.md");
    expect(contextBeforeRemoval.content).not.toContain("Beta lane tracks literature follow-up only.");

    await driver.removeAttachment(importedSnapshot.activeThreadAttachments[0].id);
    const contextAfterRemoval = await driver.readTextFile(".lithium/context/current-context.md");

    expect(contextAfterRemoval.content).not.toContain("baseline-notes.md");
  });

  it("covers remote-style compile and terminal interaction through the same driver", async () => {
    const workspace = await createWorkspace();
    const remoteWorkspace = createRemoteWorkspaceServiceMock(workspace, {
      buildTerminalBootstrapCommand: vi.fn(async () => "printf 'remote-attached\\n'"),
      pullWorkspaceFiles: vi.fn(async (_workspacePath, relativePaths) => {
        await writeFile(path.join(workspace, "paper", "main.pdf"), "pdf", "utf8");
        return relativePaths;
      })
    });
    const app = new AppService(workspace, {
      remoteWorkspaceService: remoteWorkspace.service
    });
    const driver = new LithiumAppDriver(
      createInProcessLithiumApi({
        appService: app,
        settings: createDefaultSettings()
      })
    );

    await driver.openWorkspace(workspace);
    await driver.saveFile(
      "paper/main.tex",
      "\\documentclass{article}\n\\begin{document}\nRemote compile test\n\\end{document}\n"
    );

    const compiledSnapshot = await driver.compilePaper();
    const compiledPdf = await readFile(path.join(workspace, "paper", "main.pdf"), "utf8");
    const terminalSession = await driver.createTerminalSession({
      forceNew: true
    });
    const observedTerminal = await driver.waitForTerminalOutput(terminalSession.id, "remote-attached");

    expect(compiledSnapshot.project?.workspacePath).toBe(workspace);
    expect(compiledPdf).toBe("pdf");
    expect(remoteWorkspace.service.runWorkspaceCommand).toHaveBeenCalledWith(
      workspace,
      expect.objectContaining({
        command: "tectonic"
      }),
      expect.objectContaining({
        stdoutPath: expect.stringContaining(".stdout.log"),
        stderrPath: expect.stringContaining(".stderr.log")
      })
    );
    expect(observedTerminal.output).toContain("remote-attached");

    await driver.closeTerminalSession(terminalSession.id);
    await driver.refresh();

    expect(driver.appState?.selectedWorkspaceKind).toBe("ssh");
    expect(driver.appState?.selectedWorkspaceLabel).toContain("GPU Box");
  });
});

async function createWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lithium-driver-"));
  tempDirs.push(workspace);
  return workspace;
}

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

function createDefaultSettings(): AppSettings {
  return {
    themePreference: "system",
    autopilotPromptLanguage: "auto",
    onboardingDismissed: false,
    strategistSessionReady: false,
    lastWorkspacePath: "",
    sidebarWidth: 220,
    codeCanvasWidth: 540,
    paperPreviewWidth: 780,
    strategistModel: "gpt-5.4",
    strategistReasoningIntensity: "heavy",
    builderModel: "gpt-5.4",
    builderReasoningEffort: "xhigh",
    discordBot: {
      enabled: false,
      token: "",
      workspacePath: "",
      allowedUserIds: [],
      allowedChannelIds: []
    },
    terminalConnectionProfiles: [],
    remoteWorkspaceProfiles: []
  };
}

function createRemoteWorkspaceServiceMock(
  workspacePath: string,
  overrides: Partial<RemoteWorkspaceServiceLike> = {}
) {
  const profile: RemoteWorkspaceProfile = {
    id: "gpu-box",
    name: "GPU Box",
    kind: "ssh",
    host: "gpu.example.org",
    username: "researcher",
    remotePath: "/workspace/project"
  };
  const metadata: RemoteWorkspaceMetadata = {
    version: 1,
    mirrorPath: workspacePath,
    label: "GPU Box (researcher@gpu.example.org:/workspace/project)",
    kind: "ssh",
    remoteHost: "researcher@gpu.example.org",
    remotePath: "/workspace/project",
    profile
  };

  const service = {
    connect: vi.fn(async () => ({
      workspacePath,
      metadata
    })),
    describe: vi.fn(async (candidatePath: string) => (candidatePath === workspacePath ? metadata : null)),
    syncWorkspace: vi.fn(async () => ({
      workspacePath,
      metadata
    })),
    pushWorkspaceFile: vi.fn(async () => undefined),
    pushWorkspaceFiles: vi.fn(async (_candidatePath: string, relativePaths: string[]) => relativePaths),
    pullWorkspaceFiles: vi.fn(async (_candidatePath: string, relativePaths: string[]) => relativePaths),
    buildTerminalBootstrapCommand: vi.fn(async () => null),
    runWorkspaceCommand: vi.fn(
      async (
        _candidatePath: string,
        spec: CommandSpec
      ): Promise<RemoteWorkspaceCommandResult> => ({
        command: spec,
        startedAt: "2026-03-20T00:00:00.000Z",
        endedAt: "2026-03-20T00:00:01.000Z",
        exitCode: 0,
        timedOut: false,
        stdout: "remote compile complete\n",
        stderr: ""
      })
    ),
    ...overrides
  } satisfies RemoteWorkspaceServiceLike;

  return {
    metadata,
    profile,
    service
  };
}

function buildImmediateBuilderCommand(cwd: string, prompt: string, outputPath: string) {
  return {
    command: "node",
    args: [
      "-e",
      [
        "const fs = require('node:fs');",
        "const outputPath = process.argv[1];",
        "const prompt = process.argv[2];",
        "fs.writeFileSync(outputPath, [",
        "  `Completed builder task for: ${prompt}`,",
        "  '',",
        "  'LITHIUM_STATUS',",
        "  'SUMMARY: builder applied the planned manuscript rewrite',",
        "  'FILES: paper/main.tex',",
        "  'RESULT: success'",
        "].join('\\n'));"
      ].join(" "),
      outputPath,
      prompt
    ],
    cwd
  };
}
