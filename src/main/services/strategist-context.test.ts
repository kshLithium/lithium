import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../../shared/types";
import {
  buildStrategistContextFingerprint,
  buildStrategistOracleSessionId,
  isSupportedStrategistUploadPath,
  shouldAttachStrategistRuntimeContext
} from "./strategist-context";

describe("strategist-context", () => {
  it("keeps the strategist fingerprint stable across attachment and changed-file ordering", () => {
    const baseThread = {
      id: "TH001",
      strategistContextFingerprint: ""
    };
    const snapshotA = {
      memory: {
        projectBrief: "brief",
        researchGoal: "goal",
        constraints: ["one"],
        preferences: {},
        openQuestions: ["q1"],
        activeHypotheses: ["h1"]
      },
      activeThread: {
        ...baseThread,
        memory: "thread memory"
      },
      activeThreadAttachments: [
        { id: "A2", relativePath: "notes/b.md", updatedAt: "2026-03-20T00:00:02.000Z" },
        { id: "A1", relativePath: "notes/a.md", updatedAt: "2026-03-20T00:00:01.000Z" }
      ],
      latestRun: {
        id: "R001",
        status: "completed",
        endedAt: "2026-03-21T00:00:00.000Z",
        changedFiles: ["b.py", "a.py"]
      },
      latestTask: {
        id: "T001",
        updatedAt: "2026-03-21T00:00:00.000Z"
      },
      latestTerminalSession: {
        id: "TS001",
        endedAt: "2026-03-21T00:00:00.000Z",
        cwd: "/tmp/work"
      }
    } as unknown as ProjectSnapshot;
    const snapshotB = {
      ...snapshotA,
      activeThreadAttachments: [...snapshotA.activeThreadAttachments].reverse(),
      latestRun: {
        ...snapshotA.latestRun!,
        changedFiles: [...snapshotA.latestRun!.changedFiles].reverse()
      }
    } as unknown as ProjectSnapshot;

    expect(buildStrategistContextFingerprint(snapshotA)).toBe(
      buildStrategistContextFingerprint(snapshotB)
    );
  });

  it("attaches strategist runtime context only when the thread fingerprint changed", () => {
    const fingerprint = "stable";
    const snapshot = {
      activeThread: {
        id: "TH001",
        strategistContextFingerprint: fingerprint
      }
    } as unknown as ProjectSnapshot;

    expect(shouldAttachStrategistRuntimeContext(snapshot, fingerprint)).toBe(false);
    expect(shouldAttachStrategistRuntimeContext(snapshot, "different")).toBe(true);
  });

  it("treats workspace file changes as part of the strategist fingerprint", () => {
    const snapshot = {
      activeThread: {
        id: "TH001",
        strategistContextFingerprint: ""
      },
      activeThreadAttachments: [],
      latestRun: null,
      latestTask: null,
      latestAutomationSession: null,
      latestAutomationCheckpoint: null,
      latestTerminalSession: null,
      memory: null
    } as unknown as ProjectSnapshot;

    expect(
      buildStrategistContextFingerprint(snapshot, {
        workspaceFingerprint: "workspace-a"
      })
    ).not.toBe(
      buildStrategistContextFingerprint(snapshot, {
        workspaceFingerprint: "workspace-b"
      })
    );
  });

  it("accepts only supported strategist upload file types", () => {
    expect(isSupportedStrategistUploadPath("/tmp/README")).toBe(true);
    expect(isSupportedStrategistUploadPath("/tmp/notes.md")).toBe(true);
    expect(isSupportedStrategistUploadPath("/tmp/results.csv")).toBe(true);
    expect(isSupportedStrategistUploadPath("/tmp/train_svm.py")).toBe(true);
    expect(isSupportedStrategistUploadPath("/tmp/main.tex")).toBe(false);
  });

  it("builds a deterministic strategist session slug per workspace and thread", () => {
    expect(buildStrategistOracleSessionId("/tmp/foo", "TH001")).toBe(
      buildStrategistOracleSessionId("/tmp/foo", "TH001")
    );
    expect(buildStrategistOracleSessionId("/tmp/foo", "TH001")).not.toBe(
      buildStrategistOracleSessionId("/tmp/bar", "TH001")
    );
  });
});
