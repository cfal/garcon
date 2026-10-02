import { describe, expect, it } from 'bun:test';
import { AssistantMessage, BashToolUseMessage, ErrorMessage, parseChatMessage, parseChatMessages } from '../chat-types.js';
import { parseTranscriptMessage } from '../chat-view.js';
import { parseServerWsMessage } from '../ws-events.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const invalid = [null, undefined, false, 42, 'message', [], {},
  ...['constructor', 'toString', '__proto__', 'hasOwnProperty', 'unknown-type'].map(type => ({ type, timestamp }))];

it('rejects nonrecords, unknown types, and inherited parser names', () => {
  for (const message of invalid) expect(parseChatMessage(message)).toBeNull();
});

it('drops invalid entries without losing valid messages in mixed arrays', () => {
  const assistant = new AssistantMessage(timestamp, 'Synthetic reply');
  const tool = new BashToolUseMessage(timestamp, 'tool-1', 'pwd');
  expect(parseChatMessages([...invalid, assistant, null, tool])).toEqual([assistant, tool]);
  expect(parseChatMessages(null)).toEqual([]);
});

it('keeps an unsupported-message placeholder at the original browser ordinal', () => {
  for (const message of invalid) {
    expect(parseTranscriptMessage({ ordinal: 7, message })).toMatchObject({
      ordinal: 7,
      message: { type: 'error', content: 'This message type is not supported by this app version. Reload to update.' },
    });
  }
});

describe('unsupported chat message types', () => {
  it.each(['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'rejects inherited parser key %s and preserves the transcript fallback',
    (type) => {
      const message = { type, timestamp, content: 'Synthetic unsupported message' };
      expect(parseChatMessage(message)).toBeNull();
      const fallback = parseTranscriptMessage({ ordinal: 2, message });
      expect(fallback.ordinal).toBe(2);
      expect(fallback.message).toBeInstanceOf(ErrorMessage);
      expect(fallback.message.timestamp).toBe(timestamp);
      expect(fallback.message.content).toContain('not supported');

      const first = new AssistantMessage(timestamp, 'Synthetic first message');
      const last = new AssistantMessage(timestamp, 'Synthetic last message');
      const batch = parseServerWsMessage({
        type: 'chat-messages',
        chatId: '1700000000000001',
        transcriptViewId: 'synthetic-view',
        firstOrdinal: 1,
        lastOrdinal: 3,
        resendCandidates: [],
        messages: [
          { ordinal: 1, message: first },
          { ordinal: 2, message },
          { ordinal: 3, message: last },
        ],
      });
      expect(batch.messages).toEqual([
        { ordinal: 1, message: first },
        fallback,
        { ordinal: 3, message: last },
      ]);
    },
  );
});
