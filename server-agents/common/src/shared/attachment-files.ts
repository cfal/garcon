import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { chatAttachmentExtension } from '@garcon/common/attachments';
import { attachmentMimeType, parseAttachmentDataUrl, type AttachmentInput } from './attachments.js';

export interface AttachmentFile {
  readonly attachment: AttachmentInput;
  readonly path: string;
}

export interface MaterializedAttachmentFiles {
  readonly files: readonly AttachmentFile[];
  readonly cleanup: () => Promise<void>;
}

const UNSAFE_FILE_NAME_CHARS_RE = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;
const MAX_FILE_NAME_CHARS = 120;

const NO_FILES: MaterializedAttachmentFiles = { files: [], cleanup: async () => {} };

// Writes attachments into a private temporary directory on the executor so
// agents can open them with their own tools. File names keep the user's name
// and extension, which agents use to choose a reader for formats such as XLSX.
export async function materializeAttachmentFiles(
  directoryPrefix: string,
  attachments: readonly AttachmentInput[],
): Promise<MaterializedAttachmentFiles> {
  if (attachments.length === 0) return NO_FILES;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${directoryPrefix}-`));
  const cleanup = async () => {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  };
  const files: AttachmentFile[] = [];
  try {
    for (let index = 0; index < attachments.length; index++) {
      const attachment = attachments[index];
      const parts = parseAttachmentDataUrl(attachment.data);
      if (!parts) continue;
      const filePath = path.join(directory, attachmentFileName(attachment, index));
      await fs.writeFile(filePath, Buffer.from(parts.base64, 'base64'));
      files.push({ attachment, path: filePath });
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { files, cleanup };
}

// Prefixes the index so two attachments with the same name stay distinct.
export function attachmentFileName(attachment: AttachmentInput, index: number): string {
  const baseName = path.basename(attachment.name?.replace(/\\/g, '/') ?? '')
    .replace(UNSAFE_FILE_NAME_CHARS_RE, '_')
    .trim()
    .slice(-MAX_FILE_NAME_CHARS)
    .replace(/^\.+/, '');
  const extension = chatAttachmentExtension(attachmentMimeType(attachment));
  const named = baseName || 'attachment';
  const withExtension = path.extname(named) || !extension ? named : `${named}.${extension}`;
  return `${index + 1}-${withExtension}`;
}

export function appendAttachmentFileReferences(
  command: string,
  files: readonly AttachmentFile[],
): string {
  if (files.length === 0) return command;
  const references = files.map((file) => `- ${file.path}`).join('\n');
  return [command, 'Attached files are available on disk:', references]
    .filter((part) => part.trim())
    .join('\n\n');
}
