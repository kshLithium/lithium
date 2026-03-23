import path from "node:path";
import { realpath } from "node:fs/promises";

const OUTSIDE_WORKSPACE_ERROR = "Workspace files must stay inside the selected workspace.";

export async function resolveWorkspaceMemberPath(workspacePath: string, filePath: string): Promise<string> {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedWorkspacePath, filePath);
  const canonicalWorkspacePath = await resolveCanonicalExistingPath(resolvedWorkspacePath);
  const canonicalTargetPath = await resolveCanonicalWorkspaceTarget(absolutePath);

  if (isInsideWorkspace(canonicalWorkspacePath, canonicalTargetPath)) {
    return absolutePath;
  }

  throw new Error(OUTSIDE_WORKSPACE_ERROR);
}

async function resolveCanonicalWorkspaceTarget(absolutePath: string): Promise<string> {
  const existingTarget = await resolveCanonicalExistingPath(absolutePath).catch(() => null);

  if (existingTarget) {
    return existingTarget;
  }

  const absoluteParentPath = path.dirname(absolutePath);
  const canonicalParentPath = await resolveCanonicalExistingPath(absoluteParentPath);
  return path.join(canonicalParentPath, path.basename(absolutePath));
}

async function resolveCanonicalExistingPath(targetPath: string): Promise<string> {
  return await realpath(targetPath).catch(async () => {
    const parentPath = path.dirname(targetPath);

    if (parentPath === targetPath) {
      throw new Error(OUTSIDE_WORKSPACE_ERROR);
    }

    const canonicalParentPath = await resolveCanonicalExistingPath(parentPath);
    return path.join(canonicalParentPath, path.basename(targetPath));
  });
}

function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const relativePath = path.relative(workspacePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
