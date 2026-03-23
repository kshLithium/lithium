import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileRecord } from "../shared/types";
import type { CodeTab } from "./app-types";
import {
  basenamePath,
  buildCollapsedCodeFolderState,
  expandCollapsedFolderAncestors,
  nextUntitledCodePath,
  normalizePath,
  normalizeNewCodeFilePath,
  selectPreferredCodePath,
  suggestNewCodeFilePath,
  toErrorMessage,
  untitledCodeLabel
} from "./app-utils";

type UseCodeWorkbenchStateArgs = {
  changedFiles: string[];
  codeExplorerFiles: WorkspaceFileRecord[];
  codeFiles: WorkspaceFileRecord[];
  onOpenCanvas: () => void;
  onRefreshWorkspace: (workspacePath?: string) => Promise<void>;
  onReportError: (message: string) => void;
  onRequestWorkspace: () => Promise<string | null>;
  withBusy: (label: string, work: () => Promise<void>) => Promise<void>;
  workspacePath: string;
};

export function useCodeWorkbenchState({
  changedFiles,
  codeExplorerFiles,
  codeFiles,
  onOpenCanvas,
  onRefreshWorkspace,
  onReportError,
  onRequestWorkspace,
  withBusy,
  workspacePath
}: UseCodeWorkbenchStateArgs) {
  const [selectedCodePath, setSelectedCodePath] = useState("");
  const [codeTabs, setCodeTabs] = useState<CodeTab[]>([]);
  const [collapsedCodeFolders, setCollapsedCodeFolders] = useState<Record<string, boolean>>({});
  const [hydratedCollapseStateKey, setHydratedCollapseStateKey] = useState("");
  const collapseStateStorageKey = useMemo(
    () => buildCodeExplorerStorageKey(workspacePath),
    [workspacePath]
  );

  const activeCodeTab = useMemo(
    () => codeTabs.find((tab) => tab.path === selectedCodePath) ?? null,
    [codeTabs, selectedCodePath]
  );

  useEffect(() => {
    if (!workspacePath) {
      setCollapsedCodeFolders({});
      setHydratedCollapseStateKey("");
      return;
    }

    const persistedState =
      hydratedCollapseStateKey === collapseStateStorageKey
        ? null
        : readCollapsedCodeFolders(collapseStateStorageKey);

    setCollapsedCodeFolders((current) => {
      const nextState = buildCollapsedCodeFolderState(codeExplorerFiles, persistedState ?? current);
      return areCollapsedFolderStatesEqual(current, nextState) ? current : nextState;
    });

    if (hydratedCollapseStateKey !== collapseStateStorageKey) {
      setHydratedCollapseStateKey(collapseStateStorageKey);
    }
  }, [codeExplorerFiles, collapseStateStorageKey, hydratedCollapseStateKey, workspacePath]);

  useEffect(() => {
    const validCodePaths = new Set(codeFiles.map((file) => file.path));
    const nextTabs = codeTabs.filter((tab) => tab.isUntitled || validCodePaths.has(tab.path));

    if (nextTabs.length !== codeTabs.length) {
      setCodeTabs(nextTabs);
    }

    if (selectedCodePath && nextTabs.some((tab) => tab.path === selectedCodePath)) {
      return;
    }

    const nextOpenTab = nextTabs[0]?.path;

    if (nextOpenTab) {
      if (selectedCodePath !== nextOpenTab) {
        setSelectedCodePath(nextOpenTab);
      }
      return;
    }

    if (!validCodePaths.size) {
      if (selectedCodePath) {
        setSelectedCodePath("");
      }
      return;
    }

    const preferredPath = selectPreferredCodePath(codeExplorerFiles, changedFiles);

    if (preferredPath) {
      void openCodeFile(preferredPath, { openCanvas: false });
    }
  }, [changedFiles, codeExplorerFiles, codeFiles, codeTabs, selectedCodePath]);

  useEffect(() => {
    if (!workspacePath || !selectedCodePath || !activeCodeTab || activeCodeTab.loaded || activeCodeTab.isUntitled) {
      return;
    }

    void window.lithium
      .readWorkspaceFile({ workspacePath, path: selectedCodePath })
      .then((file) => {
        setCodeTabs((current) =>
          current.map((tab) =>
            tab.path === selectedCodePath
              ? {
                  ...tab,
                  draft: file.content,
                  dirty: false,
                  loaded: true
                }
              : tab
          )
        );
      })
      .catch((nextError: unknown) => onReportError(toErrorMessage(nextError)));
  }, [activeCodeTab, onReportError, selectedCodePath, workspacePath]);

  useEffect(() => {
    const selectedFile = codeFiles.find((file) => file.path === selectedCodePath);

    if (!selectedFile) {
      return;
    }

    setCollapsedCodeFolders((current) => {
      const nextState = expandCollapsedFolderAncestors(current, selectedFile.relativePath);
      return areCollapsedFolderStatesEqual(current, nextState) ? current : nextState;
    });
  }, [codeFiles, selectedCodePath]);

  useEffect(() => {
    if (!workspacePath || hydratedCollapseStateKey !== collapseStateStorageKey) {
      return;
    }

    writeCollapsedCodeFolders(collapseStateStorageKey, collapsedCodeFolders);
  }, [collapseStateStorageKey, collapsedCodeFolders, hydratedCollapseStateKey, workspacePath]);

  async function openCodeFile(path: string, options: { openCanvas?: boolean } = {}) {
    const shouldOpenCanvas = options.openCanvas ?? true;
    const existingTab = codeTabs.find((tab) => tab.path === path);

    if (existingTab) {
      if (shouldOpenCanvas) {
        onOpenCanvas();
      }
      setSelectedCodePath(path);
      return;
    }

    const nextTab: CodeTab = {
      path,
      label: basenamePath(path),
      filePath: path,
      draft: "",
      dirty: false,
      isPreview: true,
      loaded: false,
      isUntitled: false
    };

    setCodeTabs((current) => {
      const reusablePreviewIndex = current.findIndex((tab) => tab.isPreview && !tab.dirty);

      if (reusablePreviewIndex >= 0) {
        const nextTabs = [...current];
        nextTabs[reusablePreviewIndex] = nextTab;
        return nextTabs;
      }

      return [...current, nextTab];
    });

    if (shouldOpenCanvas) {
      onOpenCanvas();
    }

    setSelectedCodePath(path);
  }

  function createUntitledCodeTab(options: { openCanvas?: boolean } = {}) {
    const shouldOpenCanvas = options.openCanvas ?? true;
    const reusableTab = codeTabs.find((tab) => tab.isUntitled && !tab.dirty && !tab.draft.trim());

    if (reusableTab) {
      if (shouldOpenCanvas) {
        onOpenCanvas();
      }
      setSelectedCodePath(reusableTab.path);
      return reusableTab.path;
    }

    const path = nextUntitledCodePath(codeTabs.map((tab) => tab.path));
    const nextTab: CodeTab = {
      path,
      label: untitledCodeLabel(path),
      filePath: null,
      draft: "",
      dirty: false,
      isPreview: false,
      loaded: true,
      isUntitled: true
    };

    setCodeTabs((current) => [...current, nextTab]);

    if (shouldOpenCanvas) {
      onOpenCanvas();
    }

    setSelectedCodePath(path);
    return path;
  }

  function updateCodeDraft(value: string) {
    setCodeTabs((current) =>
      current.map((tab) =>
        tab.path === selectedCodePath
          ? {
              ...tab,
              draft: value,
              dirty: true,
              isPreview: false,
              loaded: true
            }
          : tab
      )
    );
  }

  function handleCloseCodeTab(path: string) {
    const closingTab = codeTabs.find((tab) => tab.path === path);

    if (!closingTab) {
      return;
    }

    if (closingTab.dirty && !window.confirm(`Discard unsaved changes in ${basenamePath(path)}?`)) {
      return;
    }

    const closingIndex = codeTabs.findIndex((tab) => tab.path === path);
    const nextTabs = codeTabs.filter((tab) => tab.path !== path);

    setCodeTabs(nextTabs);

    if (selectedCodePath === path) {
      const fallbackPath =
        nextTabs[closingIndex]?.path ?? nextTabs[closingIndex - 1]?.path ?? nextTabs[0]?.path ?? "";
      setSelectedCodePath(fallbackPath);
    }
  }

  function toggleCodeFolder(path: string) {
    setCollapsedCodeFolders((current) => ({
      ...current,
      [path]: !current[path]
    }));
  }

  function resetCodeWorkbench() {
    setCodeTabs([]);
    setSelectedCodePath("");
    setCollapsedCodeFolders({});
  }

  async function handleSaveCode() {
    if (!selectedCodePath || !activeCodeTab) {
      return;
    }

    if (activeCodeTab.isUntitled) {
      const targetWorkspacePath = workspacePath || (await onRequestWorkspace());

      if (!targetWorkspacePath) {
        return;
      }

      const requestedPath = window.prompt("Save new file as", suggestNewCodeFilePath(codeExplorerFiles));

      if (requestedPath === null) {
        return;
      }

      const normalizedPath = normalizeNewCodeFilePath(requestedPath);

      if (!normalizedPath) {
        onReportError("Choose a file path inside the workspace.");
        return;
      }

      await withBusy("Saving new code file", async () => {
        const file = await window.lithium.saveWorkspaceFile({
          workspacePath: targetWorkspacePath,
          path: normalizedPath,
          content: activeCodeTab.draft
        });

        setCodeTabs((current) => {
          const targetIndex = current.findIndex((tab) => tab.path === selectedCodePath);

          if (targetIndex < 0) {
            return current;
          }

          const nextTabs = [...current];
          const savedTab: CodeTab = {
            path: file.path,
            label: file.name,
            filePath: file.path,
            draft: file.content,
            dirty: false,
            isPreview: false,
            loaded: true,
            isUntitled: false
          };
          const duplicateIndex = nextTabs.findIndex((tab, index) => index !== targetIndex && tab.path === file.path);

          if (duplicateIndex >= 0) {
            nextTabs[duplicateIndex] = savedTab;
            nextTabs.splice(targetIndex, 1);
            return nextTabs;
          }

          nextTabs[targetIndex] = savedTab;
          return nextTabs;
        });

        setSelectedCodePath(file.path);
        await onRefreshWorkspace(targetWorkspacePath);
      });
      return;
    }

    if (!workspacePath) {
      return;
    }

    if (!activeCodeTab.dirty) {
      setCodeTabs((current) =>
        current.map((tab) =>
          tab.path === selectedCodePath
            ? {
                ...tab,
                isPreview: false
              }
            : tab
        )
      );
      return;
    }

    await withBusy("Saving code file", async () => {
      const file = await window.lithium.saveWorkspaceFile({
        workspacePath,
        path: selectedCodePath,
        content: activeCodeTab.draft
      });

      setCodeTabs((current) =>
        current.map((tab) =>
          tab.path === selectedCodePath
            ? {
                ...tab,
                draft: file.content,
                dirty: false,
                isPreview: false,
                loaded: true
              }
            : tab
        )
      );

      await onRefreshWorkspace(workspacePath);
    });
  }

  return {
    activeCodeTab,
    codeTabs,
    collapsedCodeFolders,
    createUntitledCodeTab,
    handleCloseCodeTab,
    handleSaveCode,
    openCodeFile,
    resetCodeWorkbench,
    selectedCodePath,
    setSelectedCodePath,
    toggleCodeFolder,
    updateCodeDraft
  };
}

function buildCodeExplorerStorageKey(workspacePath: string) {
  const normalizedPath = normalizePath(workspacePath).trim();
  return normalizedPath ? `lithium.code-explorer.${encodeURIComponent(normalizedPath)}` : "";
}

function readCollapsedCodeFolders(storageKey: string) {
  if (!storageKey || typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(storageKey);

    if (!raw) {
      return {};
    }

    const value = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, boolean] => typeof entry[0] === "string" && typeof entry[1] === "boolean"
      )
    );
  } catch {
    return {};
  }
}

function writeCollapsedCodeFolders(storageKey: string, collapsedFolders: Record<string, boolean>) {
  if (!storageKey || typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(collapsedFolders));
}

function areCollapsedFolderStatesEqual(
  left: Record<string, boolean>,
  right: Record<string, boolean>
) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => left[key] === right[key]);
}
