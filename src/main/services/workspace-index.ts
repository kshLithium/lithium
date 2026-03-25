import { type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactKind, WorkspaceFileKind } from "../../shared/types";

const LITHIUM_DIR = ".lithium";

export const WORKSPACE_INDEX_IGNORED_DIRS = new Set([
  ".git",
  "dist",
  "dist-electron",
  "build",
  "release",
  "output",
  "tmp",
  "test-results",
  "coverage",
  ".next",
  ".turbo",
  LITHIUM_DIR,
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "node_modules"
]);

export type WorkspaceIndexEntry = {
  path: string;
  relativePath: string;
  name: string;
  kind: WorkspaceFileKind;
  artifactKind: ArtifactKind;
  stats: Stats | null;
};

export async function walkWorkspaceIndex(
  workspaceRoot: string,
  visitor: (entry: WorkspaceIndexEntry) => Promise<void> | void,
  options: {
    includeStats?: boolean;
  } = {}
) {
  await visitWorkspacePath(workspaceRoot, workspaceRoot, visitor, options.includeStats ?? false);
}

export function classifyWorkspaceFile(filePath: string): { kind: WorkspaceFileKind; artifactKind: ArtifactKind } | null {
  const extension = path.extname(filePath).toLowerCase();

  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".css",
      ".sh",
      ".py",
      ".yaml",
      ".yml",
      ".toml",
      ".rs",
      ".go",
      ".java",
      ".c",
      ".cc",
      ".cpp",
      ".h",
      ".hpp"
    ].includes(extension)
  ) {
    return {
      kind: "code",
      artifactKind: "code"
    };
  }

  if ([".tex", ".bib", ".cls", ".sty"].includes(extension)) {
    return {
      kind: "paper",
      artifactKind: extension === ".bib" ? "bib" : "tex"
    };
  }

  if (extension === ".pdf") {
    return {
      kind: "paper",
      artifactKind: "pdf"
    };
  }

  if ([".json"].includes(extension)) {
    return {
      kind: "artifact",
      artifactKind: "json"
    };
  }

  if ([".csv", ".tsv"].includes(extension)) {
    return {
      kind: "artifact",
      artifactKind: "csv"
    };
  }

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(extension)) {
    return {
      kind: "artifact",
      artifactKind: "image"
    };
  }

  if ([".txt", ".md", ".log"].includes(extension)) {
    return {
      kind: "artifact",
      artifactKind: extension === ".log" ? "log" : "text"
    };
  }

  return null;
}

async function visitWorkspacePath(
  workspaceRoot: string,
  currentPath: string,
  visitor: (entry: WorkspaceIndexEntry) => Promise<void> | void,
  includeStats: boolean
) {
  const entries = (await readdir(currentPath, { withFileTypes: true }).catch(() => [])).sort((left, right) =>
    left.name.localeCompare(right.name)
  );

  for (const entry of entries) {
    if (WORKSPACE_INDEX_IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await visitWorkspacePath(workspaceRoot, fullPath, visitor, includeStats);
      continue;
    }

    const fileMeta = classifyWorkspaceFile(fullPath);

    if (!fileMeta) {
      continue;
    }

    await visitor({
      path: fullPath,
      relativePath: path.relative(workspaceRoot, fullPath),
      name: path.basename(fullPath),
      kind: fileMeta.kind,
      artifactKind: fileMeta.artifactKind,
      stats: includeStats ? await stat(fullPath).catch(() => null) : null
    });
  }
}
