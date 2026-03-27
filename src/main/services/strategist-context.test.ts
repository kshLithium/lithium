import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../../shared/types";
import {
  buildStrategistPromptEnvelope,
  buildStrategistContextFingerprint,
  buildStrategistOracleSessionId,
  getStrategistUploadLimitBytes,
  isSupportedStrategistUploadPath,
  limitStrategistUploadCandidates,
  resolveRecentStrategistAttachmentCandidates,
  resolveRelevantStrategistWorkspaceFiles,
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
      attachments: [
        {
          id: "A2",
          threadId: "TH001",
          relativePath: "notes/b.md",
          updatedAt: "2026-03-20T00:00:02.000Z",
          consumedAt: ""
        },
        {
          id: "A1",
          threadId: "TH001",
          relativePath: "notes/a.md",
          updatedAt: "2026-03-20T00:00:01.000Z",
          consumedAt: ""
        }
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
    } as unknown as ProjectSnapshot;
    const snapshotB = {
      ...snapshotA,
      attachments: [...snapshotA.attachments].reverse(),
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
      attachments: [],
      latestRun: null,
      latestTask: null,
      latestAutomationSession: null,
      latestAutomationCheckpoint: null,
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
    expect(isSupportedStrategistUploadPath("/tmp/chart.png")).toBe(true);
    expect(isSupportedStrategistUploadPath("/tmp/train_svm.py")).toBe(true);
    expect(isSupportedStrategistUploadPath("/tmp/archive.zip")).toBe(false);
  });

  it("uses provider-aware upload size limits", () => {
    expect(getStrategistUploadLimitBytes("/tmp/chart.png")).toBe(20 * 1024 * 1024);
    expect(getStrategistUploadLimitBytes("/tmp/results.csv")).toBe(50 * 1024 * 1024);
    expect(getStrategistUploadLimitBytes("/tmp/notes.md")).toBe(512 * 1024 * 1024);
  });

  it("prioritizes explicit and recently changed workspace files for strategist uploads", () => {
    const resolved = resolveRelevantStrategistWorkspaceFiles({
      prompt: "Compare the latest results in metrics.csv and update src/train_model.py if needed.",
      workspacePath: "/tmp/ws",
      workspaceFiles: [
        {
          path: "/tmp/ws/README.md",
          relativePath: "README.md",
          name: "README.md",
          kind: "artifact",
          artifactKind: "text"
        },
        {
          path: "/tmp/ws/src/train_model.py",
          relativePath: "src/train_model.py",
          name: "train_model.py",
          kind: "code",
          artifactKind: "code"
        },
        {
          path: "/tmp/ws/reports/metrics.csv",
          relativePath: "reports/metrics.csv",
          name: "metrics.csv",
          kind: "artifact",
          artifactKind: "csv"
        },
        {
          path: "/tmp/ws/docs/notes.md",
          relativePath: "docs/notes.md",
          name: "notes.md",
          kind: "artifact",
          artifactKind: "text"
        }
      ],
      latestChangedFiles: ["reports/metrics.csv"],
      contextHints: ["The current thread is about training and metrics."]
    });

    expect(resolved).toContain("/tmp/ws/src/train_model.py");
    expect(resolved).toContain("/tmp/ws/reports/metrics.csv");
  });

  it("does not treat explicitly mentioned zip workspace files as direct uploads", () => {
    const resolved = resolveRelevantStrategistWorkspaceFiles({
      prompt: "Inspect artifacts/context.zip before deciding the next step.",
      workspacePath: "/tmp/ws",
      workspaceFiles: [
        {
          path: "/tmp/ws/artifacts/context.zip",
          relativePath: "artifacts/context.zip",
          name: "context.zip",
          kind: "artifact",
          artifactKind: "document"
        },
        {
          path: "/tmp/ws/README.md",
          relativePath: "README.md",
          name: "README.md",
          kind: "artifact",
          artifactKind: "text"
        }
      ],
      latestChangedFiles: [],
      contextHints: []
    });

    expect(resolved).not.toContain("/tmp/ws/artifacts/context.zip");
  });

  it("prefers active attachments over older consumed ones for strategist uploads", () => {
    const resolved = resolveRecentStrategistAttachmentCandidates(
      [
        {
          id: "A1",
          threadId: "TH001",
          relativePath: "attachments/TH001/old-note.md",
          updatedAt: "2026-03-20T00:00:00.000Z",
          consumedAt: "2026-03-20T00:05:00.000Z"
        },
        {
          id: "A2",
          threadId: "TH001",
          relativePath: "attachments/TH001/current-note.md",
          updatedAt: "2026-03-19T00:00:00.000Z"
        }
      ] as any,
      "/tmp/ws",
      { maxFiles: 2 }
    );

    expect(resolved[0]).toBe("/tmp/ws/attachments/TH001/current-note.md");
  });

  it("caps strategist browser uploads and keeps higher-priority files", () => {
    const selected = limitStrategistUploadCandidates(
      Array.from({ length: 14 }, (_, index) => ({
        path: `/tmp/file-${index}.md`,
        priority: 100 - index
      }))
    );

    expect(selected).toHaveLength(10);
    expect(selected[0]).toBe("/tmp/file-0.md");
    expect(selected).not.toContain("/tmp/file-13.md");
  });

  it("builds a richer strategist prompt envelope with original and clarified asks", () => {
    const prompt = buildStrategistPromptEnvelope({
      prompt: "Compare the new metrics and decide the next research direction.",
      displayPrompt: "지금 상황까지 반영해서 다음 방향을 정해줘.",
      latestThreadSummary: "Track regression causes after the latest eval.",
      latestDecisionSummary: "Favor data-quality diagnosis before retraining.",
      latestRunSummary: "The latest eval regressed on long-context accuracy.",
      latestChangedFiles: ["reports/metrics.csv", "src/train_model.py"],
      recentAttachmentNames: ["attachments/TH001/eval-notes.md"],
      attachedContextLabels: ["runtime context", "full context pack", "strategist digest"],
      attachedRawFileNames: ["metrics.csv", "train_model.py"],
      skippedUploadNotes: ["attachments/TH001/archive.zip — unsupported for direct browser upload"]
    });

    expect(prompt).toContain("원래 사용자 메시지");
    expect(prompt).toContain("정리된 strategist 작업 지시");
    expect(prompt).toContain("직전 builder 요약");
    expect(prompt).toContain("추가 raw 파일");
    expect(prompt).toContain("직접 업로드에서 빠진 파일 메모");
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
