import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import type { AttachmentRecord } from "../shared/types";
import { TERMINAL_FEATURE_ENABLED, WORKBENCH_SURFACES_ENABLED } from "../shared/feature-flags";

type ComposerProps = {
  attachments: AttachmentRecord[];
  canCreateThread: boolean;
  canOpenCode: boolean;
  canOpenPaper: boolean;
  canToggleTerminal: boolean;
  compact?: boolean;
  busy: boolean;
  placeholder?: string;
  value: string;
  onCreateThread: () => void;
  onDropFiles: (filePaths: string[]) => void;
  onOpenChatSurface: () => void;
  onOpenCodeSurface: () => void;
  onOpenPaperSurface: () => void;
  onOpenSettings: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onSend: () => void;
  onToggleTerminal: () => void;
  onValueChange: (value: string) => void;
};

type SlashCommandAction =
  | "open-chat"
  | "open-code"
  | "open-paper"
  | "toggle-terminal"
  | "open-settings"
  | "new-thread";

type SlashCommandIcon =
  | "bolt"
  | "search"
  | "layers"
  | "code"
  | "file"
  | "chat"
  | "terminal"
  | "settings"
  | "model"
  | "brain"
  | "plus";

type SlashCommand = {
  id: string;
  section: "Routing" | "Workspace" | "Settings";
  label: string;
  description: string;
  badge?: string;
  disabled?: boolean;
  keywords: string[];
  icon: SlashCommandIcon;
} & (
  | {
      kind: "prompt";
      value: string;
    }
  | {
      kind: "action";
      action: SlashCommandAction;
    }
);

function deriveSlashQuery(value: string) {
  const normalized = value.trimStart();
  const match = normalized.match(/^\/([^\s\r\n]*)$/);
  return match ? match[1].toLowerCase() : null;
}

function formatOptionBadge(value: string) {
  return value
    .replace(/^gpt/i, "GPT")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function matchesSlashCommand(command: SlashCommand, query: string) {
  if (!query) {
    return true;
  }

  const haystack = [
    command.id,
    command.label,
    command.description,
    command.badge ?? "",
    ...command.keywords
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function renderSlashIcon(icon: SlashCommandIcon) {
  switch (icon) {
    case "bolt":
      return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
          <path
            d="M11.1 2.3 4.9 10h3.6L7.7 17.7 15.1 9.9h-3.7l-.3-7.6Z"
            fill="currentColor"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="0.8"
          />
        </svg>
      );
    case "search":
      return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
          <path
            d="M8.4 3.7a4.7 4.7 0 1 0 0 9.4 4.7 4.7 0 0 0 0-9.4Zm6.2 10.9-2.5-2.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </svg>
      );
    case "layers":
      return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
          <path
            d="m10 3.5 5.8 3.3L10 10.1 4.2 6.8 10 3.5Zm-5.8 6.6L10 13.4l5.8-3.3M4.2 13.3 10 16.5l5.8-3.2"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      );
    case "code":
      return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
          <path
            d="m7.1 5.2-4.2 4.7 4.2 4.9m5.8-9.6 4.2 4.7-4.2 4.9M11.4 3.6l-2.8 12.8"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      );
    case "file":
      return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
          <path
            d="M6.1 2.9h5.1l3 3v9.2a1.8 1.8 0 0 1-1.8 1.8H6.1a1.8 1.8 0 0 1-1.8-1.8V4.7a1.8 1.8 0 0 1 1.8-1.8Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <path
            d="M11.2 2.9v3h3"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      );
    case "chat":
      return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
          <path
            d="M4.9 5.1h10.2a2 2 0 0 1 2 2v5.3a2 2 0 0 1-2 2H9l-3.4 2.3.6-2.3H4.9a2 2 0 0 1-2-2V7.1a2 2 0 0 1 2-2Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      );
    case "terminal":
      return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
          <path
            d="M3.2 4.5h13.6a1.3 1.3 0 0 1 1.3 1.3v8.4a1.3 1.3 0 0 1-1.3 1.3H3.2A1.3 1.3 0 0 1 1.9 14.2V5.8a1.3 1.3 0 0 1 1.3-1.3Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <path
            d="m5.5 8 2 2-2 2M10 12h4"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      );
    case "settings":
      return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
          <path
            d="M8.4 3.3h3.2l.5 1.7c.2.5.6.9 1.1 1l1.7.5v3.2l-1.7.5c-.5.1-.9.5-1.1 1l-.5 1.7H8.4l-.5-1.7c-.2-.5-.6-.9-1.1-1l-1.7-.5V6.5l1.7-.5c.5-.1.9-.5 1.1-1l.5-1.7Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.7" />
        </svg>
      );
    case "model":
      return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
          <path
            d="m10 2.6 6.1 3.5v7L10 16.6l-6.1-3.5v-7L10 2.6Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <path
            d="M3.9 6.1 10 9.6l6.1-3.5M10 9.6v7"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      );
    case "brain":
      return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
          <path
            d="M7.4 4.1a2.8 2.8 0 0 0-4 4 2.9 2.9 0 0 0 .5 5.6h3.2m5.5-9.6a2.8 2.8 0 0 1 4 4 2.9 2.9 0 0 1-.5 5.6h-3.2M10 3.5v13M7 7.4c1 0 1.8.8 1.8 1.8S8 11 7 11m6-3.6c-1 0-1.8.8-1.8 1.8S12 11 13 11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      );
    case "plus":
      return (
        <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
          <path
            d="M10 4.1v11.8M4.1 10h11.8"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.8"
          />
        </svg>
      );
    default:
      return null;
  }
}

export function Composer(props: ComposerProps) {
  const { compact = false } = props;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) {
      return;
    }

    const computedStyles = window.getComputedStyle(element);
    const minHeight = Number.parseFloat(computedStyles.minHeight) || (compact ? 56 : 60);
    const maxHeight =
      Number.parseFloat(computedStyles.maxHeight) || Number.POSITIVE_INFINITY;

    element.style.height = "0px";
    const nextHeight = Math.min(Math.max(element.scrollHeight, minHeight), maxHeight);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [compact, props.value]);

  function extractDroppedPaths(event: DragEvent<HTMLDivElement>) {
    return Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path?.trim() ?? "")
      .filter(Boolean);
  }

  const slashQuery =
    inputFocused && rawSlashQuery !== null && rawSlashQuery !== dismissedSlashQuery ? rawSlashQuery : null;
  const showSlashHeadings = slashQuery !== null && slashQuery.length === 0;
  const sendDisabled = props.busy || !props.value.trim() || rawSlashQuery !== null;

  const slashCommands: SlashCommand[] = [
    {
      id: "build",
      section: "Routing",
      label: "Build",
      description: "Send directly to the builder.",
      badge: "Builder",
      icon: "bolt",
      kind: "prompt",
      value: "/build ",
      keywords: ["builder", "code", "edit", "files", "workspace"]
    },
    {
      id: "research",
      section: "Routing",
      label: "Research",
      description: "Ask the strategist first.",
      badge: "Strategist",
      icon: "search",
      kind: "prompt",
      value: "/research ",
      keywords: ["strategist", "analysis", "research", "planning"]
    },
    {
      id: "mixed",
      section: "Routing",
      label: "Mixed",
      description: "Plan first, then execute.",
      badge: "Mixed",
      icon: "layers",
      kind: "prompt",
      value: "/mixed ",
      keywords: ["mixed", "strategist", "builder", "handoff"]
    },
    {
      id: "plan",
      section: "Routing",
      label: "Plan",
      description: "Ask the strategist for a planning-only pass.",
      badge: "Strategist",
      icon: "brain",
      kind: "prompt",
      value: "/plan ",
      keywords: ["plan", "planning", "strategy", "next step"]
    },
    ...(WORKBENCH_SURFACES_ENABLED
      ? ([
          {
            id: "code-panel",
            section: "Workspace",
            label: "Code",
            description: props.canOpenCode
              ? "Open the code workbench."
              : "Open a workspace first.",
            disabled: !props.canOpenCode,
            icon: "code",
            kind: "action",
            action: "open-code",
            keywords: ["code", "editor", "canvas", "files", "workbench"]
          },
          {
            id: "paper-panel",
            section: "Workspace",
            label: "Paper",
            description: props.canOpenPaper
              ? "Open the manuscript workbench."
              : "No manuscript is ready yet.",
            disabled: !props.canOpenPaper,
            icon: "file",
            kind: "action",
            action: "open-paper",
            keywords: ["paper", "latex", "tex", "manuscript", "preview"]
          }
        ] satisfies SlashCommand[])
      : []),
    {
      id: "chat-view",
      section: "Workspace",
      label: "Chat",
      description: "Close side surfaces.",
      icon: "chat",
      kind: "action",
      action: "open-chat",
      keywords: ["chat", "surface", "close panels", "home"]
    },
    {
      id: "new-thread",
      section: "Workspace",
      label: "New chat",
      description: props.canCreateThread
        ? "Start a fresh chat."
        : "Open a workspace first.",
      disabled: !props.canCreateThread,
      icon: "plus",
      kind: "action",
      action: "new-thread",
      keywords: ["thread", "new chat", "conversation"]
    },
    ...(TERMINAL_FEATURE_ENABLED && props.canToggleTerminal
      ? ([
          {
            id: "terminal",
            section: "Workspace",
            label: "Terminal",
            description: "Toggle the shell.",
            icon: "terminal",
            kind: "action",
            action: "toggle-terminal",
            keywords: ["terminal", "logs", "shell", "panel"]
          }
        ] satisfies SlashCommand[])
      : []),
    {
      id: "settings",
      section: "Settings",
      label: "Settings",
      description: "Theme, models, and tools.",
      icon: "settings",
      kind: "action",
      action: "open-settings",
      keywords: ["settings", "theme", "models", "preferences"]
    }
  ];

  const filteredSlashCommands =
    slashQuery === null ? [] : slashCommands.filter((command) => matchesSlashCommand(command, slashQuery));
  const slashCommandSections: Array<{ label: SlashCommand["section"]; commands: SlashCommand[] }> = [];

  for (const command of filteredSlashCommands) {
    const lastSection = slashCommandSections[slashCommandSections.length - 1];

    if (!lastSection || lastSection.label !== command.section) {
      slashCommandSections.push({
        label: command.section,
        commands: [command]
      });
      continue;
    }

    lastSection.commands.push(command);
  }

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
        const element = textareaRef.current;

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
      case "open-chat":
        props.onOpenChatSurface();
        return;
      case "open-code":
        props.onOpenCodeSurface();
        return;
      case "open-paper":
        props.onOpenPaperSurface();
        return;
      case "toggle-terminal":
        props.onToggleTerminal();
        return;
      case "open-settings":
        props.onOpenSettings();
        return;
      case "new-thread":
        props.onCreateThread();
        return;
      default:
        return;
    }
  }

  return (
    <div className={`composer-shell${compact ? " compact" : ""}`}>
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
          const filePaths = extractDroppedPaths(event);
          setDragActive(false);

          if (!filePaths.length || props.busy) {
            return;
          }

          props.onDropFiles(filePaths);
        }}
      >
        <textarea
          aria-activedescendant={activeSlashCommandId ? `composer-slash-command-${activeSlashCommandId}` : undefined}
          aria-controls={slashQuery !== null ? "composer-slash-menu" : undefined}
          aria-expanded={slashQuery !== null}
          className="composer-input"
          disabled={props.busy}
          onChange={(event) => props.onValueChange(event.target.value)}
          onBlur={() => setInputFocused(false)}
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
                  highlightedPool.find((command) => command.id === activeSlashCommandId) ?? highlightedPool[0] ?? null;

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

            if (sendDisabled) {
              return;
            }

            props.onSend();
          }}
          ref={textareaRef}
          rows={1}
          placeholder={props.placeholder ?? "Ask, steer, or inspect."}
          value={props.value}
        />

        {props.attachments.length ? (
          <div className="composer-attachments">
            {props.attachments.map((attachment) => (
              <div key={attachment.id} className="composer-attachment-chip">
                <span className="composer-attachment-kind">{attachment.kind}</span>
                <span className="composer-attachment-name">{attachment.name}</span>
                <button
                  aria-label={`Remove ${attachment.name}`}
                  className="composer-attachment-remove"
                  disabled={props.busy}
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
