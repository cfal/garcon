import { expect, test } from 'bun:test';
import { ClaudeTurnState } from '../cli-protocol.js';

test.each([
  { reported: ['other-input'], expected: 'mismatched' },
  { reported: ['submitted-input', 'other-input'], expected: 'input' },
  { reported: [], expected: 'input' },
])('correlates a first result with plural input IDs $reported', ({ reported, expected }) => {
  const turn = new ClaudeTurnState('submitted-input');
  const result = { type: 'result', user_message_uuids: reported };

  expect(turn.correlateResult(result)).toBe('before-start');
  turn.observeInput({ type: 'command_lifecycle', state: 'started', command_uuid: turn.inputUuid });
  expect(turn.correlateResult(result)).toBe(expected);
});
