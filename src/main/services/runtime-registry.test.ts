import { describe, expect, it } from "vitest";
import { RuntimeRegistry } from "./runtime-registry";

describe("RuntimeRegistry", () => {
  it("bounds chat progress entries per workspace", () => {
    const registry = new RuntimeRegistry();

    for (let index = 0; index < 80; index += 1) {
      registry.setChatProgress("/tmp/demo", {
        lane: "builder",
        threadId: `TH${String(index).padStart(3, "0")}`,
        progressSummary: `step ${index}`,
        progressDetails: [],
        activeCommand: null,
        operationId: `run-${index}`
      });
    }

    const internalEntries = (
      registry as unknown as {
        activeChatProgressByKey: Map<string, { threadId: string }>;
      }
    ).activeChatProgressByKey;

    expect(internalEntries.size).toBeLessThanOrEqual(64);
    expect(
      Array.from(internalEntries.values()).some((entry) => entry.threadId === "TH079")
    ).toBe(true);
    expect(
      Array.from(internalEntries.values()).some((entry) => entry.threadId === "TH000")
    ).toBe(false);
  });

  it("drops idle automation controllers during cleanup", () => {
    const registry = new RuntimeRegistry();
    const controller = registry.getAutomationController("/tmp/demo", "AU001");

    controller.running = true;
    registry.cleanupAutomationController("/tmp/demo", "AU001");
    expect(registry.peekAutomationController("/tmp/demo", "AU001")).toBe(controller);

    controller.running = false;
    controller.pauseRequested = true;
    controller.stopRequested = true;
    controller.redirectInstruction = "resume with stricter evidence";
    controller.activeBuilderRuns.set("AS001", "R001");
    registry.cleanupAutomationController("/tmp/demo", "AU001");

    expect(registry.peekAutomationController("/tmp/demo", "AU001")).toBeNull();
  });
});
