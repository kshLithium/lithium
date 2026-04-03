import readline from "node:readline";
import type { Interface } from "node:readline";
import type { Writable } from "node:stream";

export function formatError(error: unknown) {
  return `[error] ${error instanceof Error ? error.message : String(error)}`;
}

export class CliTerminal {
  constructor(
    private readonly rl: Interface,
    private readonly output: Writable & { isTTY?: boolean }
  ) {}

  writeLine(line = "") {
    if (this.output.isTTY) {
      readline.clearLine(this.output, 0);
      readline.cursorTo(this.output, 0);
      this.output.write(`${line}\n`);
      const refreshable = this.rl as Interface & { _refreshLine?: () => void };
      refreshable._refreshLine?.();
      return;
    }

    this.output.write(`${line}\n`);
  }
}
