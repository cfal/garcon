import { expect, it } from 'bun:test';
import { AssistantMessage, BashToolUseMessage, parseChatMessage, parseChatMessages } from '../chat-types.js';
import { parseTranscriptMessage } from '../chat-view.js';

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
