import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedTheme, WorkspaceFileDiff, WorkspaceFileRecord } from "../shared/types";

const EditorSurface = lazy(async () => {
  const module = await import("./EditorSurface");
  return { default: module.EditorSurface };
});

const PdfPreviewSurface = lazy(async () => {
  const module = await import("./PdfPreviewSurface");
  return { default: module.PdfPreviewSurface };
});

type ArtifactInspectorProps = {
  changedFiles: string[];
  file: WorkspaceFileRecord | null;
  themeMode: ResolvedTheme;
  workspacePath: string;
  onClose: () => void;
  onOpenWorkbench?: () => void;
  onRefresh: () => Promise<void>;
};

export function ArtifactInspector(props: ArtifactInspectorProps) {
  const file = props.file;
  const lowerPath = file?.relativePath.toLowerCase() ?? "";
  const isPdf = file?.artifactKind === "pdf" || lowerPath.endsWith(".pdf");
  const isImage = file?.artifactKind === "image";
  const isCsv = file?.artifactKind === "csv";
  const canEdit =
    Boolean(file) &&
    !isPdf &&
    !isImage &&
    !isCsv &&
    (file?.kind === "code" ||
      file?.kind === "paper" ||
      ["text", "json", "tex", "bib", "log", "other"].includes(file?.artifactKind ?? "other"));
  const diffEligible = Boolean(file) && !isPdf && !isImage && !isCsv;
  const changedFile = file ? props.changedFiles.some((entry) => matchesChangedFile(file, entry)) : false;
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textValue, setTextValue] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [bytesValue, setBytesValue] = useState<Uint8Array | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [diffValue, setDiffValue] = useState<WorkspaceFileDiff | null>(null);
  const [viewMode, setViewMode] = useState<"diff" | "file">("file");
  const dirtyRef = useRef(false);
  const loadedFilePathRef = useRef("");
  const loadRequestRef = useRef(0);
  const dirty = canEdit && textValue !== savedValue;
  const hasRenderableDiff = Boolean(
    diffEligible &&
      diffValue &&
      diffValue.status !== "clean" &&
      diffValue.status !== "unavailable" &&
      diffValue.diffText.trim()
  );

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    if (!blobUrl) {
      return;
    }

    return () => {
      URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  useEffect(() => {
    if (!file || !props.workspacePath) {
      loadedFilePathRef.current = "";
      loadRequestRef.current += 1;
      setTextValue("");
      setSavedValue("");
      setBytesValue(null);
      setError(null);
      setBlobUrl(null);
      setDiffValue(null);
      setViewMode("file");
      return;
    }

    let cancelled = false;
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    const targetPath = file.path;
    const shouldReloadTextValue = !canEdit || targetPath !== loadedFilePathRef.current || !dirtyRef.current;
    const showLoadingState = shouldReloadTextValue || isPdf || isImage;

    const load = async () => {
      setLoading(showLoadingState);
      setError(null);

      try {
        const diffPromise =
          diffEligible && changedFile && typeof window.lithium.readWorkspaceDiff === "function"
            ? window.lithium.readWorkspaceDiff({
                workspacePath: props.workspacePath,
                path: targetPath
              })
            : Promise.resolve(null);

        if (isPdf || isImage) {
          const [bytes, nextDiff] = await Promise.all([
            window.lithium.readWorkspaceFileBytes({
              workspacePath: props.workspacePath,
              path: targetPath
            }),
            diffPromise
          ]);

          if (cancelled || loadRequestRef.current !== requestId) {
            return;
          }

          const normalized = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          loadedFilePathRef.current = "";
          setBytesValue(normalized);
          setDiffValue(nextDiff);
          setTextValue("");
          setSavedValue("");

          if (isImage) {
            const blobSource = normalized.slice().buffer as ArrayBuffer;
            const nextUrl = URL.createObjectURL(
              new Blob([blobSource], { type: guessImageMimeType(file.relativePath) })
            );
            setBlobUrl((current) => {
              if (current) {
                URL.revokeObjectURL(current);
              }
              return nextUrl;
            });
          } else {
            setBlobUrl((current) => {
              if (current) {
                URL.revokeObjectURL(current);
              }
              return null;
            });
          }

          return;
        }

        const [nextFile, nextDiff] = await Promise.all([
          shouldReloadTextValue
            ? window.lithium.readWorkspaceFile({
                workspacePath: props.workspacePath,
                path: targetPath
              })
            : Promise.resolve(null),
          diffPromise
        ]);

        if (cancelled || loadRequestRef.current !== requestId) {
          return;
        }

        if (nextFile) {
          loadedFilePathRef.current = targetPath;
          setTextValue(nextFile.content);
          setSavedValue(nextFile.content);
        }

        setBytesValue(null);
        setDiffValue(nextDiff);
        setBlobUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return null;
        });
      } catch (nextError) {
        if (!cancelled && loadRequestRef.current === requestId) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));

          if (!(canEdit && dirtyRef.current && targetPath === loadedFilePathRef.current)) {
            loadedFilePathRef.current = "";
            setTextValue("");
            setSavedValue("");
            setBytesValue(null);
          }

          setDiffValue(null);
        }
      } finally {
        if (!cancelled && loadRequestRef.current === requestId) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [changedFile, diffEligible, file, isImage, isPdf, props.workspacePath]);

  useEffect(() => {
    if (!file) {
      setViewMode("file");
      return;
    }

    if (diffEligible && changedFile) {
      setViewMode("diff");
      return;
    }

    setViewMode("file");
  }, [changedFile, diffEligible, file?.path]);

  useEffect(() => {
    if (viewMode === "diff" && !hasRenderableDiff) {
      setViewMode("file");
    }
  }, [hasRenderableDiff, viewMode]);

  const table = useMemo(
    () => (isCsv ? parseDelimitedText(textValue, lowerPath.endsWith(".tsv") ? "\t" : ",") : null),
    [isCsv, lowerPath, textValue]
  );

  async function handleSave() {
    if (!file || !canEdit || !dirty) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const saved = await window.lithium.saveWorkspaceFile({
        workspacePath: props.workspacePath,
        path: file.path,
        content: textValue
      });
      loadedFilePathRef.current = file.path;
      setTextValue(saved.content);
      setSavedValue(saved.content);
      await props.onRefresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  }

  async function handleCompilePaper() {
    if (!file || file.kind !== "paper" || isPdf) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (dirty) {
        await handleSave();
      }

      await window.lithium.compilePaper(props.workspacePath);
      await props.onRefresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="artifact-inspector-shell">
      <div className="artifact-inspector-header">
        <div className="artifact-inspector-copy">
          <div className="artifact-inspector-title">
            {file ? file.name : "Inspector"}
          </div>
          <div className="artifact-inspector-path">{file?.relativePath ?? "Open a file from chat."}</div>
        </div>
        <div className="artifact-inspector-actions">
          {hasRenderableDiff ? (
            <div className="artifact-inspector-toggle" role="tablist" aria-label="Artifact view">
              <button
                className={`artifact-inspector-button ${viewMode === "diff" ? "primary" : ""}`}
                onClick={() => setViewMode("diff")}
                type="button"
              >
                Git diff
              </button>
              <button
                className={`artifact-inspector-button ${viewMode === "file" ? "primary" : ""}`}
                onClick={() => setViewMode("file")}
                type="button"
              >
                File
              </button>
            </div>
          ) : null}
          {props.onOpenWorkbench && file ? (
            <button className="artifact-inspector-button" onClick={props.onOpenWorkbench} type="button">
              Open full view
            </button>
          ) : null}
          {canEdit ? (
            <button
              className="artifact-inspector-button primary"
              disabled={!dirty || saving}
              onClick={() => void handleSave()}
              type="button"
            >
              Save
            </button>
          ) : null}
          {file?.kind === "paper" && !isPdf ? (
            <button
              className="artifact-inspector-button"
              disabled={saving}
              onClick={() => void handleCompilePaper()}
              type="button"
            >
              Compile
            </button>
          ) : null}
          <button className="artifact-inspector-button" onClick={props.onClose} type="button">
            Close
          </button>
        </div>
      </div>

      {error ? <div className="artifact-inspector-error">{error}</div> : null}

      <div className="artifact-inspector-body">
        {!file ? <div className="empty-state">Open a run artifact, file, or manuscript section from chat.</div> : null}
        {file && loading ? <div className="empty-state">Loading…</div> : null}
        {file && !loading && viewMode === "diff" && hasRenderableDiff && diffValue ? (
          <DiffPreview diff={diffValue} />
        ) : null}
        {file && !loading && isImage && blobUrl ? (
          <div className="artifact-image-frame">
            <img alt={file.name} className="artifact-image" src={blobUrl} />
          </div>
        ) : null}
        {file && !loading && isPdf && bytesValue ? (
          <div className="artifact-pdf-frame">
            <Suspense fallback={<div className="empty-state">Loading PDF preview…</div>}>
              <PdfPreviewSurface data={bytesValue} storageKey={file.path} themeMode={props.themeMode} />
            </Suspense>
          </div>
        ) : null}
        {file && !loading && isCsv && table ? (
          <div className="artifact-table-shell">
            <div className="artifact-table-meta">
              {table.rows.length} rows · {table.headers.length} columns
            </div>
            <div className="artifact-table-scroll">
              <table className="artifact-table">
                <thead>
                  <tr>
                    {table.headers.map((header, index) => (
                      <th key={`${header}:${index}`}>{header || `col_${index + 1}`}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.slice(0, 80).map((row, rowIndex) => (
                    <tr key={`${rowIndex}:${row.join("|")}`}>
                      {table.headers.map((_, columnIndex) => (
                        <td key={`${rowIndex}:${columnIndex}`}>{row[columnIndex] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {file && !loading && viewMode === "file" && !isImage && !isPdf && !isCsv ? (
          <div className="artifact-editor-shell">
            <Suspense fallback={<div className="empty-state">Loading editor…</div>}>
              <EditorSurface
                disabled={!canEdit}
                onChange={setTextValue}
                path={file.relativePath}
                themeMode={props.themeMode}
                value={textValue}
                wrap={file.kind !== "code"}
              />
            </Suspense>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function DiffPreview(props: { diff: WorkspaceFileDiff }) {
  const lines = props.diff.diffText.split("\n");
  const summary = summarizeDiff(props.diff.diffText);

  return (
    <div className="artifact-diff-shell">
      <div className="artifact-diff-meta">
        <span>Git diff</span>
        <span>{props.diff.relativePath}</span>
        {summary ? <span>{summary}</span> : null}
      </div>
      <div className="artifact-diff-scroll">
        {lines.map((line, index) => (
          <div key={`${index}:${line}`} className={`artifact-diff-line ${diffLineClassName(line)}`}>
            <span className="artifact-diff-marker" aria-hidden="true">
              {diffLineMarker(line)}
            </span>
            <code>{line}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function parseDelimitedText(input: string, separator: string) {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentValue = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        currentValue += "\"";
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === separator) {
      currentRow.push(currentValue);
      currentValue = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      currentRow.push(currentValue);
      rows.push(currentRow);
      currentRow = [];
      currentValue = "";
      continue;
    }

    currentValue += char;
  }

  if (currentValue.length || currentRow.length) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  const headers = rows[0] ?? [];
  return {
    headers,
    rows: rows.slice(1)
  };
}

function matchesChangedFile(file: WorkspaceFileRecord, value: string) {
  const normalizedFilePath = normalizeFilePath(file.path);
  const normalizedRelativePath = normalizeFilePath(file.relativePath);
  const normalizedValue = normalizeFilePath(value);

  return (
    normalizedValue === normalizedFilePath ||
    normalizedValue === normalizedRelativePath ||
    normalizedValue.endsWith(`/${normalizedRelativePath}`)
  );
}

function normalizeFilePath(value: string) {
  return value.replaceAll("\\", "/");
}

function summarizeDiff(diffText: string) {
  let added = 0;
  let removed = 0;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    if (line.startsWith("+")) {
      added += 1;
      continue;
    }

    if (line.startsWith("-")) {
      removed += 1;
    }
  }

  if (!added && !removed) {
    return "";
  }

  return `+${added} -${removed}`;
}

function diffLineClassName(line: string) {
  if (line.startsWith("@@")) {
    return "hunk";
  }

  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "meta";
  }

  if (line.startsWith("+")) {
    return "added";
  }

  if (line.startsWith("-")) {
    return "removed";
  }

  return "context";
}

function diffLineMarker(line: string) {
  if (line.startsWith("@@")) {
    return "@@";
  }

  if (line.startsWith("+")) {
    return "+";
  }

  if (line.startsWith("-")) {
    return "-";
  }

  return " ";
}

function guessImageMimeType(relativePath: string) {
  const normalized = relativePath.toLowerCase();

  if (normalized.endsWith(".png")) {
    return "image/png";
  }

  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (normalized.endsWith(".gif")) {
    return "image/gif";
  }

  if (normalized.endsWith(".webp")) {
    return "image/webp";
  }

  if (normalized.endsWith(".svg")) {
    return "image/svg+xml";
  }

  return "application/octet-stream";
}
