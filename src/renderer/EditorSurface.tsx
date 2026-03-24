import { useEffect, useMemo, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ResolvedTheme } from "../shared/types";
import {
  createEditorCompartments,
  createEditorExtensions,
  resolveEditorThemeExtension,
  resolveLanguageExtension,
  resolveLanguageId,
  resolveReadOnlyExtension,
  type EditorCompartments
} from "./editor/codemirror-runtime";
import { rememberEditorState } from "./editor/state-cache";

type EditorSurfaceProps = {
  path: string;
  themeMode: ResolvedTheme;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  wrap?: boolean;
  focusLine?: number;
};

export function EditorSurface(props: EditorSurfaceProps) {
  const languageId = useMemo(() => resolveLanguageId(props.path), [props.path]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const pathRef = useRef(props.path);
  const externalUpdateRef = useRef(false);
  const onChangeRef = useRef(props.onChange);
  const stateCacheRef = useRef(new Map<string, EditorState>());
  const compartmentsRef = useRef<EditorCompartments>(createEditorCompartments());

  useEffect(() => {
    onChangeRef.current = props.onChange;
  }, [props.onChange]);

  useEffect(() => {
    if (!props.focusLine || !editorRef.current) {
      return;
    }

    const view = editorRef.current;
    const totalLines = view.state.doc.lines;
    const lineNumber = Math.min(Math.max(props.focusLine, 1), totalLines);
    const line = view.state.doc.line(lineNumber);

    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" })
    });
    view.focus();
  }, [props.focusLine, props.path]);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const view = new EditorView({
      state: createEditorState({
        compartments: compartmentsRef.current,
        disabled: props.disabled,
        languageId,
        onChange: (value) => {
          if (!externalUpdateRef.current) {
            onChangeRef.current(value);
          }
        },
        themeMode: props.themeMode,
        value: props.value,
        wrap: props.wrap
      }),
      parent: hostRef.current
    });

    editorRef.current = view;
    pathRef.current = props.path;
    rememberEditorState(stateCacheRef.current, props.path, view.state);

    return () => {
      if (editorRef.current) {
        rememberEditorState(stateCacheRef.current, pathRef.current, editorRef.current.state);
        editorRef.current.destroy();
        editorRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const view = editorRef.current;

    if (!view || pathRef.current === props.path) {
      return;
    }

    rememberEditorState(stateCacheRef.current, pathRef.current, view.state);
    const cachedState = stateCacheRef.current.get(props.path);

    if (cachedState) {
      view.setState(cachedState);
    } else {
      view.setState(
        createEditorState({
          compartments: compartmentsRef.current,
          disabled: props.disabled,
          languageId,
          onChange: (value) => {
            if (!externalUpdateRef.current) {
              onChangeRef.current(value);
            }
          },
          themeMode: props.themeMode,
          value: props.value,
          wrap: props.wrap
        })
      );
    }

    pathRef.current = props.path;
    rememberEditorState(stateCacheRef.current, props.path, view.state);
  }, [languageId, props.disabled, props.path, props.themeMode, props.value, props.wrap]);

  useEffect(() => {
    const view = editorRef.current;

    if (!view) {
      return;
    }

    view.dispatch({
      effects: [
        compartmentsRef.current.language.reconfigure(resolveLanguageExtension(languageId)),
        compartmentsRef.current.readOnly.reconfigure(resolveReadOnlyExtension(Boolean(props.disabled))),
        compartmentsRef.current.theme.reconfigure(resolveEditorThemeExtension(props.themeMode)),
        compartmentsRef.current.wrap.reconfigure(props.wrap ? EditorView.lineWrapping : [])
      ]
    });
    rememberEditorState(stateCacheRef.current, props.path, view.state);
  }, [languageId, props.disabled, props.path, props.themeMode, props.wrap]);

  useEffect(() => {
    const view = editorRef.current;

    if (!view) {
      return;
    }

    const currentValue = view.state.doc.toString();

    if (props.value === currentValue) {
      return;
    }

    externalUpdateRef.current = true;
    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: props.value
      }
    });
    externalUpdateRef.current = false;
    rememberEditorState(stateCacheRef.current, props.path, view.state);
  }, [props.path, props.value]);

  return (
    <div className="editor-surface">
      <div ref={hostRef} />
    </div>
  );
}

function createEditorState(options: {
  compartments: EditorCompartments;
  disabled?: boolean;
  languageId: string;
  onChange: (value: string) => void;
  themeMode: ResolvedTheme;
  value: string;
  wrap?: boolean;
}) {
  return EditorState.create({
    doc: options.value,
    extensions: createEditorExtensions(options.compartments, {
      disabled: options.disabled,
      language: options.languageId,
      onChange: options.onChange,
      themeMode: options.themeMode,
      wrap: options.wrap
    }) as Extension[]
  });
}
