import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { shell as shellMode } from "@codemirror/legacy-modes/mode/shell";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { ResolvedTheme } from "../../shared/types";

type EditorRuntimeOptions = {
  disabled?: boolean;
  language: string;
  onChange: (value: string) => void;
  themeMode: ResolvedTheme;
  wrap?: boolean;
};

export type EditorCompartments = {
  language: Compartment;
  readOnly: Compartment;
  theme: Compartment;
  wrap: Compartment;
};

const editorThemeSpec = {
  "&": {
    height: "100%",
    color: "var(--editor-text)",
    backgroundColor: "transparent",
    fontSize: "11.5px"
  },
  "&.cm-focused": {
    outline: "none"
  },
  ".cm-scroller": {
    minHeight: "100%",
    overflow: "auto",
    fontFamily: "SF Mono, JetBrains Mono, monospace",
    lineHeight: "18px"
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "16px 0",
    caretColor: "var(--editor-caret)"
  },
  ".cm-line": {
    padding: "0 16px"
  },
  ".cm-gutters": {
    border: "none",
    backgroundColor: "transparent",
    color: "var(--editor-gutter)"
  },
  ".cm-activeLineGutter": {
    color: "var(--editor-gutter-active)"
  },
  ".cm-activeLine": {
    backgroundColor: "var(--editor-active-line)"
  },
  ".cm-selectionBackground": {
    backgroundColor: "var(--editor-selection) !important"
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--editor-caret)"
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--editor-search)",
    outline: "1px solid var(--editor-search-border)"
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--editor-selection)"
  },
  ".cm-panels": {
    backgroundColor: "var(--editor-panel)",
    color: "var(--editor-text)"
  },
  ".cm-panel": {
    borderBottom: "1px solid var(--border)"
  },
  ".cm-textfield": {
    borderRadius: "10px",
    border: "1px solid var(--border-strong)",
    backgroundColor: "var(--editor-input)"
  },
  ".cm-button": {
    borderRadius: "999px",
    border: "1px solid var(--border)",
    backgroundColor: "var(--editor-button)"
  }
};

const lightEditorTheme = EditorView.theme(
  {
    ...editorThemeSpec
  },
  { dark: false }
);

const darkEditorTheme = EditorView.theme(
  {
    ...editorThemeSpec
  },
  { dark: true }
);

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "var(--editor-token-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--editor-token-string)" },
  { tag: [tags.number, tags.integer, tags.float], color: "var(--editor-token-number)" },
  { tag: [tags.comment, tags.lineComment], color: "var(--editor-token-comment)", fontStyle: "italic" },
  { tag: [tags.variableName, tags.propertyName], color: "var(--editor-token-variable)" },
  { tag: [tags.definition(tags.variableName), tags.typeName], color: "var(--editor-token-type)" },
  { tag: [tags.heading, tags.emphasis, tags.strong], color: "var(--editor-token-heading)" },
  { tag: [tags.link, tags.url], color: "var(--editor-token-link)" },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: "var(--editor-token-punctuation)" }
]);

const csvLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) {
      return null;
    }

    if (stream.match(/"([^"]|"")*"?/)) {
      return "string";
    }

    if (stream.match(/[;,]/) || stream.match(/\t/)) {
      return "separator";
    }

    if (stream.match(/[+-]?\d+(\.\d+)?/)) {
      return "number";
    }

    stream.next();
    stream.eatWhile(/[^,;\t\r\n]/);
    return "variableName";
  }
});

export function createEditorCompartments(): EditorCompartments {
  return {
    language: new Compartment(),
    readOnly: new Compartment(),
    theme: new Compartment(),
    wrap: new Compartment()
  };
}

export function createEditorExtensions(
  compartments: EditorCompartments,
  options: EditorRuntimeOptions
): Extension[] {
  return [
    basicSetup,
    compartments.theme.of(resolveEditorThemeExtension(options.themeMode)),
    syntaxHighlighting(highlightStyle),
    EditorView.contentAttributes.of({
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off"
    }),
    compartments.language.of(resolveLanguageExtension(options.language)),
    compartments.readOnly.of(resolveReadOnlyExtension(Boolean(options.disabled))),
    compartments.wrap.of(options.wrap ? EditorView.lineWrapping : []),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        options.onChange(update.state.doc.toString());
      }
    })
  ];
}

export function resolveLanguageId(filePath: string) {
  const extension = filePath.split(".").pop()?.toLowerCase();

  switch (extension) {
    case "py":
      return "python";
    case "json":
      return "json";
    case "csv":
    case "tsv":
      return "csv";
    case "md":
      return "markdown";
    case "sh":
    case "zsh":
    case "bash":
      return "shell";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return "plaintext";
  }
}

export function resolveLanguageExtension(language: string): Extension {
  switch (language) {
    case "python":
      return python();
    case "json":
      return json();
    case "csv":
      return csvLanguage;
    case "markdown":
      return markdown();
    case "shell":
      return StreamLanguage.define(shellMode);
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

export function resolveReadOnlyExtension(disabled: boolean): Extension {
  return [EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)];
}

export function resolveEditorThemeExtension(themeMode: ResolvedTheme): Extension {
  return themeMode === "dark" ? darkEditorTheme : lightEditorTheme;
}
