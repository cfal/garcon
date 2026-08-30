import { describe, expect, it } from 'bun:test';
import { AssistantMessage, ThinkingMessage, UserMessage } from '../chat-types.ts';
import {
  CHAT_ID_DISCOVERY_REQUEST_MARKER,
  chatIdDisclosureContent,
  parseChatIdDisclosure,
  transformChatIdRequest,
} from '../chat-id-discovery.ts';
import { parseChatId } from '../chat-id.ts';

const AT = '2026-08-28T00:00:00.000Z';
const CHAT_ID = parseChatId('1787836573296800');

describe('chat ID discovery protocol', () => {
  it('removes a leading request marker while preserving following assistant content', () => {
    expect(transformChatIdRequest(new AssistantMessage(
      AT,
      `${CHAT_ID_DISCOVERY_REQUEST_MARKER}\nContinuing the response.`,
    ))).toEqual({
      message: new AssistantMessage(AT, 'Continuing the response.'),
    });
    expect(transformChatIdRequest(new AssistantMessage(
      AT,
      CHAT_ID_DISCOVERY_REQUEST_MARKER,
    ))).toEqual({ message: null });
  });

  it('ignores near-miss markers and non-assistant messages', () => {
    for (const content of [
      `Explanation ${CHAT_ID_DISCOVERY_REQUEST_MARKER}`,
      ` ${CHAT_ID_DISCOVERY_REQUEST_MARKER}`,
      '<garcon-get-chat-id/>',
      '<GARCON-GET-CHAT-ID />',
    ]) {
      expect(transformChatIdRequest(new AssistantMessage(AT, content))).toBeNull();
    }
    expect(transformChatIdRequest(new ThinkingMessage(
      AT,
      CHAT_ID_DISCOVERY_REQUEST_MARKER,
    ))).toBeNull();
    expect(transformChatIdRequest(new UserMessage(
      AT,
      CHAT_ID_DISCOVERY_REQUEST_MARKER,
    ))).toBeNull();
  });

  it('round-trips only a standalone canonical disclosure envelope', () => {
    const content = chatIdDisclosureContent(CHAT_ID);
    expect(content).toBe('<garcon-chat-id>1787836573296800</garcon-chat-id>');
    expect(parseChatIdDisclosure(content)).toBe(CHAT_ID);
    expect(parseChatIdDisclosure(`prompt\n${content}`)).toBeNull();
    expect(parseChatIdDisclosure('<garcon-chat-id>invalid</garcon-chat-id>')).toBeNull();
  });
});
