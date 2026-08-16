import {
  AssistantMessage,
  ThinkingMessage,
  ToolResultMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { normalizeToolResultContent } from '@garcon/server-agent-common/shared/normalize-util';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { SSEEvent } from './sse-events.js';
import { convertOpenCodeToolUse } from './tool-use-converter.js';
import type { OpenCodeTurnContext } from './turn-events.js';

export function convertOpenCodeEventToChatMessages(
  event: SSEEvent,
  turn: OpenCodeTurnContext,
  logger: AgentLogger,
): ChatMessage[] | undefined {
  const chatMessages: ChatMessage[] = [];
  const now = new Date().toISOString();
  const props = event.properties || {};
  const roleFromEvent = (
    props.info?.role
    || props.part?.role
    || props.part?.snapshot?.role
    || props.message?.role
    || null
  );

  const { assistantPartTypes, messageRoles, publishedPartIds } = turn;

  switch (event.type) {
    case 'message.updated': {
      const info = props.info || {};
      const messageId = info.id;
      if (!messageId) {
        logger.warn('OpenCode event is missing a message ID', { eventType: event.type });
        return;
      }
      // The final message frame can precede its final part on the global stream.
      if (info.role && info.role !== 'user') messageRoles.set(messageId, info.role);
      break;
    }

    case 'message.part.updated': {
      const part = props.part || {};
      if (!part.id) {
        logger.warn('OpenCode event is missing a part ID', { eventType: event.type });
        return;
      }
      if (publishedPartIds.has(part.id)) return;

      const messageId = part.messageID;
      if (!messageId) {
        logger.warn('OpenCode event is missing a message ID', { eventType: event.type });
        return;
      }

      const messageRole = roleFromEvent || messageRoles.get(messageId) || null;
      if (!messageRole) return;

      if (part.type === 'tool') {
        if (part.state?.status === 'completed') {
          const toolUse = convertOpenCodeToolUse(now, part);
          chatMessages.push(toolUse);
          chatMessages.push(new ToolResultMessage(
            now,
            toolUse.toolId,
            normalizeToolResultContent(part.state.output),
            false,
          ));
        } else if (part.state?.status === 'error') {
          const toolUse = convertOpenCodeToolUse(now, part);
          chatMessages.push(toolUse);
          chatMessages.push(new ToolResultMessage(
            now,
            toolUse.toolId,
            normalizeToolResultContent(part.state.error || 'Error'),
            true,
          ));
        }
        attachPartIdentity(chatMessages, part.id);
        if (chatMessages.length > 0) publishedPartIds.add(part.id);
        break;
      }

      if (part.type === 'text' || part.type === 'reasoning') {
        assistantPartTypes.set(part.id, part.type);
      }

      if (part.text) {
        const partType = assistantPartTypes.get(part.id);
        if (!partType) {
          logger.warn('OpenCode final text part was not observed earlier', {
            eventType: event.type,
          });
          return;
        }
        assistantPartTypes.delete(part.id);

        if (partType === 'text') {
          chatMessages.push(new AssistantMessage(now, part.text));
        } else {
          chatMessages.push(new ThinkingMessage(now, part.text));
        }
        attachPartIdentity(chatMessages, part.id);
        publishedPartIds.add(part.id);
      }
      break;
    }

    case 'message.part.delta':
      break;

    default:
      break;
  }

  return chatMessages;
}

// The stable part ID is the canonical provider identity every rendered row
// from that part shares, live and in stored history alike.
function attachPartIdentity(rows: readonly ChatMessage[], partId: string): void {
  rows.forEach((row, withinSourceOrdinal) => {
    attachNativeMessageSource(row, { entryId: partId, withinSourceOrdinal });
  });
}
