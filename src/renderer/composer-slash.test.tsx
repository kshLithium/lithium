import { describe, expect, it } from "vitest";
import { buildSlashCommands, deriveSlashQuery, filterSlashCommands, groupSlashCommands } from "./composer-slash";

describe("composer-slash", () => {
  it("derives a slash query only for a single slash token", () => {
    expect(deriveSlashQuery("/research")).toBe("research");
    expect(deriveSlashQuery(" /Build")).toBe("build");
    expect(deriveSlashQuery("/research now")).toBeNull();
  });

  it("filters and groups slash commands by section", () => {
    const commands = buildSlashCommands({
      canAttachFiles: true,
      canCreateThread: true,
      canOpenWorkspace: true,
      interactionLocked: false
    });
    const filtered = filterSlashCommands(commands, "plan");
    const grouped = groupSlashCommands(filtered);

    expect(filtered.map((command) => command.id)).toContain("plan");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.label).toBe("Routing");
  });
});
