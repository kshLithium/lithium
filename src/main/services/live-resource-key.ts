import path from "node:path";

export function buildLiveResourceKey(workspacePath: string, id: string) {
  return `${path.resolve(workspacePath)}::${id}`;
}
