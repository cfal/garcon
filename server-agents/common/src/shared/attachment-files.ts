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

// Agents paste these paths into shell commands, so names keep only characters
// that are inert in every shell, whether quoted or not.
const SHELL_UNSAFE_CHARS_RE = /[^A-Za-z0-9._-]+/g;
const SAFE_EXTENSION_RE = /^[a-z0-9]{1,16}$/;
const MAX_STEM_CHARS = 64;

const NO_FILES: MaterializedAttachmentFiles = { files: [], cleanup: async () => {} };

// Writes attachments into a private temporary directory on the executor so
// agents can open them with their own tools. File names keep the extension,
// which agents use to choose a reader for formats such as XLSX.
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

// Prefixes the index so two attachments with the same name stay distinct. The
// MIME type decides the extension when known; otherwise a plain original
// extension is kept.
export function attachmentFileName(attachment: AttachmentInput, index: number): string {
  const baseName = path.basename(attachment.name?.replace(/\\/g, '/') ?? '');
  const originalExtension = path.extname(baseName);
  const extension = chatAttachmentExtension(attachmentMimeType(attachment))
    ?? (SAFE_EXTENSION_RE.test(originalExtension.slice(1).toLowerCase())
      ? originalExtension.slice(1).toLowerCase()
      : null);
  const stem = baseName
    .slice(0, baseName.length - originalExtension.length)
    .replace(SHELL_UNSAFE_CHARS_RE, '_')
    .replace(/^[._-]+/, '')
    .slice(0, MAX_STEM_CHARS) || 'attachment';
  return `${index + 1}-${stem}${extension ? `.${extension}` : ''}`;
}

// The original name rides as JSON-quoted text so the agent can refer to it
// without it ever appearing in a path.
export function appendAttachmentFileReferences(
  command: string,
  files: readonly AttachmentFile[],
): string {
  if (files.length === 0) return command;
  const references = files.map((file) => {
    const name = file.attachment.name;
    return name ? `- ${file.path} (original name: ${JSON.stringify(name)})` : `- ${file.path}`;
  }).join('\n');
  return [command, 'Attached files are available on disk:', references]
    .filter((part) => part.trim())
    .join('\n\n');
}
