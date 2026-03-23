import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function main() {
  const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,command="], {
    cwd: process.cwd()
  });

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const match = lines
    .map((line) => {
      const pidMatch = line.match(/^(\d+)\s+(.*)$/);

      if (!pidMatch) {
        return null;
      }

      return {
        pid: Number.parseInt(pidMatch[1], 10),
        command: pidMatch[2]
      };
    })
    .filter((entry): entry is { pid: number; command: string } => Boolean(entry))
    .find(
      (entry) =>
        entry.command.includes("/Electron.app/Contents/MacOS/Electron dist-electron/index.cjs") &&
        !entry.command.includes("release/") &&
        !entry.command.includes("Helper")
    );

  if (!match) {
    console.error("No dev Lithium Electron process is running.");
    process.exitCode = 1;
    return;
  }

  await execFileAsync("osascript", [
    "-e",
    `tell application "System Events" to set frontmost of first application process whose unix id is ${match.pid} to true`
  ]);

  console.log(`Focused dev app pid ${match.pid}.`);
}

await main();
