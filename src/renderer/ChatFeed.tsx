import { memo, useMemo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { ChatArtifactRef, ChatItem } from "./app-types";
import { formatTime } from "./app-utils";

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

type MarkdownAnchorProps = ComponentPropsWithoutRef<"a"> & {
  href?: string;
  node?: unknown;
};

function normalizeMathMarkdown(value: string) {
  return value
    .split(/(```[\s\S]*?```)/g)
    .map((block) => {
      if (block.startsWith("```")) {
        return block;
      }

      return block
        .split(/(`[^`\n]+`|!?\[[^\]]+\]\([^\n)]+\))/g)
        .map((segment) => {
          if (
            (segment.startsWith("`") && segment.endsWith("`")) ||
            /^!?\[[^\]]+\]\([^\n)]+\)$/.test(segment)
          ) {
            return segment;
          }

          return segment
            .replace(/\\\[((?:\\.|[\s\S])*?)\\\]/g, (_match, math: string) => {
              const trimmed = math.trim();
              return trimmed ? `\n\n$$\n${trimmed}\n$$\n\n` : _match;
            })
            .replace(/\\\(((?:\\.|[\s\S])*?)\\\)/g, (_match, math: string) => {
              const trimmed = math.trim();
              return trimmed ? `$${trimmed}$` : _match;
            })
            .replace(
              /(^|\n)\[\s*([\s\S]*?(?:\\[A-Za-z]+|[_^]|\\neq|\\sum|\\frac|\\min|\\max)[\s\S]*?)\s*\](?=\n|$)/g,
              (_match, prefix: string, math: string) => {
                const trimmed = math.trim();
                return trimmed ? `${prefix}\n$$\n${trimmed}\n$$` : _match;
              }
            )
            .replace(
              /\(([^()\n]*(?:\\[A-Za-z]+|[_^]|\\neq|\\sum|\\frac|\\min|\\max)[^()\n]*)\)/g,
              (_match, math: string) => {
                const trimmed = math.trim();
                return trimmed ? `$${trimmed}$` : _match;
              }
            );
        })
        .join("");
    })
    .join("");
}

function normalizeFileReferenceMarkdown(value: string) {
  return value.replace(
    /\[([^\]]+)\]((?:\/[A-Za-z0-9._-]+)+(?:#L\d+(?:C\d+)?)?)/g,
    (_match, label: string, target: string) => {
      const trailingPunctuation = /[.,!?]$/.test(target) ? target.slice(-1) : "";
      const href = trailingPunctuation ? target.slice(0, -1) : target;
      return `[${label}](${href})${trailingPunctuation}`;
    }
  );
}

function normalizeChatMarkdown(value: string) {
  return normalizeFileReferenceMarkdown(normalizeMathMarkdown(value));
}

export function resolveArtifactLinkTarget(href?: string, workspacePath?: string) {
  const normalizedHref = href?.trim();
  const normalizedWorkspacePath = workspacePath?.trim();

  if (!normalizedHref?.startsWith("/") || !normalizedWorkspacePath) {
    return null;
  }

  const path = normalizedHref.split("#", 1)[0];

  if (!path) {
    return null;
  }

  return path === normalizedWorkspacePath || path.startsWith(`${normalizedWorkspacePath}/`) ? path : null;
}

function createMarkdownComponents(onOpenArtifact?: (path: string) => void, workspacePath?: string) {
  return {
    a({ node: _node, href, onClick, ...props }: MarkdownAnchorProps) {
      const artifactPath = resolveArtifactLinkTarget(href, workspacePath);

      return (
        <a
          {...props}
          href={href}
          onClick={(event) => {
            onClick?.(event);

            if (event.defaultPrevented || !artifactPath) {
              return;
            }

            if (!onOpenArtifact) {
              event.preventDefault();
              return;
            }

            event.preventDefault();
            onOpenArtifact(artifactPath);
          }}
          rel={artifactPath ? undefined : "noreferrer"}
          target={artifactPath ? undefined : "_blank"}
        />
      );
    }
  };
}

type ChatMessageProps = ChatItem & {
  compact: boolean;
  markdownComponents: ReturnType<typeof createMarkdownComponents>;
  onOpenArtifact?: (path: string) => void;
};

const ChatMessage = memo(
  function ChatMessage({
    body,
    compact,
    markdownComponents,
    onOpenArtifact,
    pending,
    role,
    timestamp,
    title,
    variant,
    artifacts
  }: ChatMessageProps) {
    const normalizedBody = useMemo(() => normalizeChatMarkdown(body), [body]);
    const visualRole = role === "system" ? "assistant" : role;
    const visibleArtifacts = visualRole === "assistant" ? undefined : artifacts;

    return (
      <article
        className={`message ${visualRole} ${variant}${pending ? " pending" : ""} ${compact ? "compact" : ""}`}
      >
        <div className="message-meta">
          <span>{title}</span>
          <span>{formatTime(timestamp)}</span>
        </div>
        {visualRole === "assistant" ? (
          <div className="message-body markdown chat-markdown">
            <ReactMarkdown
              components={markdownComponents}
              rehypePlugins={rehypePlugins}
              remarkPlugins={remarkPlugins}
            >
              {normalizedBody}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="message-body plain">{body}</div>
        )}
        {visibleArtifacts?.length ? (
          <div className="message-artifact-list">
            {visibleArtifacts.map((artifact) =>
              onOpenArtifact ? (
                <button
                  key={artifact.id}
                  className="message-artifact-pill"
                  onClick={() => onOpenArtifact(artifact.path)}
                  type="button"
                >
                  <span className="message-artifact-kind">
                    {artifact.artifactKind ?? artifact.kind}
                  </span>
                  <span className="message-artifact-label">{artifact.label}</span>
                </button>
              ) : (
                <span key={artifact.id} className="message-artifact-pill">
                  <span className="message-artifact-kind">
                    {artifact.artifactKind ?? artifact.kind}
                  </span>
                  <span className="message-artifact-label">{artifact.label}</span>
                </span>
              )
            )}
          </div>
        ) : null}
      </article>
    );
  },
  (previous, next) =>
    previous.id === next.id &&
    previous.role === next.role &&
    previous.variant === next.variant &&
    previous.title === next.title &&
    previous.body === next.body &&
    previous.timestamp === next.timestamp &&
    previous.pending === next.pending &&
    previous.compact === next.compact &&
    previous.markdownComponents === next.markdownComponents &&
    previous.onOpenArtifact === next.onOpenArtifact &&
    areArtifactsEqual(previous.artifacts, next.artifacts)
);

type ChatFeedProps = {
  items: ChatItem[];
  researchGoal?: string | null;
  compact?: boolean;
  onOpenArtifact?: (path: string) => void;
  workspacePath?: string;
};

export function ChatFeed({ items, compact = false, onOpenArtifact, workspacePath }: ChatFeedProps) {
  const markdownComponents = useMemo(
    () => createMarkdownComponents(onOpenArtifact, workspacePath),
    [onOpenArtifact, workspacePath]
  );

  return (
    <div className={compact ? "chat-feed compact" : "chat-feed"}>
      {items.map((item) => (
        <ChatMessage
          key={item.id}
          {...item}
          compact={compact}
          markdownComponents={markdownComponents}
          onOpenArtifact={onOpenArtifact}
        />
      ))}
    </div>
  );
}

function areArtifactsEqual(left?: ChatArtifactRef[], right?: ChatArtifactRef[]) {
  if (left === right) {
    return true;
  }

  if (!left?.length && !right?.length) {
    return true;
  }

  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((artifact, index) => {
    const other = right[index];
    return (
      artifact.id === other?.id &&
      artifact.path === other.path &&
      artifact.label === other.label &&
      artifact.kind === other.kind &&
      artifact.artifactKind === other.artifactKind
    );
  });
}
