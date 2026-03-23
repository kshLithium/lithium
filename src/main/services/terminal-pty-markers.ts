const CWD_MARKER_PREFIX = "\u001b]633;cwd=";
const BELL_TERMINATOR = "\u0007";
const ST_TERMINATOR = "\u001b\\";

type TerminalMarkerParseResult = {
  cwd: string | null;
  output: string;
  pending: string;
};

export function stripTerminalMarkers(input: string, pending = ""): TerminalMarkerParseResult {
  const source = `${pending}${input}`;
  let cursor = 0;
  let output = "";
  let cwd: string | null = null;

  while (cursor < source.length) {
    const markerIndex = source.indexOf(CWD_MARKER_PREFIX, cursor);

    if (markerIndex < 0) {
      const rest = source.slice(cursor);
      const partialLength = readPartialSuffixLength(rest, CWD_MARKER_PREFIX);
      const visible = partialLength > 0 ? rest.slice(0, -partialLength) : rest;
      output += visible;

      return {
        cwd,
        output,
        pending: partialLength > 0 ? rest.slice(-partialLength) : ""
      };
    }

    output += source.slice(cursor, markerIndex);
    const payloadStart = markerIndex + CWD_MARKER_PREFIX.length;
    const bellIndex = source.indexOf(BELL_TERMINATOR, payloadStart);
    const stIndex = source.indexOf(ST_TERMINATOR, payloadStart);
    const terminatorIndex = resolveTerminatorIndex(bellIndex, stIndex);

    if (terminatorIndex < 0) {
      return {
        cwd,
        output,
        pending: source.slice(markerIndex)
      };
    }

    cwd = source.slice(payloadStart, terminatorIndex).trim() || cwd;
    cursor = terminatorIndex + (terminatorIndex === stIndex ? ST_TERMINATOR.length : BELL_TERMINATOR.length);
  }

  return {
    cwd,
    output,
    pending: ""
  };
}

function resolveTerminatorIndex(bellIndex: number, stIndex: number) {
  if (bellIndex < 0) {
    return stIndex;
  }

  if (stIndex < 0) {
    return bellIndex;
  }

  return Math.min(bellIndex, stIndex);
}

function readPartialSuffixLength(value: string, prefix: string) {
  const maxLength = Math.min(value.length, prefix.length - 1);

  for (let length = maxLength; length > 0; length -= 1) {
    if (value.endsWith(prefix.slice(0, length))) {
      return length;
    }
  }

  return 0;
}
