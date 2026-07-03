import type { AgentCommandImage } from '../../../common/ws-requests.js';

const MAX_INLINE_ATTACHMENT_CHARS = 120_000;
const TEXT_ATTACHMENT_MIMES = new Set(['text/markdown', 'text/plain']);

export interface DataUrlParts {
  mimeType: string;
  base64: string;
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
