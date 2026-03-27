import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function readOracleDistFile(relativePath: string) {
  return await readFile(
    path.join(process.cwd(), "node_modules", "@steipete", "oracle", "dist", "src", relativePath),
    "utf8"
  );
}

describe("patched oracle browser integration", () => {
  it("maps strategist browser targets to current ChatGPT model families", async () => {
    const browserConfig = await readOracleDistFile(path.join("cli", "browserConfig.js"));

    expect(browserConfig).toContain("['gpt-5.4-pro', 'Pro']");
    expect(browserConfig).toContain("['gpt-5.4', 'Thinking']");
    expect(browserConfig).toContain("['gpt-5.2', 'Auto']");
    expect(browserConfig).not.toContain("['gpt-5.4-pro', 'GPT-5.4 Pro']");
  });

  it("uses Pro as the default browser model target", async () => {
    const constants = await readOracleDistFile(path.join("browser", "constants.js"));

    expect(constants).toContain("export const DEFAULT_MODEL_TARGET = 'Pro';");
  });

  it("captures visible menu diagnostics instead of page-wide button fallbacks", async () => {
    const modelSelection = await readOracleDistFile(path.join("browser", "actions", "modelSelection.js"));

    expect(modelSelection).toContain("Visible menu text:");
    expect(modelSelection).toContain("Visible options:");
    expect(modelSelection).toContain("const collectVisibleMenuText = () => {");
    expect(modelSelection).toContain("if (menuRoots.length === 0) {");
    expect(modelSelection).toContain("visibleMenus: collectVisibleMenuText()");
  });

  it("confirms model switches using the current UI state instead of a changing header label", async () => {
    const modelSelection = await readOracleDistFile(path.join("browser", "actions", "modelSelection.js"));

    expect(modelSelection).toContain("const collectComposerModeLabels = () => {");
    expect(modelSelection).toContain("const currentUiMatchesTarget = () => buttonMatchesTarget() || composerReflectsTarget();");
    expect(modelSelection).toContain("const menuExpanded = button.getAttribute?.('aria-expanded') === 'true';");
    expect(modelSelection).toContain("const selectedMatch = findBestOption();");
    expect(modelSelection).toContain("resolve({ status: 'switched', label: describeCurrentSelection() || match.label });");
  });
});
