import path from "node:path";

export function resolveInitialWorkspacePath(
  argv: string[],
  lastWorkspacePath: string,
  cwd: string
) {
  const candidate = argv.find((value) => value.trim() && !value.startsWith("-"))?.trim() || "";

  if (candidate) {
    return path.resolve(cwd, candidate);
  }

  if (lastWorkspacePath.trim()) {
    return path.resolve(cwd, lastWorkspacePath.trim());
  }

  return path.resolve(cwd);
}

export function splitShellLikeArguments(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function resolveWorkspacePath(value: string, cwd: () => string) {
  return path.resolve(cwd(), value.trim());
}
