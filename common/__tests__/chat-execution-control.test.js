import { describe, expect, it } from 'bun:test';
import {
  MAX_CHAT_EXECUTION_CONTROL_SERVER_INSTANCE_ID_LENGTH,
  emptyChatExecutionControlState,
  parseChatExecutionControlState,
  parseExecutionControlServerInstanceId,
} from '../chat-execution-control.ts';

describe('chat execution control contract', () => {
  it('requires an explicit server instance for empty controls', () => {
    expect(emptyChatExecutionControlState('server-instance-test')).toMatchObject({
      serverInstanceId: 'server-instance-test',
      version: 0,
      updatedAt: null,
    });
  });

  it('parses bounded opaque server instance IDs without normalizing them', () => {
    expect(parseExecutionControlServerInstanceId('server-a')).toBe('server-a');
    expect(
      parseExecutionControlServerInstanceId(
        'x'.repeat(MAX_CHAT_EXECUTION_CONTROL_SERVER_INSTANCE_ID_LENGTH),
      ),
    ).toHaveLength(MAX_CHAT_EXECUTION_CONTROL_SERVER_INSTANCE_ID_LENGTH);

    for (const value of [
      undefined,
      null,
      '',
      ' server-a',
      'server-a ',
      'x'.repeat(MAX_CHAT_EXECUTION_CONTROL_SERVER_INSTANCE_ID_LENGTH + 1),
    ]) {
      expect(parseExecutionControlServerInstanceId(value)).toBeNull();
    }
  });

  it('rejects controls without a valid server instance ID', () => {
    const valid = emptyChatExecutionControlState('server-a');
    expect(parseChatExecutionControlState(valid)).toEqual(valid);

    for (const serverInstanceId of [undefined, null, '', ' server-a', 'server-a ']) {
      expect(parseChatExecutionControlState({ ...valid, serverInstanceId })).toBeNull();
    }
  });
});
