import { expect, test } from 'bun:test';
import { ClaudeTurnState } from '../cli-protocol.js';

test.each([
  {
    label: 'rejects foreign input IDs',
    attribution: { user_message_uuid: 'other-input', user_message_uuids: ['other-input'] },
    expected: 'mismatched',
  },
  {
    label: 'accepts an earlier input in a merged result',
    attribution: { user_message_uuid: 'other-input', user_message_uuids: ['submitted-input', 'other-input'] },
    expected: 'input',
  },
  {
    label: 'preserves the untagged fallback for an empty list',
    attribution: { user_message_uuids: [] },
    expected: 'input',
  },
])('$label', ({ attribution, expected }) => {
  const turn = new ClaudeTurnState('submitted-input');
  const result = { type: 'result', ...attribution };

  expect(turn.correlateResult(result)).toBe('before-start');
  turn.observeInput({ type: 'command_lifecycle', state: 'started', command_uuid: turn.inputUuid });
  expect(turn.correlateResult(result)).toBe(expected);
});
