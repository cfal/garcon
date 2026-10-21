import type { AgentAttachment } from "@garcon/common/agent-execution";
import {
  appendAttachmentFileReferences,
  materializeAttachmentFiles,
} from "@garcon/server-agent-common/shared/attachment-files";
import {
  isDocumentAttachment,
  isImageAttachment,
  isTextAttachment,
} from "@garcon/server-agent-common/shared/attachments";

export interface MaterializedClaudeDiskAttachments {
  readonly command: string;
  readonly filePaths: readonly string[];
  readonly cleanup: () => Promise<void>;
}

// Images, PDFs, and text travel inline as content blocks; every other type,
// such as video or spreadsheets, is written to disk for Claude's tools to read.
export async function materializeClaudeDiskAttachments(
  command: string,
  attachments?: readonly AgentAttachment[],
): Promise<MaterializedClaudeDiskAttachments> {
  const diskAttachments = (attachments ?? []).filter((attachment) =>
    !isImageAttachment(attachment)
    && !isDocumentAttachment(attachment)
    && !isTextAttachment(attachment),
  );
  const { files, cleanup } = await materializeAttachmentFiles(
    "claude-attachments",
    diskAttachments,
  );
  return {
    command: appendAttachmentFileReferences(command, files),
    filePaths: files.map((file) => file.path),
    cleanup,
  };
}
