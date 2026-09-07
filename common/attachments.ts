export const TEXT_FILE_ATTACHMENT_MIME_TYPES = ['text/markdown', 'text/plain'] as const;

export const DOCUMENT_FILE_ATTACHMENT_MIME_TYPES = ['application/pdf'] as const;

export const VIDEO_FILE_ATTACHMENT_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;

export const CHAT_FILE_ATTACHMENT_MIME_TYPES = [
  ...TEXT_FILE_ATTACHMENT_MIME_TYPES,
  ...DOCUMENT_FILE_ATTACHMENT_MIME_TYPES,
  ...VIDEO_FILE_ATTACHMENT_MIME_TYPES,
] as const;

export const MAX_CHAT_ATTACHMENT_COUNT = 5;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_VIDEO_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;

const CHAT_ATTACHMENT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
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
  txt: 'text/plain',
  webm: 'video/webm',
  webp: 'image/webp',
};

const CHAT_ATTACHMENT_MIME_ALIASES: Readonly<Record<string, string>> = {
  'video/matroska': 'video/x-matroska',
  'video/x-m4v': 'video/mp4',
};

export function chatAttachmentMimeType(file: {
  readonly name: string;
  readonly type?: string | null;
}): string {
  const declared = file.type?.trim().toLowerCase() ?? '';
  const canonicalDeclared = CHAT_ATTACHMENT_MIME_ALIASES[declared] ?? declared;
  if (canonicalDeclared && canonicalDeclared !== 'application/octet-stream') {
    return canonicalDeclared;
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return (
    CHAT_ATTACHMENT_MIME_BY_EXTENSION[extension] ?? canonicalDeclared
  ) || 'application/octet-stream';
}

export function isVideoAttachmentMimeType(mimeType: string): boolean {
  return (VIDEO_FILE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}
