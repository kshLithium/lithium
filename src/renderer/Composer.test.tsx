import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const noop = vi.fn();

function renderComposer(input: Partial<Parameters<typeof Composer>[0]> = {}) {
  return renderToStaticMarkup(
    <Composer
      attachments={[]}
      busy={false}
      canCreateThread
      canOpenCode
      canOpenPaper
      canToggleTerminal
      onCreateThread={noop}
      onDropFiles={noop}
      onOpenChatSurface={noop}
      onOpenCodeSurface={noop}
      onOpenPaperSurface={noop}
      onOpenSettings={noop}
      onRemoveAttachment={noop}
      onSend={noop}
      onToggleTerminal={noop}
      onValueChange={noop}
      value=""
      {...input}
    />
  );
}

describe("Composer", () => {
  it("keeps the textarea interactive while a chat run is interruptible", () => {
    const html = renderComposer({
      busy: true,
      allowWhileBusy: true,
      value: "진행 상황 짧게 알려줘"
    });

    expect(html).toContain('class="composer-input"');
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });

  it("still disables the textarea for blocking busy states", () => {
    const html = renderComposer({
      busy: true,
      allowWhileBusy: false,
      value: "새 워크스페이스 열어줘"
    });

    expect(html).toMatch(/<textarea[^>]*disabled/);
  });
});
