import { Suspense, lazy, type CSSProperties } from "react";
import type { ResolvedTheme } from "../shared/types";
import type { CodeTab } from "./app-types";

const EditorSurface = lazy(async () => {
  const module = await import("./EditorSurface");
  return { default: module.EditorSurface };
});

type CodeWorkbenchProps = {
  busy: boolean;
  codeDraft: string;
  codeFilesCount: number;
  codeTitle: string;
  codeTabs: CodeTab[];
  projectReady: boolean;
  selectedCodePath: string;
  style?: CSSProperties;
  themeMode: ResolvedTheme;
  workspacePath: string;
  onChangeCode: (value: string) => void;
  onCloseCodeTab: (path: string) => void;
  onCreateCodeFile: () => void;
  onCloseCanvas: () => void;
  onOpenWorkspace: () => void;
  onSelectCodePath: (path: string) => void;
};

export function CodeWorkbench(props: CodeWorkbenchProps) {
  const hasEditor = Boolean(props.selectedCodePath);

  return (
    <div className="surface-main workbench-main code-canvas-main" style={props.style}>
      <div className={hasEditor ? "code-workbench" : "code-workbench empty"}>
        <div className="workbench-file-header">
          {hasEditor ? (
            <div className="workbench-file-title" title={props.selectedCodePath}>
              {props.codeTitle}
            </div>
          ) : (
            <div />
          )}
          <button
            aria-label="Close code panel"
            className="workbench-close-button"
            onClick={props.onCloseCanvas}
            title="Back to chat"
            type="button"
          >
            <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
              <path
                d="M5.5 5.5 14.5 14.5M14.5 5.5 5.5 14.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.7"
              />
            </svg>
          </button>
        </div>
        <div className="editor-shell workbench-editor">
          {hasEditor ? (
            <Suspense fallback={<div className="empty-state">Loading editor…</div>}>
              <EditorSurface
                onChange={props.onChangeCode}
                path={props.selectedCodePath}
                themeMode={props.themeMode}
                value={props.codeDraft}
                wrap
              />
            </Suspense>
          ) : (
            <div className="code-canvas-blank" />
          )}
        </div>
      </div>
    </div>
  );
}
