import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AttachmentKind, AttachmentRecord, ResearchBranchRecord, ResearchObjectiveRecord } from "../../shared/types";
import { RecordStore } from "../services/record-store";
import { buildProjectPaths } from "../services/workspace-layout";
import { SourceIngestService } from "./source-ingest-service";

const DOCUMENT_ATTACHMENT_EXCERPT =
  "Document attachment. Reference the file path directly when asking the engine to inspect it.";
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".rtf",
  ".odt",
  ".ods",
  ".odp"
]);

export class AttachmentIngestService {
  private readonly records = new RecordStore();

  constructor(private readonly deps: { sourceIngestService: SourceIngestService }) {}

  async importAttachments(input: {
    workspacePath: string;
    objective: ResearchObjectiveRecord;
    branch: ResearchBranchRecord | null;
    filePaths: string[];
  }) {
    const paths = buildProjectPaths(input.workspacePath);
    const existing = await this.records.readRecordDirectory<AttachmentRecord>(paths.attachmentRecordsDir);
    const imported: AttachmentRecord[] = [];

    for (const filePath of input.filePaths) {
      const absoluteSourcePath = path.resolve(filePath);
      const sourceStat = await stat(absoluteSourcePath).catch(() => null);

      if (!sourceStat?.isFile()) {
        continue;
      }

      const duplicate = existing.find(
        (record) =>
          record.objectiveId === input.objective.id &&
          record.sourcePath === absoluteSourcePath &&
          record.sizeBytes === sourceStat.size
      );

      if (duplicate) {
        imported.push(duplicate);
        continue;
      }

      const id = await this.records.nextId(paths.attachmentRecordsDir, "A");
      const objectiveDir = path.join(paths.workspaceAttachmentsDir, input.objective.id);
      await mkdir(objectiveDir, { recursive: true });
      const fileName = `${id}-${path.basename(absoluteSourcePath)}`;
      const absoluteDestinationPath = path.join(objectiveDir, fileName);
      await copyFile(absoluteSourcePath, absoluteDestinationPath);
      const relativePath = path.relative(input.workspacePath, absoluteDestinationPath);
      const now = new Date().toISOString();
      const record: AttachmentRecord = {
        id,
        threadId: input.objective.id,
        objectiveId: input.objective.id,
        name: fileName,
        relativePath,
        sourcePath: absoluteSourcePath,
        kind: classifyAttachmentKind(absoluteDestinationPath),
        sizeBytes: sourceStat.size,
        excerpt: await buildAttachmentExcerpt(absoluteDestinationPath),
        importedAt: now,
        updatedAt: now
      };
      await this.records.writeJson(path.join(paths.attachmentRecordsDir, `${id}.json`), record);
      imported.push(record);
    }

    for (const attachment of imported) {
      await this.deps.sourceIngestService.ingestAttachmentSource({
        workspacePath: input.workspacePath,
        objective: input.objective,
        branch: input.branch,
        attachment
      });
    }

    return imported;
  }
}

function classifyAttachmentKind(filePath: string): AttachmentKind {
  const extension = path.extname(filePath).toLowerCase();

  if ([".md", ".txt", ".log"].includes(extension)) {
    return "text";
  }

  if ([".json", ".jsonl"].includes(extension)) {
    return "json";
  }

  if ([".csv", ".tsv"].includes(extension)) {
    return "csv";
  }

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) {
    return "image";
  }

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return "document";
  }

  return "other";
}

async function buildAttachmentExcerpt(filePath: string) {
  if (DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return DOCUMENT_ATTACHMENT_EXCERPT;
  }

  const content = await readFile(filePath, "utf8").catch(() => "");
  return content.replace(/\s+/g, " ").trim().slice(0, 240);
}
