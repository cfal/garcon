import { describe, expect, it } from 'bun:test';
import {
  chatIdDisclosureContent,
  parseChatIdDisclosure,
} from '../chat-id-discovery.ts';
import { parseChatId } from '../chat-id.ts';

const AT = '2026-08-28T00:00:00.000Z';
const CHAT_ID = parseChatId('1787836573296800');

describe('chat ID discovery protocol', () => {
  it('round-trips only a standalone canonical disclosure envelope', () => {
    const content = chatIdDisclosureContent(CHAT_ID);
    expect(content).toBe('<garcon-chat-id>1787836573296800</garcon-chat-id>');
    expect(parseChatIdDisclosure(content)).toBe(CHAT_ID);
    expect(parseChatIdDisclosure(`prompt\n${content}`)).toBeNull();
    expect(parseChatIdDisclosure('<garcon-chat-id>invalid</garcon-chat-id>')).toBeNull();
  });
});
