import { useEffect, useRef, useState, type DragEvent } from "react";
import type { AttachmentRecord } from "../shared/types";
import {
  buildSlashCommands,
  deriveSlashQuery,
  filterSlashCommands,
  groupSlashCommands,
  renderSlashIcon,
  type SlashCommand
} from "./composer-slash";

type ComposerProps = {
  attachments: AttachmentRecord[];
  allowWhileBusy?: boolean;
  busy: boolean;
  canAttachFiles: boolean;
  canCreateThread: boolean;
  canOpenWorkspace: boolean;
  placeholder?: string;
  value: string;
  onCreateThread: () => void;
  onDropFiles: (filePaths: string[]) => void;
  onOpenWorkspace: () => void;
  onPickFiles: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onSend: () => void;
  onValueChange: (value: string) => void;
};

export function Composer(props: ComposerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [highlightedCommandId, setHighlightedCommandId] = useState<string | null>(null);
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null);
  const rawSlashQuery = deriveSlashQuery(props.value);

  useEffect(() => {
    if (!dismissedSlashQuery || rawSlashQuery === dismissedSlashQuery) {
      return;
    }

    setDismissedSlashQuery(null);
  }, [dismissedSlashQuery, rawSlashQuery]);

  function extractDroppedPaths(event: DragEvent<HTMLDivElement>) {
    return Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path?.trim() ?? "")
      .filter(Boolean);
  }

  function handleSubmit() {
    if (interactionLocked || !props.value.trim() || rawSlashQuery !== null) {
      return;
    }

    props.onSend();
  }

  const slashQuery =
    inputFocused && rawSlashQuery !== null && rawSlashQuery !== dismissedSlashQuery ? rawSlashQuery : null;
  const showSlashHeadings = slashQuery !== null && slashQuery.length === 0;
  const interactionLocked = props.busy && !props.allowWhileBusy;

  const slashCommands = buildSlashCommands({
    canAttachFiles: props.canAttachFiles,
    canCreateThread: props.canCreateThread,
    canOpenWorkspace: props.canOpenWorkspace,
    interactionLocked
  });
  const filteredSlashCommands = filterSlashCommands(slashCommands, slashQuery);
  const slashCommandSections = groupSlashCommands(filteredSlashCommands);

  const navigableSlashCommands = filteredSlashCommands.filter((command) => !command.disabled);
  const highlightedPool = navigableSlashCommands.length ? navigableSlashCommands : filteredSlashCommands;
  const activeSlashCommandId = highlightedCommandId ?? highlightedPool[0]?.id ?? null;

  useEffect(() => {
    if (!slashQuery) {
      setHighlightedCommandId(null);
      return;
    }

    if (!highlightedPool.length) {
      setHighlightedCommandId(null);
      return;
    }

    if (highlightedCommandId && highlightedPool.some((command) => command.id === highlightedCommandId)) {
      return;
    }

    setHighlightedCommandId(highlightedPool[0]?.id ?? null);
  }, [highlightedCommandId, highlightedPool, slashQuery]);

  function moveHighlightedCommand(delta: number) {
    if (!highlightedPool.length) {
      return;
    }

    const currentIndex = Math.max(
      highlightedPool.findIndex((command) => command.id === highlightedCommandId),
      0
    );
    const nextIndex = (currentIndex + delta + highlightedPool.length) % highlightedPool.length;
    setHighlightedCommandId(highlightedPool[nextIndex]?.id ?? null);
  }

  function applySlashCommand(command: SlashCommand) {
    if (command.disabled) {
      return;
    }

    if (command.kind === "prompt") {
      props.onValueChange(command.value);
      setDismissedSlashQuery(null);

      window.requestAnimationFrame(() => {
        const element = inputRef.current;

        if (!element) {
          return;
        }

        element.focus();
        element.setSelectionRange(command.value.length, command.value.length);
      });
      return;
    }

    props.onValueChange("");
    setDismissedSlashQuery(null);

    switch (command.action) {
      case "open-workspace":
        props.onOpenWorkspace();
        return;
      case "pick-files":
        props.onPickFiles();
        return;
      case "new-thread":
        props.onCreateThread();
        return;
      default:
        return;
    }
  }

  return (
    <div className="composer-shell">
      {slashQuery !== null ? (
        <div
          className={showSlashHeadings ? "composer-slash-menu" : "composer-slash-menu filtered"}
          id="composer-slash-menu"
          role="listbox"
        >
          {slashCommandSections.length ? (
            slashCommandSections.map((section) => (
              <div
                key={section.label}
                className={showSlashHeadings ? "composer-slash-section" : "composer-slash-section flat"}
              >
                {showSlashHeadings ? <div className="composer-slash-heading">{section.label}</div> : null}
                {section.commands.map((command) => {
                  const active = command.id === activeSlashCommandId;

                  return (
                    <button
                      key={command.id}
                      aria-selected={active}
                      className={
                        active
                          ? "composer-slash-item active"
                          : command.disabled
                          ? "composer-slash-item disabled"
                          : "composer-slash-item"
                      }
                      disabled={command.disabled}
                      id={`composer-slash-command-${command.id}`}
                      onClick={() => applySlashCommand(command)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onMouseEnter={() => setHighlightedCommandId(command.id)}
                      role="option"
                      type="button"
                    >
                      <span className="composer-slash-icon">{renderSlashIcon(command.icon)}</span>
                      <span className="composer-slash-copy">
                        <span className="composer-slash-title">{command.label}</span>
                        <span className="composer-slash-description">{command.description}</span>
                      </span>
                      {command.kind === "prompt" && command.badge ? (
                        <span className="composer-slash-badge">{command.badge}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <div className="composer-slash-empty">No slash commands match this query.</div>
          )}
        </div>
      ) : null}
      <div
        className={dragActive ? "composer-card drag-active" : "composer-card"}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();

          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }

          setDragActive(false);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDragActive(true);
        }}
        onDrop={(event) => {
          event.preventDefault();
          const paths = extractDroppedPaths(event);
          setDragActive(false);

          if (!paths.length || interactionLocked) {
            return;
          }

          props.onDropFiles(paths);
        }}
      >
        <input
          aria-activedescendant={activeSlashCommandId ? `composer-slash-command-${activeSlashCommandId}` : undefined}
          aria-controls={slashQuery !== null ? "composer-slash-menu" : undefined}
          aria-expanded={slashQuery !== null}
          aria-label="Chat prompt"
          className="composer-input"
          disabled={interactionLocked}
          onBlur={() => setInputFocused(false)}
          onChange={(event) => props.onValueChange(event.target.value)}
          onFocus={() => setInputFocused(true)}
          onKeyDown={(event) => {
            const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean };

            if (slashQuery !== null) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveHighlightedCommand(1);
                return;
              }

              if (event.key === "ArrowUp") {
                event.preventDefault();
                moveHighlightedCommand(-1);
                return;
              }

              if (event.key === "Enter" || event.key === "Tab") {
                const nextCommand =
                  highlightedPool.find((command) => command.id === activeSlashCommandId) ??
                  highlightedPool[0] ??
                  null;

                if (!nextCommand) {
                  return;
                }

                event.preventDefault();
                applySlashCommand(nextCommand);
                return;
              }

              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedSlashQuery(rawSlashQuery);
                return;
              }
            }

            if (event.key !== "Enter" || event.shiftKey || nativeEvent.isComposing) {
              return;
            }

            event.preventDefault();
            handleSubmit();
          }}
          placeholder={props.placeholder ?? "Ask, steer, or inspect."}
          ref={inputRef}
          type="text"
          value={props.value}
        />

          {props.attachments.length ? (
            <div className="composer-attachments">
              {props.attachments.map((attachment) => (
              <div key={attachment.id} className="composer-attachment-chip">
                <span className="composer-attachment-kind">{attachment.kind}</span>
                <span className="composer-attachment-name" title={attachment.relativePath}>
                  {attachment.relativePath}
                </span>
                <button
                  aria-label={`Remove ${attachment.relativePath}`}
                  className="composer-attachment-remove"
                  disabled={interactionLocked}
                  onClick={() => props.onRemoveAttachment(attachment.id)}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
