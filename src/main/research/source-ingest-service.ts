import type { AttachmentRecord, ResearchBranchRecord, ResearchObjectiveRecord, ResearchSourceRecord } from "../../shared/types";
import { ResearchStateStore } from "./state-store";

export class SourceIngestService {
  constructor(private readonly deps: { stateStore: ResearchStateStore }) {}

  async ingestAttachmentSource(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    attachment: AttachmentRecord;
  }) {
    const state = await this.deps.stateStore.readState(input.workspacePath, input.objective.id);
    const latestObjective = state.latestObjective ?? input.objective;
    const latestBranch =
      (input.branch ? state.branches.find((entry) => entry.id === input.branch?.id) : null) ?? input.branch;
    const allocation = await this.deps.stateStore.allocateSource(input.workspacePath);
    const now = new Date().toISOString();
    const source: ResearchSourceRecord = {
      id: allocation.id,
      objectiveId: latestObjective.id,
      threadId: latestObjective.threadId,
      branchId: latestBranch?.id,
      kind: "attachment",
      title: input.attachment.name,
      locator: input.attachment.relativePath,
      provenance: `attachment:${input.attachment.id}`,
      summary: input.attachment.excerpt || input.attachment.name,
      excerpt: input.attachment.excerpt,
      attachmentId: input.attachment.id,
      metadata: {
        attachmentKind: input.attachment.kind,
        sizeBytes: input.attachment.sizeBytes
      },
      createdAt: input.attachment.importedAt,
      updatedAt: now
    };

    await this.deps.stateStore.writeSource(input.workspacePath, source);

    await this.deps.stateStore.writeObjective(input.workspacePath, {
      ...latestObjective,
      sourceIds: Array.from(new Set([...latestObjective.sourceIds, source.id])),
      updatedAt: now
    });

    if (latestBranch) {
      await this.deps.stateStore.writeBranch(input.workspacePath, {
        ...latestBranch,
        sourceIds: Array.from(new Set([...latestBranch.sourceIds, source.id])),
        updatedAt: now,
        lastUpdatedAt: now
      });
    }

    return source;
  }
}
