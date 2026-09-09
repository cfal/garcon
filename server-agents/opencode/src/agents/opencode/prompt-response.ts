import { isRecord } from '@garcon/common/json';
import { isOpenCodeCompactionAssistant, type SSEEvent } from './sse-events.js';
import type { OpenCodeTurnContext } from './turn-events.js';

export function parseOpenCodePromptResponse(result: unknown, sessionId: string) {
  const response = isRecord(result) && isRecord(result.data) ? result.data : null;
  const info = response && isRecord(response.info) ? response.info : null;
  if (info?.role !== 'assistant' || typeof info.id !== 'string' || !info.id) {
    throw new Error('OpenCode prompt response is missing its assistant message');
  }
  const messageEvent: SSEEvent = {
    type: 'message.updated', properties: { sessionID: sessionId, info },
  };
  const isCompaction = isOpenCodeCompactionAssistant(info);
  const parts: unknown[] = response && Array.isArray(response.parts) ? response.parts : [];
  const textParts = parts.flatMap((part) => isRecord(part) && part.type === 'text'
    && part.messageID === info.id && typeof part.text === 'string' ? [part.text] : []);
  const finalResponse: OpenCodeTurnContext['finalResponse'] = !isCompaction && textParts.length > 0
    ? { messageId: info.id, response: { type: 'text', text: textParts.join('\n\n') } }
    : undefined;
  const responseParentId = typeof info.parentID === 'string' && info.parentID ? info.parentID : null;
  return { messageId: info.id, responseParentId, messageEvent, parts, isCompaction, finalResponse };
}
