import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { Client, type FileEntry, type SFTPWrapper, type Stats } from "ssh2";
import type { ConnectConfig } from "ssh2";
import type { CommandSpec, RemoteWorkspaceProfile, WorkspaceTransportKind } from "../../shared/types";
import { sanitizeRemoteWorkspaceProfiles } from "./app-settings-store";
import { runCommand, type CommandResult } from "./process-runner";

const REMOTE_METADATA_DIR = ".lithium";
const REMOTE_METADATA_FILE = "remote-workspace.json";
const MAX_SYNCED_FILE_BYTES = 32 * 1024 * 1024;
const REMOTE_DIRECTORY_IGNORES = new Set([
  ".git",
  ".lithium",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  "dist",
  "dist-electron"
]);

export type RemoteWorkspaceMetadata = {
  version: 1;
  mirrorPath: string;
  label: string;
  kind: Exclude<WorkspaceTransportKind, "local">;
  remoteHost: string;
  remotePath: string;
  profile: RemoteWorkspaceProfile;
};

export type RemoteWorkspaceConnection = {
  workspacePath: string;
  metadata: RemoteWorkspaceMetadata;
};

export type RemoteWorkspaceCommandResult = CommandResult & {
  command: CommandSpec;
};

export interface RemoteWorkspaceServiceLike {
  connect(profile: RemoteWorkspaceProfile): Promise<RemoteWorkspaceConnection>;
  describe(workspacePath: string): Promise<RemoteWorkspaceMetadata | null>;
  syncWorkspace(workspacePath: string): Promise<RemoteWorkspaceConnection>;
  pushWorkspaceFile(workspacePath: string, relativePath: string): Promise<void>;
  pushWorkspaceFiles(workspacePath: string, relativePaths: string[]): Promise<string[]>;
  pullWorkspaceFiles(workspacePath: string, relativePaths: string[]): Promise<string[]>;
  buildTerminalBootstrapCommand(workspacePath: string): Promise<string | null>;
  runWorkspaceCommand(
    workspacePath: string,
    spec: CommandSpec,
    options: {
      stdoutPath: string;
      stderrPath: string;
      timeoutMs?: number | null;
    }
  ): Promise<RemoteWorkspaceCommandResult>;
}

export class RemoteWorkspaceService implements RemoteWorkspaceServiceLike {
  constructor(private readonly remoteWorkspaceRoot: string) {}

  async connect(profile: RemoteWorkspaceProfile): Promise<RemoteWorkspaceConnection> {
    const mirrorPath = path.join(this.remoteWorkspaceRoot, sanitizeMirrorDirectoryName(profile.id));
    await mkdir(mirrorPath, { recursive: true });
    const metadata = this.buildMetadata(mirrorPath, profile);
    await this.writeMetadata(metadata);
    return await this.syncWorkspace(mirrorPath);
  }

  async describe(workspacePath: string): Promise<RemoteWorkspaceMetadata | null> {
    const metadata = await this.readMetadata(workspacePath);
    return metadata ?? null;
  }

  async syncWorkspace(workspacePath: string): Promise<RemoteWorkspaceConnection> {
    const metadata = await this.requireMetadata(workspacePath);

    await this.withSftp(metadata.profile, async (sftp) => {
      await this.resetMirrorWorkspace(metadata.mirrorPath);
      await this.downloadRemoteDirectory(sftp, metadata.profile.remotePath, metadata.mirrorPath);
    });

    await this.writeMetadata(metadata);

    return {
      workspacePath: metadata.mirrorPath,
      metadata
    };
  }

  async pushWorkspaceFile(workspacePath: string, relativePath: string): Promise<void> {
    const metadata = await this.requireMetadata(workspacePath);
    await this.withSftp(metadata.profile, async (sftp) => {
      await this.uploadFile(sftp, metadata, relativePath);
    });
  }

  async pushWorkspaceFiles(workspacePath: string, relativePaths: string[]): Promise<string[]> {
    const metadata = await this.requireMetadata(workspacePath);
    const deduped = uniqueRelativePaths(relativePaths);

    await this.withSftp(metadata.profile, async (sftp) => {
      for (const relativePath of deduped) {
        await this.uploadFile(sftp, metadata, relativePath).catch(() => undefined);
      }
    });

    return deduped;
  }

  async pullWorkspaceFiles(workspacePath: string, relativePaths: string[]): Promise<string[]> {
    const metadata = await this.requireMetadata(workspacePath);
    const deduped = uniqueRelativePaths(relativePaths);

    await this.withSftp(metadata.profile, async (sftp) => {
      for (const relativePath of deduped) {
        await this.downloadFile(sftp, metadata, relativePath).catch(async () => {
          await unlink(path.join(metadata.mirrorPath, relativePath)).catch(() => undefined);
        });
      }
    });

    return deduped;
  }

  async buildTerminalBootstrapCommand(workspacePath: string): Promise<string | null> {
    const metadata = await this.readMetadata(workspacePath);

    if (!metadata) {
      return null;
    }

    return buildTerminalBootstrapCommand(metadata.profile);
  }

  async runWorkspaceCommand(
    workspacePath: string,
    spec: CommandSpec,
    options: {
      stdoutPath: string;
      stderrPath: string;
      timeoutMs?: number | null;
    }
  ): Promise<RemoteWorkspaceCommandResult> {
    const metadata = await this.requireMetadata(workspacePath);
    const command = this.buildWorkspaceCommand(metadata, spec);

    if (command.transport === "local") {
      const result = await runCommand({
        spec: command.command,
        timeoutMs: options.timeoutMs,
        stdoutPath: options.stdoutPath,
        stderrPath: options.stderrPath
      });

      return {
        ...result,
        command: command.command
      };
    }

    const result = await this.runRemoteHostCommand(metadata.profile, command.commandString, {
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      timeoutMs: options.timeoutMs
    });

    return {
      ...result,
      command: command.command
    };
  }

  private buildMetadata(mirrorPath: string, profile: RemoteWorkspaceProfile): RemoteWorkspaceMetadata {
    return {
      version: 1,
      mirrorPath,
      label: buildRemoteWorkspaceLabel(profile),
      kind: profile.kind,
      remoteHost: buildRemoteHostLabel(profile),
      remotePath: profile.remotePath,
      profile
    };
  }

  private async readMetadata(workspacePath: string): Promise<RemoteWorkspaceMetadata | null> {
    try {
      const raw = await readFile(path.join(workspacePath, REMOTE_METADATA_DIR, REMOTE_METADATA_FILE), "utf8");
      const candidate = JSON.parse(raw) as Record<string, unknown>;
      const [profile] = sanitizeRemoteWorkspaceProfiles([candidate.profile]);

      if (!profile || typeof candidate.mirrorPath !== "string" || typeof candidate.label !== "string") {
        return null;
      }

      return {
        version: 1,
        mirrorPath: candidate.mirrorPath,
        label: candidate.label,
        kind: profile.kind,
        remoteHost:
          typeof candidate.remoteHost === "string" && candidate.remoteHost.trim()
            ? candidate.remoteHost
            : buildRemoteHostLabel(profile),
        remotePath:
          typeof candidate.remotePath === "string" && candidate.remotePath.trim()
            ? candidate.remotePath
            : profile.remotePath,
        profile
      };
    } catch {
      return null;
    }
  }

  private async requireMetadata(workspacePath: string) {
    const metadata = await this.readMetadata(workspacePath);

    if (!metadata) {
      throw new Error("The selected workspace is not configured as a remote workspace.");
    }

    return metadata;
  }

  private async writeMetadata(metadata: RemoteWorkspaceMetadata) {
    const metadataDir = path.join(metadata.mirrorPath, REMOTE_METADATA_DIR);
    await mkdir(metadataDir, { recursive: true });
    await writeFile(path.join(metadataDir, REMOTE_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  private async resetMirrorWorkspace(workspacePath: string) {
    await mkdir(workspacePath, { recursive: true });
    const entries = await readdir(workspacePath, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (entry.name === REMOTE_METADATA_DIR) {
        continue;
      }

      await rm(path.join(workspacePath, entry.name), { recursive: true, force: true });
    }
  }

  private async downloadRemoteDirectory(sftp: SFTPWrapper, remotePath: string, localPath: string) {
    await mkdir(localPath, { recursive: true });
    const entries = await sftpReaddir(sftp, remotePath);

    for (const entry of entries) {
      if (REMOTE_DIRECTORY_IGNORES.has(entry.filename)) {
        continue;
      }

      const nextRemotePath = joinRemotePath(remotePath, entry.filename);
      const nextLocalPath = path.join(localPath, entry.filename);

      if (entry.attrs.isDirectory()) {
        await this.downloadRemoteDirectory(sftp, nextRemotePath, nextLocalPath);
        continue;
      }

      if (!entry.attrs.isFile()) {
        continue;
      }

      if ((entry.attrs.size ?? 0) > MAX_SYNCED_FILE_BYTES) {
        continue;
      }

      await mkdir(path.dirname(nextLocalPath), { recursive: true });
      await copyRemoteFileToLocal(sftp, nextRemotePath, nextLocalPath);
    }
  }

  private async downloadFile(sftp: SFTPWrapper, metadata: RemoteWorkspaceMetadata, relativePath: string) {
    const localPath = path.join(metadata.mirrorPath, relativePath);
    const remotePath = joinRemotePath(metadata.profile.remotePath, toRemoteRelativePath(relativePath));
    await mkdir(path.dirname(localPath), { recursive: true });
    await copyRemoteFileToLocal(sftp, remotePath, localPath);
  }

  private async uploadFile(sftp: SFTPWrapper, metadata: RemoteWorkspaceMetadata, relativePath: string) {
    const localPath = path.join(metadata.mirrorPath, relativePath);
    const localStat = await stat(localPath).catch(() => null);

    if (!localStat || !localStat.isFile()) {
      return;
    }

    const remotePath = joinRemotePath(metadata.profile.remotePath, toRemoteRelativePath(relativePath));
    await ensureRemoteDirectory(sftp, remoteDirname(remotePath));
    await copyLocalFileToRemote(sftp, localPath, remotePath);
  }

  private async withSftp<T>(profile: RemoteWorkspaceProfile, work: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    return await this.withConnection(profile, async (connection) => {
      const sftp = await openSftp(connection);
      return await work(sftp);
    });
  }

  private async withConnection<T>(profile: RemoteWorkspaceProfile, work: (connection: Client) => Promise<T>): Promise<T> {
    const connection = new Client();
    const config = await buildConnectConfig(profile);

    return await new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        connection.removeAllListeners();
        connection.end();
      };

      connection
        .once("ready", () => {
          void work(connection)
            .then((value) => {
              cleanup();
              resolve(value);
            })
            .catch((error) => {
              cleanup();
              reject(error);
            });
        })
        .once("error", (error) => {
          cleanup();
          reject(error);
        })
        .connect(config);
    });
  }

  private async runRemoteHostCommand(
    profile: RemoteWorkspaceProfile,
    commandString: string,
    options: {
      stdoutPath: string;
      stderrPath: string;
      timeoutMs?: number | null;
    }
  ): Promise<CommandResult> {
    await Promise.all([writeFile(options.stdoutPath, "", "utf8"), writeFile(options.stderrPath, "", "utf8")]);
    const startedAt = new Date().toISOString();

    return await this.withConnection(profile, async (connection) => {
      return await new Promise<CommandResult>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let timeoutId: NodeJS.Timeout | null = null;

        const finalize = async (payload: Omit<CommandResult, "startedAt">) => {
          if (settled) {
            return;
          }

          settled = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          resolve({
            startedAt,
            ...payload
          });
        };

        const normalizedTimeoutMs =
          typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs
            : null;

        if (normalizedTimeoutMs !== null) {
          timeoutId = setTimeout(() => {
            timedOut = true;
            connection.end();
          }, normalizedTimeoutMs);
        }

        connection.exec(commandString, (error, stream) => {
          if (error) {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            reject(error);
            return;
          }

          stream.on("close", (exitCode: number | null) => {
            void finalize({
              endedAt: new Date().toISOString(),
              exitCode,
              timedOut,
              stdout,
              stderr
            });
          });

          stream.on("data", (chunk: Buffer | string) => {
            const text = chunk.toString();
            stdout += text;
            void appendFile(options.stdoutPath, text, "utf8");
          });

          stream.stderr.on("data", (chunk: Buffer | string) => {
            const text = chunk.toString();
            stderr += text;
            void appendFile(options.stderrPath, text, "utf8");
          });

          stream.on("error", (streamError) => {
            stderr += `${String(streamError)}\n`;
          });
        });
      });
    });
  }

  private buildWorkspaceCommand(
    metadata: RemoteWorkspaceMetadata,
    spec: CommandSpec
  ):
    | { transport: "local"; command: CommandSpec }
    | { transport: "remote"; command: CommandSpec; commandString: string } {
    const relativeCwd = resolveWorkspaceRelativePath(metadata.mirrorPath, spec.cwd);

    if (metadata.profile.kind === "container" && metadata.profile.containerName && metadata.profile.dockerContext) {
      const containerCwd = joinRemotePath(
        metadata.profile.containerWorkspacePath || metadata.profile.remotePath,
        relativeCwd
      );
      const shellCommand = buildShellCommand({
        cwd: containerCwd,
        bootstrapCommand: undefined,
        command: [spec.command, ...spec.args]
      });

      return {
        transport: "local",
        command: {
          command: "docker",
          args: [
            "--context",
            metadata.profile.dockerContext,
            "exec",
            "-w",
            containerCwd,
            metadata.profile.containerName,
            "sh",
            "-lc",
            shellCommand
          ],
          cwd: metadata.mirrorPath
        }
      };
    }

    const commandString = this.buildRemoteHostCommandString(metadata, spec, relativeCwd);

    return {
      transport: "remote",
      command: buildSshCommandSpec(metadata.profile, commandString, metadata.mirrorPath),
      commandString
    };
  }

  private buildRemoteHostCommandString(
    metadata: RemoteWorkspaceMetadata,
    spec: CommandSpec,
    relativeCwd: string
  ) {
    if (metadata.profile.kind === "ssh") {
      return buildShellCommand({
        cwd: joinRemotePath(metadata.profile.remotePath, relativeCwd),
        bootstrapCommand: undefined,
        command: [spec.command, ...spec.args]
      });
    }

    const containerWorkspacePath = joinRemotePath(
      metadata.profile.containerWorkspacePath || metadata.profile.remotePath,
      relativeCwd
    );

    if (metadata.profile.containerName) {
      const innerCommand = buildShellCommand({
        cwd: containerWorkspacePath,
        bootstrapCommand: undefined,
        command: [spec.command, ...spec.args]
      });

      return quoteArgs([
        "docker",
        "exec",
        "-w",
        containerWorkspacePath,
        metadata.profile.containerName,
        "sh",
        "-lc",
        innerCommand
      ]);
    }

    const workspaceFolder = metadata.profile.remotePath;
    const upArgs = [
      "devcontainer",
      "up",
      "--workspace-folder",
      workspaceFolder
    ];

    if (metadata.profile.devcontainerConfigPath) {
      upArgs.push("--config", joinRemotePath(workspaceFolder, metadata.profile.devcontainerConfigPath));
    }

    const execCommand = buildShellCommand({
      cwd: containerWorkspacePath,
      bootstrapCommand: undefined,
      command: [spec.command, ...spec.args]
    });

    return `${quoteArgs(upArgs)} >/dev/null && ${quoteArgs([
      "devcontainer",
      "exec",
      "--workspace-folder",
      workspaceFolder,
      "sh",
      "-lc",
      execCommand
    ])}`;
  }
}

async function buildConnectConfig(profile: RemoteWorkspaceProfile): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: profile.host,
    port: profile.port ?? 22,
    username: profile.username
  };

  if (profile.privateKeyPath) {
    config.privateKey = await readFile(profile.privateKeyPath);
  } else if (process.env.SSH_AUTH_SOCK) {
    config.agent = process.env.SSH_AUTH_SOCK;
  }

  if (profile.hostFingerprint?.trim()) {
    const expectedFingerprint = profile.hostFingerprint.trim();
    config.hostVerifier = (hostKey: Buffer) => {
      const digest = createHash("sha256").update(hostKey).digest("base64");
      return expectedFingerprint === digest || expectedFingerprint === `SHA256:${digest}`;
    };
  }

  return config;
}

async function openSftp(connection: Client): Promise<SFTPWrapper> {
  return await new Promise<SFTPWrapper>((resolve, reject) => {
    connection.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(sftp);
    });
  });
}

async function sftpReaddir(sftp: SFTPWrapper, remotePath: string) {
  return await new Promise<FileEntry[]>((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(list ?? []);
    });
  });
}

async function ensureRemoteDirectory(sftp: SFTPWrapper, remoteDirectory: string) {
  const segments = remoteDirectory.split("/").filter(Boolean);
  let current = remoteDirectory.startsWith("/") ? "/" : "";

  for (const segment of segments) {
    current = current ? joinRemotePath(current, segment) : segment;
    const exists = await sftpStat(sftp, current).catch(() => null);

    if (exists?.isDirectory()) {
      continue;
    }

    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(current, (error) => {
        if (!error || String(error).includes("Failure")) {
          resolve();
          return;
        }

        reject(error);
      });
    });
  }
}

async function sftpStat(sftp: SFTPWrapper, remotePath: string) {
  return await new Promise<Stats>((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stats);
    });
  });
}

async function copyRemoteFileToLocal(sftp: SFTPWrapper, remotePath: string, localPath: string) {
  await new Promise<void>((resolve, reject) => {
    const readStream = sftp.createReadStream(remotePath);
    const writeStream = createWriteStream(localPath);

    readStream.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("close", () => resolve());
    readStream.pipe(writeStream);
  });
}

async function copyLocalFileToRemote(sftp: SFTPWrapper, localPath: string, remotePath: string) {
  await new Promise<void>((resolve, reject) => {
    const readStream = createReadStream(localPath);
    const writeStream = sftp.createWriteStream(remotePath);

    readStream.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("close", () => resolve());
    readStream.pipe(writeStream);
  });
}

function buildRemoteWorkspaceLabel(profile: RemoteWorkspaceProfile) {
  const remote = `${buildRemoteHostLabel(profile)}:${profile.remotePath}`;

  if (profile.kind !== "container") {
    return `${profile.name} (${remote})`;
  }

  if (profile.containerName) {
    return `${profile.name} (${remote} -> ${profile.containerName})`;
  }

  return `${profile.name} (${remote} -> devcontainer)`;
}

function buildRemoteHostLabel(profile: RemoteWorkspaceProfile) {
  return `${profile.username}@${profile.host}`;
}

function buildTerminalBootstrapCommand(profile: RemoteWorkspaceProfile) {
  if (profile.kind === "container" && profile.containerName && profile.dockerContext) {
    return quoteArgs([
      "docker",
      "--context",
      profile.dockerContext,
      "exec",
      "-it",
      "-w",
      profile.containerWorkspacePath || profile.remotePath,
      profile.containerName,
      ...splitShellCommand(profile.shell || "/bin/bash -il")
    ]);
  }

  const sshArgs = buildSshArgs(profile);
  const remoteCommand =
    profile.kind === "ssh"
      ? buildShellCommand({
          cwd: profile.remotePath,
          bootstrapCommand: profile.bootstrapCommand,
          command: splitShellCommand(profile.shell || "/bin/bash -il")
        })
      : buildContainerTerminalCommand(profile);

  return quoteArgs(["ssh", ...sshArgs, remoteCommand]);
}

function buildContainerTerminalCommand(profile: RemoteWorkspaceProfile) {
  const shellCommand = buildShellCommand({
    cwd: profile.containerWorkspacePath || profile.remotePath,
    bootstrapCommand: profile.bootstrapCommand,
    command: splitShellCommand(profile.shell || "/bin/bash -il")
  });

  if (profile.containerName) {
    return quoteArgs([
      "docker",
      "exec",
      "-it",
      "-w",
      profile.containerWorkspacePath || profile.remotePath,
      profile.containerName,
      "sh",
      "-lc",
      shellCommand
    ]);
  }

  const upArgs = ["devcontainer", "up", "--workspace-folder", profile.remotePath];

  if (profile.devcontainerConfigPath) {
    upArgs.push("--config", joinRemotePath(profile.remotePath, profile.devcontainerConfigPath));
  }

  return `${quoteArgs(upArgs)} >/dev/null && ${quoteArgs([
    "devcontainer",
    "exec",
    "--workspace-folder",
    profile.remotePath,
    "sh",
    "-lc",
    shellCommand
  ])}`;
}

function buildSshCommandSpec(profile: RemoteWorkspaceProfile, commandString: string, cwd: string): CommandSpec {
  return {
    command: "ssh",
    args: [...buildSshArgs(profile), commandString],
    cwd
  };
}

function buildSshArgs(profile: RemoteWorkspaceProfile) {
  const args = ["-t"];

  if (profile.port && profile.port !== 22) {
    args.push("-p", String(profile.port));
  }

  if (profile.privateKeyPath) {
    args.push("-i", profile.privateKeyPath);
  }

  args.push(`${profile.username}@${profile.host}`);
  return args;
}

function buildShellCommand(input: {
  cwd: string;
  bootstrapCommand?: string;
  command: string[];
}) {
  const parts = [`cd ${quoteShell(input.cwd)}`];

  if (input.bootstrapCommand?.trim()) {
    parts.push(input.bootstrapCommand.trim());
  }

  parts.push(`exec ${quoteArgs(input.command)}`);
  return parts.join(" && ");
}

function quoteArgs(args: string[]) {
  return args.map((value) => quoteShell(value)).join(" ");
}

function quoteShell(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function splitShellCommand(value: string) {
  return value.trim().split(/\s+/).filter(Boolean);
}

function joinRemotePath(basePath: string, relativePath: string) {
  if (!relativePath) {
    return path.posix.normalize(basePath);
  }

  return path.posix.normalize(path.posix.join(basePath, relativePath));
}

function remoteDirname(value: string) {
  return path.posix.dirname(value);
}

function sanitizeMirrorDirectoryName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-") || "remote-workspace";
}

function resolveWorkspaceRelativePath(workspacePath: string, targetPath: string) {
  const relativePath = path.relative(workspacePath, path.resolve(targetPath));

  if (!relativePath || relativePath === ".") {
    return "";
  }

  return toRemoteRelativePath(relativePath);
}

function toRemoteRelativePath(value: string) {
  return value
    .split(path.sep)
    .filter(Boolean)
    .join(path.posix.sep);
}

function uniqueRelativePaths(relativePaths: string[]) {
  return [...new Set(relativePaths.map((value) => toRemoteRelativePath(value.trim())).filter(Boolean))];
}
