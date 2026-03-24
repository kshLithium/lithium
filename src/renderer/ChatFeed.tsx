import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { ChatItem } from "./app-types";
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
        .split(/(`[^`\n]+`)/g)
        .map((segment) => {
          if (segment.startsWith("`") && segment.endsWith("`")) {
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

type ChatFeedProps = {
  items: ChatItem[];
  researchGoal?: string | null;
  compact?: boolean;
  onOpenArtifact?: (path: string) => void;
  workspacePath?: string;
};

export function ChatFeed({ items, compact = false, onOpenArtifact, workspacePath }: ChatFeedProps) {
  const markdownComponents = createMarkdownComponents(onOpenArtifact, workspacePath);

  return (
    <div className={compact ? "chat-feed compact" : "chat-feed"}>
      {items.map((item) => {
        const visualRole = item.role === "system" ? "assistant" : item.role;

        return (
          <article
            key={item.id}
            className={`message ${visualRole} ${item.variant}${item.pending ? " pending" : ""} ${compact ? "compact" : ""}`}
          >
            <div className="message-meta">
              <span>{item.title}</span>
              <span>{formatTime(item.timestamp)}</span>
            </div>
            {visualRole === "assistant" ? (
              <div className="message-body markdown chat-markdown">
                <ReactMarkdown
                  components={markdownComponents}
                  rehypePlugins={rehypePlugins}
                  remarkPlugins={remarkPlugins}
                >
                  {normalizeChatMarkdown(item.body)}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="message-body plain">{item.body}</div>
            )}
          </article>
        );
      })}
    </div>
  );
}
