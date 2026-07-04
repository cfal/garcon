import path from 'path';
import type { AgentCommandImage } from '../../common/ws-requests.js';

export const MAX_ATTACHMENT_UPLOAD_BODY_BYTES = 30 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 5;

export const ALLOWED_ATTACHMENT_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'text/markdown',
  'text/plain',
  'application/pdf',
]);

const ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.markdown': 'text/markdown',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const DATA_URL_RE = /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/;
const BASE64_CHARS_RE = /^[A-Za-z0-9+/]*={0,2}$/;

interface UploadAttachmentFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface UploadedAttachment {
  name: string;
  data: string;
  size: number;
  mimeType: string;
}

export class AttachmentValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'AttachmentValidationError';
  }
}

export function attachmentMimeTypeForUpload(file: Pick<UploadAttachmentFile, 'name' | 'type'>): string {
  const declared = file.type.trim().toLowerCase();
  if (declared) return declared;
  const ext = path.extname(file.name).toLowerCase();
  return ATTACHMENT_MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

export function validateAttachmentUploadBatch(
  files: readonly Pick<UploadAttachmentFile, 'name' | 'size' | 'type'>[],
): void {
  if (files.length > MAX_ATTACHMENT_COUNT) {
    throw new AttachmentValidationError('Maximum 5 files allowed');
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new AttachmentValidationError('Total upload too large. Maximum combined size is 25MB.', 413);
  }

  for (const file of files) {
    const mimeType = attachmentMimeTypeForUpload(file);
    assertAllowedAttachmentMime(mimeType);
    assertAttachmentSize(file.size);
  }
}

export async function uploadedAttachmentFromFile(file: UploadAttachmentFile): Promise<UploadedAttachment> {
  const mimeType = attachmentMimeTypeForUpload(file);
  assertAllowedAttachmentMime(mimeType);
  assertAttachmentSize(file.size);
  const buffer = Buffer.from(await file.arrayBuffer());
  return {
    name: file.name,
    data: `data:${mimeType};base64,${buffer.toString('base64')}`,
    size: file.size,
    mimeType,
  };
}

export function validateCommandAttachments(value: unknown): AgentCommandImage[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new AttachmentValidationError('Invalid attachment payload.');
  }
  if (value.length === 0) return [];
  if (value.length > MAX_ATTACHMENT_COUNT) {
    throw new AttachmentValidationError('Maximum 5 files allowed');
  }

  let totalBytes = 0;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AttachmentValidationError('Invalid attachment payload.');
    }

    const attachment = entry as Record<string, unknown>;
    const data = typeof attachment.data === 'string' ? attachment.data : '';
    const match = DATA_URL_RE.exec(data);
    if (!match) {
      throw new AttachmentValidationError('Invalid attachment payload.');
    }

    const dataMimeType = match[1].trim().toLowerCase();
    const declaredMimeType = typeof attachment.mimeType === 'string'
      ? attachment.mimeType.trim().toLowerCase()
      : '';
    const mimeType = dataMimeType || declaredMimeType;
    if (dataMimeType && declaredMimeType && dataMimeType !== declaredMimeType) {
      throw new AttachmentValidationError('Attachment MIME type does not match its data URL.');
    }
    assertAllowedAttachmentMime(mimeType);

    const base64 = match[2];
    if (!isValidBase64Payload(base64)) {
      throw new AttachmentValidationError('Invalid attachment payload.');
    }
    const size = Buffer.byteLength(base64, 'base64');
    assertAttachmentSize(size);
    totalBytes += size;
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      throw new AttachmentValidationError('Total upload too large. Maximum combined size is 25MB.', 413);
    }

    const name = typeof attachment.name === 'string' && attachment.name.trim()
      ? attachment.name
      : `attachment-${index + 1}`;
    return {
      data: `data:${mimeType};base64,${base64}`,
      name,
      mimeType,
    };
  });
}

function assertAllowedAttachmentMime(mimeType: string): void {
  if (!ALLOWED_ATTACHMENT_MIMES.has(mimeType)) {
    throw new AttachmentValidationError('Invalid file type. Only images, Markdown, text, and PDF files are allowed.');
  }
}

function assertAttachmentSize(size: number): void {
  if (size > MAX_ATTACHMENT_FILE_BYTES) {
    throw new AttachmentValidationError('File too large. Maximum file size is 10MB.', 413);
  }
}

function isValidBase64Payload(value: string): boolean {
  if (!BASE64_CHARS_RE.test(value)) return false;
  const paddingIndex = value.indexOf('=');
  if (paddingIndex !== -1) {
    if (/[^=]/.test(value.slice(paddingIndex))) return false;
    return value.length % 4 === 0;
  }
  return value.length % 4 !== 1;
}
