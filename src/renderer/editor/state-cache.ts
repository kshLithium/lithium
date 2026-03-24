import type { EditorState } from "@codemirror/state";

export const MAX_EDITOR_STATE_CACHE_ENTRIES = 12;

export function rememberEditorState(
  cache: Map<string, EditorState>,
  path: string,
  state: EditorState,
  maxEntries = MAX_EDITOR_STATE_CACHE_ENTRIES
) {
  cache.delete(path);
  cache.set(path, state);

  while (cache.size > Math.max(1, maxEntries)) {
    const oldestPath = cache.keys().next().value;

    if (typeof oldestPath !== "string") {
      break;
    }

    cache.delete(oldestPath);
  }
}
