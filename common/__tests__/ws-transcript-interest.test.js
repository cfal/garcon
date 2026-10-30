import { describe, expect, it } from 'bun:test';
import { parseServerWsMessage } from '../ws-events.ts';
import { ChatTranscriptAdvancedMessage } from '../ws-transcript-summary.ts';
import {
  ChatTranscriptInterestRequest,
  MAX_TRANSCRIPT_INTEREST_CHAT_IDS,
  parseClientWsMessage,
} from '../ws-requests.ts';
import { AssistantMessage } from '../chat-types.ts';
import { summarizeTranscriptActivity } from '../chat-transcript-activity.ts';

const CHAT_ID = '1785337200123456';
const OTHER_CHAT_ID = '1785337200123457';
const answer = new AssistantMessage('2026-08-11T00:00:00.000Z', 'Synthetic answer');
const activity = summarizeTranscriptActivity([answer]);

function wire(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('chat-transcript-interest request contract', () => {
  it('replaces the declared set with the parsed chat IDs', () => {
    const parsed = parseClientWsMessage(wire(new ChatTranscriptInterestRequest([CHAT_ID, OTHER_CHAT_ID])));

    expect(parsed).toBeInstanceOf(ChatTranscriptInterestRequest);
    expect(parsed.chatIds).toEqual([CHAT_ID, OTHER_CHAT_ID]);
  });

  it('accepts an empty set and collapses duplicate IDs', () => {
    expect(parseClientWsMessage({ type: 'chat-transcript-interest', chatIds: [] }).chatIds).toEqual([]);
    expect(parseClientWsMessage({
      type: 'chat-transcript-interest',
      chatIds: [CHAT_ID, CHAT_ID],
    }).chatIds).toEqual([CHAT_ID]);
  });

  it('rejects malformed or oversized declarations instead of narrowing them', () => {
    expect(parseClientWsMessage({ type: 'chat-transcript-interest' })).toBeNull();
    expect(parseClientWsMessage({ type: 'chat-transcript-interest', chatIds: CHAT_ID })).toBeNull();
    expect(parseClientWsMessage({ type: 'chat-transcript-interest', chatIds: [CHAT_ID, 7] })).toBeNull();
    expect(parseClientWsMessage({ type: 'chat-transcript-interest', chatIds: [''] })).toBeNull();
    const oversized = Array.from(
      { length: MAX_TRANSCRIPT_INTEREST_CHAT_IDS + 1 },
      (_, index) => String(1785337200000000 + index),
    );
    expect(parseClientWsMessage({ type: 'chat-transcript-interest', chatIds: oversized })).toBeNull();
  });

  it('accepts the maximum number of canonical chat IDs', () => {
    const chatIds = Array.from(
      { length: MAX_TRANSCRIPT_INTEREST_CHAT_IDS },
      (_, index) => String(1785337200000000 + index),
    );
    expect(parseClientWsMessage({ type: 'chat-transcript-interest', chatIds }).chatIds).toEqual(chatIds);
  });

  it('rejects an oversized raw array even when all IDs are duplicates', () => {
    const chatIds = Array(MAX_TRANSCRIPT_INTEREST_CHAT_IDS + 1).fill(CHAT_ID);
    expect(parseClientWsMessage({ type: 'chat-transcript-interest', chatIds })).toBeNull();
  });

  it('rejects oversized identifiers without retaining them', () => {
    const parsed = parseClientWsMessage({
      type: 'chat-transcript-interest',
      chatIds: ['1'.repeat(256 * 1024)],
    });
    expect(parsed === null).toBeTrue();
  });

  it.each(['chat-a', '1785337200123', '17853372001234567', '0000000000000000', '9999999999999999', ` ${CHAT_ID}`, `${CHAT_ID}\n`])(
    'rejects the noncanonical chat ID %j', (chatId) => {
      expect(parseClientWsMessage({ type: 'chat-transcript-interest', chatIds: [chatId] })).toBeNull();
    },
  );
});

describe('transcript delivery event contract', () => {
  it('round-trips the body-free summary for undisplayed chats', () => {
    const summary = new ChatTranscriptAdvancedMessage(CHAT_ID, 'view-1', 4, 6, activity);
    const raw = wire(summary);
    const parsed = parseServerWsMessage(raw);

    expect(raw).not.toHaveProperty('messages');
    expect(parsed).toBeInstanceOf(ChatTranscriptAdvancedMessage);
    expect(parsed).toEqual(summary);
  });

  it('rejects summaries without a valid span or activity', () => {
    const raw = wire(new ChatTranscriptAdvancedMessage(CHAT_ID, 'view-1', 4, 6, activity));

    expect(parseServerWsMessage({ ...raw, firstOrdinal: 0 })).toBeNull();
    expect(parseServerWsMessage({ ...raw, lastOrdinal: 2 })).toBeNull();
    expect(parseServerWsMessage({ ...raw, transcriptViewId: '' })).toBeNull();
    expect(parseServerWsMessage({ ...raw, chatId: 7 })).toBeNull();
    expect(parseServerWsMessage({ ...raw, activity: null })).toBeNull();
  });
});
