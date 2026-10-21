// Image types sent to image-capable providers as image content. Other image/*
// types, such as HEIC or TIFF, are ordinary files.
export const IMAGE_ATTACHMENT_MIME_TYPES = [
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
] as const;

export const TEXT_FILE_ATTACHMENT_MIME_TYPES = [
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
] as const;

export const DOCUMENT_FILE_ATTACHMENT_MIME_TYPES = ['application/pdf'] as const;

export const VIDEO_FILE_ATTACHMENT_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;

// Agents that read attachments from disk with their own tools accept every
// file type rather than a fixed list.
export const ANY_FILE_ATTACHMENT_MIME_TYPE = 'any';

export type FileAttachmentMimeTypes = readonly string[] | typeof ANY_FILE_ATTACHMENT_MIME_TYPE;

export const MAX_CHAT_ATTACHMENT_COUNT = 5;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_VIDEO_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_NAME_BYTES = 255;
// Text attachments larger than this cannot be inlined into a prompt whole.
export const MAX_INLINE_TEXT_ATTACHMENT_BYTES = 120_000;

const CHAT_ATTACHMENT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  csv: 'text/csv',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  m4v: 'video/mp4',
  markdown: 'text/markdown',
  md: 'text/markdown',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  webm: 'video/webm',
  webp: 'image/webp',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const CHAT_ATTACHMENT_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'text/tab-separated-values': 'tsv',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
};

const CHAT_ATTACHMENT_MIME_ALIASES: Readonly<Record<string, string>> = {
  'video/matroska': 'video/x-matroska',
  'video/x-m4v': 'video/mp4',
};

const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

// A known extension outranks the declared type because browsers disagree on
// common files: Windows Chrome declares CSV as application/vnd.ms-excel. A
// declared image type is kept, since providers check it against the bytes.
export function chatAttachmentMimeType(file: {
  readonly name: string;
  readonly type?: string | null;
}): string {
  const rawDeclared = file.type?.trim().toLowerCase() ?? '';
  const declared = CHAT_ATTACHMENT_MIME_ALIASES[rawDeclared] ?? rawDeclared;
  if (isImageAttachmentMimeType(declared)) return declared;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return CHAT_ATTACHMENT_MIME_BY_EXTENSION[extension] ?? (declared || 'application/octet-stream');
}

export function chatAttachmentExtension(mimeType: string): string | null {
  return CHAT_ATTACHMENT_EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? null;
}

export function isValidAttachmentMimeType(mimeType: string): boolean {
  return MIME_TYPE_RE.test(mimeType);
}

export function isImageAttachmentMimeType(mimeType: string): boolean {
  return (IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

export function isTextAttachmentMimeType(mimeType: string): boolean {
  return (TEXT_FILE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

export function isVideoAttachmentMimeType(mimeType: string): boolean {
  return (VIDEO_FILE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

export function acceptsFileAttachmentMimeType(
  supported: FileAttachmentMimeTypes,
  mimeType: string,
): boolean {
  return supported === ANY_FILE_ATTACHMENT_MIME_TYPE || supported.includes(mimeType.toLowerCase());
}

export function hasFileAttachmentSupport(supported: FileAttachmentMimeTypes): boolean {
  return supported === ANY_FILE_ATTACHMENT_MIME_TYPE || supported.length > 0;
}
