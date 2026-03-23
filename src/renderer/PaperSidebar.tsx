import type { WorkspaceFileRecord } from "../shared/types";
import type { PaperOutlineRow } from "./app-types";
import { formatPaperLabel, normalizePath } from "./app-utils";

type PaperSidebarProps = {
  dirty: boolean;
  outlineRows: PaperOutlineRow[];
  paperFiles: WorkspaceFileRecord[];
  pdfReady: boolean;
  selectedLine?: number;
  selectedPath: string;
  onOpenTarget: (path: string, lineNumber?: number) => void;
};

export function PaperSidebar(props: PaperSidebarProps) {
  const visiblePaperFiles = props.paperFiles.filter(
    (file) => !normalizePath(file.relativePath).endsWith(".pdf")
  );
  const activeFile = props.paperFiles.find((file) => file.path === props.selectedPath) ?? null;
  const activeLabel = activeFile ? formatPaperLabel(activeFile.relativePath) : "No section selected";

  return (
    <div className="paper-sidebar-scroll">
      <section className="paper-sidebar-section paper-sidebar-overview">
        <div className="explorer-heading">Workbench</div>
        <div className="paper-sidebar-card">
          <div className="paper-sidebar-card-label">Current</div>
          <div className="paper-sidebar-card-title">{activeLabel}</div>
          <div className="paper-sidebar-card-meta">
            <span>{visiblePaperFiles.length} files</span>
            <span>{props.outlineRows.length} outline items</span>
          </div>
          <div className="paper-sidebar-status-row">
            <span className={props.pdfReady ? "paper-status-badge ready" : "paper-status-badge pending"}>
              {props.pdfReady ? "Preview" : "Needs build"}
            </span>
            {props.dirty ? <span className="paper-status-badge draft">Unsaved</span> : null}
          </div>
        </div>
      </section>

      <section className="paper-sidebar-section">
        <div className="explorer-heading">Files</div>
        <div className="tree-list" role="tree" aria-label="Paper files">
          {visiblePaperFiles.length ? (
            visiblePaperFiles.map((file) => (
              <button
                key={file.path}
                className={props.selectedPath === file.path ? "tree-row file active" : "tree-row file"}
                onClick={() => props.onOpenTarget(file.path)}
                type="button"
              >
                <span className="tree-file-mark" />
                <span className="tree-label">{formatPaperLabel(file.relativePath)}</span>
              </button>
            ))
          ) : (
            <div className="empty-state rail-empty">No manuscript files indexed yet.</div>
          )}
        </div>
      </section>

      {props.outlineRows.length ? (
        <section className="paper-sidebar-section">
          <div className="explorer-heading">Outline</div>
          <div className="paper-outline" role="list" aria-label="Paper outline">
            {props.outlineRows.map((row) => (
              <button
                key={row.id}
                className={
                  props.selectedLine === row.lineNumber
                    ? `paper-outline-row active ${row.tone ?? ""}`
                    : `paper-outline-row ${row.tone ?? ""}`
                }
                onClick={() => props.onOpenTarget(row.path, row.lineNumber)}
                type="button"
              >
                <span className="paper-outline-label">{row.label}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
