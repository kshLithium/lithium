export type SlashCommandAction = "open-workspace" | "pick-files" | "new-thread";
export type SlashCommandIcon = "bolt" | "search" | "layers" | "brain" | "plus" | "file";
export type SlashCommandSection = "Routing" | "Workspace";

export type SlashCommand = {
  id: string;
  section: SlashCommandSection;
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

export function deriveSlashQuery(value: string) {
  const normalized = value.trimStart();
  const match = normalized.match(/^\/([^\s\r\n]*)$/);
  return match ? match[1].toLowerCase() : null;
}

export function filterSlashCommands(commands: SlashCommand[], query: string | null) {
  if (query === null) {
    return [];
  }

  return commands.filter((command) => matchesSlashCommand(command, query));
}

export function groupSlashCommands(commands: SlashCommand[]) {
  const sections: Array<{ label: SlashCommandSection; commands: SlashCommand[] }> = [];

  for (const command of commands) {
    const lastSection = sections[sections.length - 1];

    if (!lastSection || lastSection.label !== command.section) {
      sections.push({
        label: command.section,
        commands: [command]
      });
      continue;
    }

    lastSection.commands.push(command);
  }

  return sections;
}

export function buildSlashCommands(input: {
  canAttachFiles: boolean;
  canCreateThread: boolean;
  canOpenWorkspace: boolean;
  interactionLocked: boolean;
}): SlashCommand[] {
  return [
    {
      id: "build",
      section: "Routing",
      label: "Build",
      description: "Run a concrete workspace task.",
      badge: "Run",
      icon: "bolt",
      kind: "prompt",
      value: "/build ",
      keywords: ["run", "build", "edit", "files", "workspace"]
    },
    {
      id: "research",
      section: "Routing",
      label: "Research",
      description: "Ask for browsing or analysis first.",
      badge: "Research",
      icon: "search",
      kind: "prompt",
      value: "/research ",
      keywords: ["research", "analysis", "browse", "plan"]
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
      keywords: ["mixed", "plan", "execute", "handoff"]
    },
    {
      id: "plan",
      section: "Routing",
      label: "Plan",
      description: "Stay in planning mode.",
      badge: "Plan",
      icon: "brain",
      kind: "prompt",
      value: "/plan ",
      keywords: ["plan", "planning", "strategy", "next step"]
    },
    {
      id: "workspace",
      section: "Workspace",
      label: input.canOpenWorkspace ? "Folder" : "Open workspace",
      description: "Choose or switch the current workspace.",
      disabled: !input.canOpenWorkspace,
      icon: "file",
      kind: "action",
      action: "open-workspace",
      keywords: ["folder", "workspace", "open", "switch"]
    },
    {
      id: "attach",
      section: "Workspace",
      label: "Attach",
      description: input.canAttachFiles ? "Pick files to attach to this chat." : "Open a workspace first.",
      disabled: !input.canAttachFiles || input.interactionLocked,
      icon: "file",
      kind: "action",
      action: "pick-files",
      keywords: ["attach", "file", "upload"]
    },
    {
      id: "new-thread",
      section: "Workspace",
      label: "New chat",
      description: input.canCreateThread ? "Start a fresh chat." : "Open a workspace first.",
      disabled: !input.canCreateThread,
      icon: "plus",
      kind: "action",
      action: "new-thread",
      keywords: ["thread", "new chat", "conversation"]
    }
  ];
}

export function renderSlashIcon(icon: SlashCommandIcon) {
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
    default:
      return null;
  }
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
