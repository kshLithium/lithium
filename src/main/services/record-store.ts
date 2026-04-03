import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathExists } from "./fs-utils";

const RECORD_READ_BATCH_SIZE = 32;

export class RecordStore {
  private readonly allocationQueues = new Map<string, Promise<void>>();

  async readRecordDirectory<T>(directory: string) {
    if (!(await pathExists(directory))) {
      return [] as T[];
    }

    const entries = (await readdir(directory).catch(() => [] as string[]))
      .filter((entry) => entry.endsWith(".json"))
      .sort(compareRecordFiles)
      .reverse();
    const records: T[] = [];

    for (let index = 0; index < entries.length; index += RECORD_READ_BATCH_SIZE) {
      const batch = entries.slice(index, index + RECORD_READ_BATCH_SIZE);
      const batchRecords = await Promise.all(
        batch.map(async (entry) => {
          try {
            const content = await readFile(path.join(directory, entry), "utf8");
            return JSON.parse(content) as T;
          } catch {
            return null;
          }
        })
      );

      for (const record of batchRecords) {
        if (record !== null) {
          records.push(record);
        }
      }
    }

    return records;
  }

  async readJson<T>(filePath: string) {
    if (!(await pathExists(filePath))) {
      return null;
    }

    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  }

  async writeJson(filePath: string, value: unknown) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  }

  async nextId(directory: string, prefix: string) {
    return await this.withAllocationLock(`${directory}::${prefix}`, async () => {
      await mkdir(directory, { recursive: true });
      const entries = await readdir(directory);
      const counterPath = path.join(directory, `.${prefix}.next-id`);
      const existingNext =
        entries
          .map((entry) => {
            const match = entry.match(new RegExp(`^${prefix}(\\d+)(?:\\.|$)`));
            return match ? Number(match[1]) : 0;
          })
          .reduce((max, value) => Math.max(max, value), 0) + 1;
      const storedNext = Number.parseInt((await readFile(counterPath, "utf8").catch(() => "")).trim(), 10);
      const next =
        Number.isFinite(storedNext) && storedNext > 0
          ? Math.max(existingNext, storedNext)
          : existingNext;

      await writeFile(counterPath, String(next + 1), "utf8");

      return `${prefix}${String(next).padStart(3, "0")}`;
    });
  }

  private async withAllocationLock<T>(key: string, work: () => Promise<T>) {
    const previous = this.allocationQueues.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    this.allocationQueues.set(
      key,
      previous.catch(() => undefined).then(() => current)
    );
    await previous.catch(() => undefined);

    try {
      return await work();
    } finally {
      releaseCurrent();

      if (this.allocationQueues.get(key) === current) {
        this.allocationQueues.delete(key);
      }
    }
  }
}

function compareRecordFiles(left: string, right: string) {
  const leftMatch = left.match(/(\d+)/);
  const rightMatch = right.match(/(\d+)/);
  const leftIndex = leftMatch ? Number.parseInt(leftMatch[1], 10) : 0;
  const rightIndex = rightMatch ? Number.parseInt(rightMatch[1], 10) : 0;

  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }

  return left.localeCompare(right);
}
