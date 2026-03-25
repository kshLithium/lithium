import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatFeed, resolveArtifactLinkTarget } from "./ChatFeed";
import type { ChatItem } from "./app-types";

describe("ChatFeed", () => {
  it("renders inline and block math with KaTeX", () => {
    const items: ChatItem[] = [
      {
        id: "assistant-1",
        role: "assistant",
        body: [
          "Inline math: \\(x^2 + y^2 = z^2\\)",
          "",
          "\\[",
          "\\min_{w,b,\\xi}\\ \\frac{1}{2}\\|w\\|^2 + C\\sum_i \\xi_i",
          "\\]"
        ].join("\n"),
        timestamp: "2026-03-21T10:00:00.000Z",
        order: 0
      }
    ];

    const html = renderToStaticMarkup(<ChatFeed items={items} />);

    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("\\(x^2 + y^2 = z^2\\)");
    expect(html).not.toContain("\\[");
    expect(html).toContain('annotation encoding="application/x-tex"');
  });

  it("renders ChatGPT-style bracketed math blocks and parenthesized inline math", () => {
    const items: ChatItem[] = [
      {
        id: "assistant-2",
        role: "assistant",
        body: [
          "여기서 (\\rho_+ \\neq \\rho_-) 는 class-conditional margin입니다.",
          "",
          "[ \\min_{w,b,\\xi}\\ \\frac{1}{2}\\|w\\|^2 + C\\sum_i \\xi_i ]"
        ].join("\n"),
        timestamp: "2026-03-21T10:01:00.000Z",
        order: 1
      }
    ];

    const html = renderToStaticMarkup(<ChatFeed items={items} />);

    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("[ \\min_{w,b,\\xi}");
    expect(html).not.toContain("(\\rho_+ \\neq \\rho_-)");
  });

  it("repairs malformed absolute file references before rendering markdown", () => {
    const items: ChatItem[] = [
      {
        id: "assistant-3",
        role: "assistant",
        body:
          "Updated [init.py]/Users/rubidium/lithium/lithium/cegda/__init__.py#L3. Also changed [torch_impl.py]/Users/rubidium/lithium/lithium/cegda/torch_impl.py#L780에서 metric logging을 조정했다.",
        timestamp: "2026-03-21T10:02:00.000Z",
        order: 2
      }
    ];

    const html = renderToStaticMarkup(<ChatFeed items={items} />);

    expect(html).toContain('href="/Users/rubidium/lithium/lithium/cegda/__init__.py#L3"');
    expect(html).toContain(">init.py</a>");
    expect(html).toContain('href="/Users/rubidium/lithium/lithium/cegda/torch_impl.py#L780"');
    expect(html).toContain(">torch_impl.py</a>에서 metric logging");
  });

  it("keeps valid markdown file links out of math normalization", () => {
    const items: ChatItem[] = [
      {
        id: "assistant-3b",
        role: "assistant",
        body:
          "정리 메모와 산출물은 [warm34 quant gap memo](/Users/rubidium/parameter-golf/official/logs/mlx_local_research_update_2026-03-24_warm34_quant_gap.md), [raw eval log](/Users/rubidium/parameter-golf/official/logs/mlx_tiny_0layer_100step_fp16emb_r006_warm34_raw_eval_20260324.txt), [partial warm38 log](/Users/rubidium/parameter-golf/official/logs/mlx_tiny_0layer_100step_fp16emb_r006_warm38_20260324.txt)에 남겼습니다.",
        timestamp: "2026-03-21T10:02:30.000Z",
        order: 3
      }
    ];

    const html = renderToStaticMarkup(<ChatFeed items={items} />);

    expect(html).toContain(
      'href="/Users/rubidium/parameter-golf/official/logs/mlx_local_research_update_2026-03-24_warm34_quant_gap.md"'
    );
    expect(html).toContain(">warm34 quant gap memo</a>");
    expect(html).toContain(
      'href="/Users/rubidium/parameter-golf/official/logs/mlx_tiny_0layer_100step_fp16emb_r006_warm34_raw_eval_20260324.txt"'
    );
    expect(html).toContain(">raw eval log</a>");
    expect(html).toContain(
      'href="/Users/rubidium/parameter-golf/official/logs/mlx_tiny_0layer_100step_fp16emb_r006_warm38_20260324.txt"'
    );
    expect(html).toContain(">partial warm38 log</a>에 남겼습니다.");
    expect(html).not.toContain("katex");
  });

  it("renders attachment pills under user chat bubbles", () => {
    const items: ChatItem[] = [
      {
        id: "user-attachment-1",
        role: "user",
        body: "README와 첨부 메모를 같이 확인해줘.",
        timestamp: "2026-03-21T10:02:45.000Z",
        order: 3,
        artifacts: [
          {
            id: "A001",
            path: "/tmp/workspace/attachments/TH001/reviewer-note.md",
            relativePath: "attachments/TH001/reviewer-note.md",
            label: "reviewer-note.md",
            kind: "artifact",
            artifactKind: "text"
          }
        ]
      }
    ];

    const html = renderToStaticMarkup(<ChatFeed items={items} />);

    expect(html).toContain("README와 첨부 메모를 같이 확인해줘.");
    expect(html).toContain("message-artifact-pill");
    expect(html).toContain("reviewer-note.md");
    expect(html).toContain("message-artifact-kind");
  });

  it("ignores changed-file artifacts and keeps the reply as plain chat content", () => {
    const items: ChatItem[] = [
      {
        id: "assistant-4",
        role: "assistant",
        body: "Updated the recovery loop.",
        timestamp: "2026-03-21T10:03:00.000Z",
        order: 3,
        artifacts: [
          {
            id: "/tmp/workspace/src/main/services/app-service.ts",
            path: "/tmp/workspace/src/main/services/app-service.ts",
            relativePath: "src/main/services/app-service.ts",
            label: "services/app-service.ts",
            kind: "code"
          },
          {
            id: "/tmp/workspace/src/main/services/app-service.test.ts",
            path: "/tmp/workspace/src/main/services/app-service.test.ts",
            relativePath: "src/main/services/app-service.test.ts",
            label: "services/app-service.test.ts",
            kind: "code"
          }
        ]
      }
    ];

    const html = renderToStaticMarkup(<ChatFeed items={items} />);

    expect(html).toContain("Updated the recovery loop.");
    expect(html).not.toContain("changed-files-card");
    expect(html).not.toContain("message-artifact-pill");
  });

  it("renders assistant replies without status badges or process cards", () => {
    const items: ChatItem[] = [
      {
        id: "assistant-5",
        role: "assistant",
        body: "Automation is still running.",
        timestamp: "2026-03-21T10:04:00.000Z",
        order: 4
      }
    ];

    const html = renderToStaticMarkup(<ChatFeed items={items} />);

    expect(html).toContain("Automation is still running.");
    expect(html).not.toContain("message-badges");
    expect(html).not.toContain("process-card");
  });

  it("resolves workspace-local file links for in-app opening", () => {
    expect(
      resolveArtifactLinkTarget(
        "/Users/rubidium/project/lithium/src/renderer/App.tsx#L42",
        "/Users/rubidium/project/lithium"
      )
    ).toBe("/Users/rubidium/project/lithium/src/renderer/App.tsx");
    expect(
      resolveArtifactLinkTarget(
        "/Users/rubidium/other-project/src/index.ts#L7",
        "/Users/rubidium/project/lithium"
      )
    ).toBeNull();
    expect(
      resolveArtifactLinkTarget("https://example.com/spec", "/Users/rubidium/project/lithium")
    ).toBeNull();
  });
});
