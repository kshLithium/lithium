import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { resolveInitialWorkspacePath } from "./command-parser";
import { type LithiumCliController } from "./controller";
import { formatError, CliTerminal } from "./terminal";

type StartCliReplOptions = {
  controller: LithiumCliController;
  input: Readable;
  output: Writable & { isTTY?: boolean };
  pollIntervalMs?: number;
};

export async function startCliRepl(options: StartCliReplOptions) {
  const rl = createInterface({
    input: options.input,
    output: options.output,
    terminal: options.output.isTTY ?? true
  });
  const terminal = new CliTerminal(rl, options.output);
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const queue: string[] = [];
  let draining = false;
  let pollInFlight = false;
  let closed = false;
  let resolveFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const cleanup = () => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(pollTimer);
    rl.close();
  };

  const drainQueue = async () => {
    if (draining || closed) {
      return;
    }

    draining = true;

    try {
      while (queue.length && !closed) {
        const nextLine = queue.shift() ?? "";

        try {
          const result = await options.controller.handleLine(nextLine);
          if (result === "exit") {
            cleanup();
            return;
          }
        } catch (error) {
          terminal.writeLine(formatError(error));
        }

        if (closed) {
          return;
        }

        rl.setPrompt(options.controller.buildPrompt());
        rl.prompt();
      }
    } finally {
      draining = false;
    }
  };

  const pollTimer = setInterval(() => {
    if (pollInFlight || closed) {
      return;
    }

    pollInFlight = true;
    void options.controller
      .pollOnce()
      .catch((error) => {
        terminal.writeLine(formatError(error));
      })
      .finally(() => {
        pollInFlight = false;
      });
  }, pollIntervalMs);

  rl.on("line", (line) => {
    queue.push(line);
    void drainQueue();
  });

  rl.on("SIGINT", () => {
    terminal.writeLine("Use :exit to leave Lithium CLI.");
    rl.prompt();
  });

  rl.on("close", () => {
    if (!closed) {
      closed = true;
      clearInterval(pollTimer);
    }
    resolveFinished();
  });

  rl.setPrompt(options.controller.buildPrompt());
  rl.prompt();
  await finished;
}

export { LithiumCliController } from "./controller";
export { resolveInitialWorkspacePath } from "./command-parser";
