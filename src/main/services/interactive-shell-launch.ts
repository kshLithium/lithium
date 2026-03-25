import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

export type InteractiveShellLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  label: string;
  cleanup: () => Promise<void>;
};

export async function prepareInteractiveShellLaunch(shellPath?: string): Promise<InteractiveShellLaunch> {
  const command = shellPath || process.env.SHELL || "/bin/zsh";
  const label = path.basename(command);

  if (label === "zsh") {
    return await prepareZshLaunch(command, label);
  }

  if (label === "bash") {
    return await prepareBashLaunch(command, label);
  }

  return {
    command,
    args: ["-i"],
    env: {},
    label,
    cleanup: async () => undefined
  };
}

async function prepareZshLaunch(command: string, label: string): Promise<InteractiveShellLaunch> {
  const originalHome = process.env.HOME || os.homedir();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-zsh-"));
  const escapedHome = toShellLiteral(originalHome);

  await writeFile(
    path.join(tempDir, ".zshenv"),
    [
      `export LITHIUM_ORIGINAL_HOME=${escapedHome}`,
      `if [ -f "$LITHIUM_ORIGINAL_HOME/.zshenv" ]; then`,
      `  source "$LITHIUM_ORIGINAL_HOME/.zshenv"`,
      `fi`
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(tempDir, ".zprofile"),
    [
      `if [ -f "$LITHIUM_ORIGINAL_HOME/.zprofile" ]; then`,
      `  source "$LITHIUM_ORIGINAL_HOME/.zprofile"`,
      `fi`
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(tempDir, ".zshrc"),
    [
      `if [ -f "$LITHIUM_ORIGINAL_HOME/.zshrc" ]; then`,
      `  source "$LITHIUM_ORIGINAL_HOME/.zshrc"`,
      `fi`,
      `lithium_emit_cwd() { printf '\\033]633;cwd=%s\\007' "$PWD"; }`,
      `autoload -Uz add-zsh-hook >/dev/null 2>&1 || true`,
      `if typeset -f add-zsh-hook >/dev/null 2>&1; then`,
      `  add-zsh-hook precmd lithium_emit_cwd`,
      `else`,
      `  precmd_functions+=(lithium_emit_cwd)`,
      `fi`,
      `lithium_emit_cwd`
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(tempDir, ".zlogin"),
    [
      `if [ -f "$LITHIUM_ORIGINAL_HOME/.zlogin" ]; then`,
      `  source "$LITHIUM_ORIGINAL_HOME/.zlogin"`,
      `fi`
    ].join("\n"),
    "utf8"
  );

  return {
    command,
    args: ["-il"],
    env: {
      ZDOTDIR: tempDir
    },
    label,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function prepareBashLaunch(command: string, label: string): Promise<InteractiveShellLaunch> {
  const originalHome = process.env.HOME || os.homedir();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "lithium-bash-"));
  const rcPath = path.join(tempDir, "lithium.bashrc");
  const escapedHome = toShellLiteral(originalHome);

  await writeFile(
    rcPath,
    [
      `export LITHIUM_ORIGINAL_HOME=${escapedHome}`,
      `if [ -f "$LITHIUM_ORIGINAL_HOME/.bash_profile" ]; then`,
      `  source "$LITHIUM_ORIGINAL_HOME/.bash_profile"`,
      `elif [ -f "$LITHIUM_ORIGINAL_HOME/.bash_login" ]; then`,
      `  source "$LITHIUM_ORIGINAL_HOME/.bash_login"`,
      `elif [ -f "$LITHIUM_ORIGINAL_HOME/.profile" ]; then`,
      `  source "$LITHIUM_ORIGINAL_HOME/.profile"`,
      `fi`,
      `if [ -f "$LITHIUM_ORIGINAL_HOME/.bashrc" ]; then`,
      `  source "$LITHIUM_ORIGINAL_HOME/.bashrc"`,
      `fi`,
      `lithium_emit_cwd() { printf '\\033]633;cwd=%s\\007' "$PWD"; }`,
      `if [ -n "$PROMPT_COMMAND" ]; then`,
      `  PROMPT_COMMAND="lithium_emit_cwd;$PROMPT_COMMAND"`,
      `else`,
      `  PROMPT_COMMAND="lithium_emit_cwd"`,
      `fi`,
      `lithium_emit_cwd`
    ].join("\n"),
    "utf8"
  );

  return {
    command,
    args: ["--rcfile", rcPath, "-i"],
    env: {},
    label,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

function toShellLiteral(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
