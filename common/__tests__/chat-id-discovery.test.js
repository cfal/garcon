import { describe, expect, it } from 'bun:test';
import {
  appendChatIdDisclosure,
  CHAT_ID_DISCLOSURE_CLOSE,
  CHAT_ID_DISCLOSURE_OPEN,
  sanitizeImportedChatIdMessage,
  stripImportedChatIdDisclosure,
  transformChatIdRequest,
} from '../chat-id-discovery.ts';
import { parseChatId } from '../chat-id.ts';
import {
  AssistantMessage,
  ThinkingMessage,
  UserMessage,
} from '../chat-types.ts';

const AT = '2026-08-27T00:00:00.000Z';
const CHAT_ID = parseChatId('1787836573296800');
const OTHER_CHAT_ID = parseChatId('1787836573296801');

describe('chat ID discovery protocol', () => {
  it('transforms only the exact leading assistant marker', () => {
    expect(transformChatIdRequest(
      new AssistantMessage(AT, '<get-garcon-chat-id />working'),
    )).toEqual({ message: new AssistantMessage(AT, 'working') });
    expect(transformChatIdRequest(
      new AssistantMessage(AT, '<get-garcon-chat-id />'),
    )).toEqual({ message: null });
    expect(transformChatIdRequest(
      new AssistantMessage(AT, '<get-garcon-chat-id /> '),
    )).toEqual({ message: new AssistantMessage(AT, ' ') });

    for (const content of [
      ' <get-garcon-chat-id />',
      '<get-garcon-chat-id/>',
      '<GET-GARCON-CHAT-ID />',
      'quote <get-garcon-chat-id />',
    ]) {
      expect(transformChatIdRequest(new AssistantMessage(AT, content))).toBeNull();
    }
    expect(transformChatIdRequest(
      new ThinkingMessage(AT, '<get-garcon-chat-id />'),
    )).toBeNull();
    expect(transformChatIdRequest(
      new UserMessage(AT, '<get-garcon-chat-id />'),
    )).toBeNull();
  });

  it('appends and strips only a valid trailing disclosure envelope', () => {
    const disclosed = appendChatIdDisclosure('continue', CHAT_ID);
    expect(disclosed).toBe(
      `continue${CHAT_ID_DISCLOSURE_OPEN}${CHAT_ID}${CHAT_ID_DISCLOSURE_CLOSE}`,
    );
    expect(stripImportedChatIdDisclosure(disclosed)).toBe('continue');
    expect(stripImportedChatIdDisclosure(
      `continue${CHAT_ID_DISCLOSURE_OPEN}${OTHER_CHAT_ID}${CHAT_ID_DISCLOSURE_CLOSE}`,
    )).toBe('continue');

    for (const content of [
      `continue${CHAT_ID_DISCLOSURE_OPEN}invalid${CHAT_ID_DISCLOSURE_CLOSE}`,
      `continue${CHAT_ID_DISCLOSURE_OPEN}${CHAT_ID}`,
      `continue${CHAT_ID_DISCLOSURE_OPEN}${CHAT_ID}${CHAT_ID_DISCLOSURE_CLOSE} later`,
      `<garcon-chat-id>${CHAT_ID}</garcon-chat-id>`,
    ]) {
      expect(stripImportedChatIdDisclosure(content)).toBe(content);
    }
  });

  it('sanitizes imported messages without losing user fields', () => {
    expect(sanitizeImportedChatIdMessage(
      new AssistantMessage(AT, '<get-garcon-chat-id />answer'),
    )).toEqual(new AssistantMessage(AT, 'answer'));
    expect(sanitizeImportedChatIdMessage(
      new AssistantMessage(AT, '<get-garcon-chat-id />'),
    )).toBeNull();

    const user = new UserMessage(
      AT,
      appendChatIdDisclosure('continue', CHAT_ID),
      [{ data: 'image', name: 'image.png', mimeType: 'image/png' }],
      { clientMessageId: 'message-1' },
      { style: 'info' },
    );
    expect(sanitizeImportedChatIdMessage(user)).toEqual(new UserMessage(
      AT,
      'continue',
      user.images,
      user.metadata,
      user.presentation,
    ));
  });
});
