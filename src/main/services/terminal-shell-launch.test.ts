import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { prepareInteractiveShellLaunch } from "./terminal-shell-launch";

describe("terminal shell launch", () => {
  it("starts zsh as a login shell and preserves user startup files", async () => {
    const launch = await prepareInteractiveShellLaunch("/bin/zsh");

    try {
      expect(launch.args).toEqual(["-il"]);
      expect(launch.env.ZDOTDIR).toBeTruthy();

      const zprofile = await readFile(`${launch.env.ZDOTDIR}/.zprofile`, "utf8");
      const zshrc = await readFile(`${launch.env.ZDOTDIR}/.zshrc`, "utf8");

      expect(zprofile).toContain(".zprofile");
      expect(zshrc).toContain(".zshrc");
      expect(zshrc).toContain("lithium_emit_cwd");
    } finally {
      const tempDir = launch.env.ZDOTDIR;
      await launch.cleanup();

      await expect(access(tempDir as string)).rejects.toThrow();
    }
  });

  it("sources login-shell profile files before the interactive bash rc", async () => {
    const launch = await prepareInteractiveShellLaunch("/bin/bash");

    try {
      expect(launch.args[0]).toBe("--rcfile");
      expect(launch.args[2]).toBe("-i");

      const rcFile = await readFile(launch.args[1] as string, "utf8");

      expect(rcFile).toContain(".bash_profile");
      expect(rcFile).toContain(".profile");
      expect(rcFile).toContain(".bashrc");
      expect(rcFile).toContain("lithium_emit_cwd");
    } finally {
      await launch.cleanup();
    }
  });
});
