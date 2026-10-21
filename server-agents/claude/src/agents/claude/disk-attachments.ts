import type { AgentAttachment } from "@garcon/common/agent-execution";
import {
  appendAttachmentFileReferences,
  materializeAttachmentFiles,
} from "@garcon/server-agent-common/shared/attachment-files";
import {
  fitsInlineTextAttachment,
  isDocumentAttachment,
  isImageAttachment,
} from "@garcon/server-agent-common/shared/attachments";

export interface MaterializedClaudeDiskAttachments {
  readonly command: string;
  readonly inlineAttachments: readonly AgentAttachment[];
  readonly filePaths: readonly string[];
  readonly cleanup: () => Promise<void>;
}

// Images, PDFs, and text that fits untruncated travel inline; every other
// attachment, such as video, spreadsheets, or a large CSV, is written to disk
// for Claude's tools to read.
export async function materializeClaudeDiskAttachments(
  command: string,
  attachments?: readonly AgentAttachment[],
): Promise<MaterializedClaudeDiskAttachments> {
  const inlineAttachments: AgentAttachment[] = [];
  const diskAttachments: AgentAttachment[] = [];
  for (const attachment of attachments ?? []) {
    const inline = isImageAttachment(attachment)
      || isDocumentAttachment(attachment)
      || fitsInlineTextAttachment(attachment);
    (inline ? inlineAttachments : diskAttachments).push(attachment);
  }
  const { files, cleanup } = await materializeAttachmentFiles(
    "claude-attachments",
    diskAttachments,
  );
  return {
    command: appendAttachmentFileReferences(command, files),
    inlineAttachments,
    filePaths: files.map((file) => file.path),
    cleanup,
  };
}
