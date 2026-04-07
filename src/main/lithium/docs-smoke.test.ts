import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("documentation smoke", () => {
  it("keeps the README aligned with the V5 runtime surface", async () => {
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

    expect(readme).toContain("## V5 Highlights");
    expect(readme).toContain("lithium run stop [--workspace <path>] [--objective <id>] [--run <id>]");
    expect(readme).toContain(".lithium/state/research.db");
    expect(readme).toContain(".lithium/runtime/daemon.sock");
    expect(readme).toContain(".lithium/artifacts/patches/*");
    expect(readme).not.toContain("## V4 Highlights");
  });

  it("documents only the currently supported oracle environment variables", async () => {
    const envExample = await readFile(path.join(repoRoot, ".env.example"), "utf8");

    expect(envExample).toContain("LITHIUM_ORACLE_HEADLESS=0");
    expect(envExample).toContain("LITHIUM_ORACLE_AUTO_RECOVER=1");
    expect(envExample).toContain("LITHIUM_ORACLE_REUSE_CHATGPT_URL=0");
    expect(envExample).not.toContain("LITHIUM_DISCORD_");
  });

  it("keeps the golden-path proof document on the real daemon boot path", async () => {
    const proof = await readFile(
      path.join(repoRoot, "docs/research/single-user-local-golden-path-proof.md"),
      "utf8"
    );

    expect(proof).toContain("createWorkspaceDaemon");
    expect(proof).toContain("src/main/lithium/daemon.integration.test.ts");
    expect(proof).toContain(".lithium/state/research.db");
    expect(proof).not.toContain("ResearchService.initWorkspace");
    expect(proof).not.toContain(".lithium/project.json");
    expect(proof).not.toContain(".lithium/activity.log");
  });
});
