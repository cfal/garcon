import type { AgentAttachment } from '@garcon/common/agent-execution';
import { parseAttachmentDataUrl } from '@garcon/server-agent-common/shared/attachments';

interface AmpUserInputContentPart {
  readonly type: 'text' | 'image';
  readonly text?: string;
  readonly source_path?: string;
  readonly source?: {
    readonly type: 'base64';
    readonly media_type: string;
    readonly data: string;
  };
}

export function buildAmpUserInput(
  text: string,
  requestId: string,
  attachments: readonly AgentAttachment[] = [],
  steer = false,
): string {
  const content: AmpUserInputContentPart[] = [{ type: 'text', text }];
  for (const attachment of attachments) {
    const source = parseAttachmentDataUrl(attachment.data);
    if (!source) continue;
    content.push({
      type: 'image',
      ...(attachment.name ? { source_path: attachment.name } : {}),
      source: {
        type: 'base64',
        media_type: source.mimeType,
        data: source.base64,
      },
    });
  }
  return `${JSON.stringify({
    type: 'user',
    request_id: requestId,
    ...(steer ? { steer: true } : {}),
    message: { role: 'user', content },
  })}\n`;
}
