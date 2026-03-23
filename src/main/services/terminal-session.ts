const TERMINAL_CWD_MARKER = "__LITHIUM_CWD__:";

export function wrapTerminalCommand(command: string) {
  const trimmed = command.trim();
  return `${trimmed}\nprintf '\\n${TERMINAL_CWD_MARKER}%s\\n' "$PWD"`;
}

export function parseTerminalCapture(stdout: string, stderr: string, fallbackCwd: string) {
  const cleanedStdout = stripTerminalMarker(stdout);
  const cleanedStderr = stripTerminalMarker(stderr);
  const nextCwd = cleanedStderr.cwd || cleanedStdout.cwd || fallbackCwd;

  return {
    cwd: nextCwd,
    stdout: cleanedStdout.output,
    stderr: cleanedStderr.output,
    output: joinTerminalOutput(cleanedStdout.output, cleanedStderr.output)
  };
}

export function joinTerminalOutput(stdout: string, stderr: string) {
  return [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n").trimEnd();
}

function stripTerminalMarker(value: string) {
  const match = value.match(new RegExp(`${TERMINAL_CWD_MARKER}([^\\r\\n]+)\\r?\\n?$`));

  if (!match || !match[1]) {
    return {
      cwd: null,
      output: value.replace(/\s+$/, "")
    };
  }

  const markerIndex = match.index ?? value.length;

  return {
    cwd: match[1].trim(),
    output: value.slice(0, markerIndex).replace(/\s+$/, "")
  };
}
