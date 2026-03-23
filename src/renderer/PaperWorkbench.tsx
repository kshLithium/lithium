import { Suspense, lazy, type CSSProperties } from "react";
import type { ResolvedTheme } from "../shared/types";
import type { PaperPreviewJump } from "./app-types";

const EditorSurface = lazy(async () => {
  const module = await import("./EditorSurface");
  return { default: module.EditorSurface };
});

const PdfPreviewSurface = lazy(async () => {
  const module = await import("./PdfPreviewSurface");
  return { default: module.PdfPreviewSurface };
});

type PaperWorkbenchProps = {
  busy: boolean;
  jump: PaperPreviewJump | null;
  paperDraft: string;
  paperFocusLine?: number;
  paperPreviewBytes: Uint8Array | null;
  paperTitle: string;
  projectReady: boolean;
  selectedPaperPath: string;
  storageKey: string;
  style?: CSSProperties;
  themeMode: ResolvedTheme;
  onChangePaper: (value: string) => void;
  onNavigateSource: (target: { pageNumber: number; yRatio: number }) => void;
  onResizePreview: () => void;
};

export function PaperWorkbench(props: PaperWorkbenchProps) {
  return (
    <section className="surface-panel paper-surface" style={props.style}>
      <div className="surface-main paper-main workbench-main">
        <div className="workbench-file-header">
          <div className="workbench-file-title" title={props.selectedPaperPath}>
            {props.paperTitle}
          </div>
        </div>

        <div className="editor-shell workbench-editor">
          {props.selectedPaperPath ? (
            <Suspense fallback={<div className="empty-state">Loading editor…</div>}>
              <EditorSurface
                focusLine={props.paperFocusLine}
                onChange={props.onChangePaper}
                path={props.selectedPaperPath}
                themeMode={props.themeMode}
                value={props.paperDraft}
                wrap
              />
            </Suspense>
          ) : (
            <div className="empty-state">Select a LaTeX section to edit it.</div>
          )}
        </div>
      </div>
      <div
        className="pane-resizer"
        onMouseDown={(event) => {
          event.preventDefault();
          props.onResizePreview();
        }}
        role="separator"
      />

      <div className="preview-shell paper-preview-shell">
        <div className="preview-frame">
          {props.paperPreviewBytes ? (
            <Suspense fallback={<div className="empty-state">Loading PDF preview…</div>}>
              <PdfPreviewSurface
                data={props.paperPreviewBytes}
                jumpNonce={props.jump?.nonce}
                jumpTarget={props.jump?.target ?? null}
                key={props.storageKey}
                onNavigateSource={props.onNavigateSource}
                storageKey={props.storageKey}
                themeMode={props.themeMode}
              />
            </Suspense>
          ) : (
            <div className="empty-state">Save the draft to refresh the preview.</div>
          )}
        </div>
      </div>
    </section>
  );
}
