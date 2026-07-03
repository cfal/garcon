import type { AgentCommandImage } from '../../../common/ws-requests.js';

const MAX_INLINE_ATTACHMENT_CHARS = 120_000;
const TEXT_ATTACHMENT_MIMES = new Set(['text/markdown', 'text/plain']);
const DOCUMENT_ATTACHMENT_MIMES = new Set(['application/pdf']);

export interface DataUrlParts {
  mimeType: string;
  base64: string;
}

export interface AttachmentDocumentBlock {
  type: 'document';
  source: { type: 'base64'; media_type: string; data: string };
  title?: string;
}

export function parseAttachmentDataUrl(data: string | undefined): DataUrlParts | null {
  const match = data?.match?.(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), base64: match[2] };
}

export function attachmentMimeType(attachment: AgentCommandImage): string {
  return attachment.mimeType?.toLowerCase()
    ?? parseAttachmentDataUrl(attachment.data)?.mimeType
    ?? '';
}

export function isImageAttachment(attachment: AgentCommandImage): boolean {
  return attachmentMimeType(attachment).startsWith('image/');
}

export function imageAttachments(attachments: AgentCommandImage[] | undefined): AgentCommandImage[] {
  return attachments?.filter(isImageAttachment) ?? [];
}

export function nonImageAttachments(attachments: AgentCommandImage[] | undefined): AgentCommandImage[] {
  return attachments?.filter((attachment) => !isImageAttachment(attachment)) ?? [];
}

// Attachments that map to native document content blocks (PDFs). Providers that
// support the Anthropic document block send these as base64 rather than inlining.
export function documentAttachments(attachments: AgentCommandImage[] | undefined): AgentCommandImage[] {
  return attachments?.filter((attachment) => DOCUMENT_ATTACHMENT_MIMES.has(attachmentMimeType(attachment))) ?? [];
}

// Builds an Anthropic document content block for a PDF attachment, or null when
// the data URL cannot be parsed.
export function attachmentDocumentBlock(attachment: AgentCommandImage): AttachmentDocumentBlock | null {
  const parts = parseAttachmentDataUrl(attachment.data);
  if (!parts) return null;
  return {
    type: 'document',
    source: { type: 'base64', media_type: parts.mimeType, data: parts.base64 },
    ...(attachment.name ? { title: attachment.name } : {}),
  };
}

export function appendTextAttachmentContext(command: string, attachments: AgentCommandImage[] | undefined): string {
  const sections: string[] = [];
  for (const attachment of nonImageAttachments(attachments)) {
    const parts = parseAttachmentDataUrl(attachment.data);
    const mimeType = attachmentMimeType(attachment);
    if (!parts || !TEXT_ATTACHMENT_MIMES.has(mimeType)) continue;
    const text = Buffer.from(parts.base64, 'base64').toString('utf8');
    const truncated = text.length > MAX_INLINE_ATTACHMENT_CHARS;
    sections.push([
      `<attached-file name="${attachment.name ?? 'attachment'}" mime="${mimeType}">`,
      truncated ? text.slice(0, MAX_INLINE_ATTACHMENT_CHARS) : text,
      truncated ? '\n[Attachment truncated by Garcon before sending.]' : '',
      '</attached-file>',
    ].join('\n'));
  }
  if (sections.length === 0) return command;
  return [command, ...sections].filter((part) => part.trim()).join('\n\n');
}
