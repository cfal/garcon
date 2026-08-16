import { describe, expect, it } from 'bun:test';
import { parseChatMessage } from '../chat-types.ts';

const AT = '2026-08-15T00:00:00.000Z';

describe('permission message contracts', () => {
  it('[TLV5-PERM.03-CONTRACT-01] round-trips the occurrence UUID for every permission lifecycle message', () => {
    const messages = [
      {
        type: 'permission-request',
        timestamp: AT,
        permissionOccurrenceId: 'requested-occurrence',
        requestedTool: {
          type: 'bash-tool-use',
          timestamp: AT,
          toolId: 'tool-1',
          command: 'bun test',
        },
      },
      {
        type: 'permission-resolved',
        timestamp: AT,
        permissionOccurrenceId: 'resolved-occurrence',
        allowed: true,
      },
      {
        type: 'permission-cancelled',
        timestamp: AT,
        permissionOccurrenceId: 'cancelled-occurrence',
        reason: 'aborted',
      },
      {
        type: 'permission-expired',
        timestamp: AT,
        permissionOccurrenceId: 'expired-occurrence',
      },
    ];

    expect(messages.map((message) => parseChatMessage(message)?.permissionOccurrenceId)).toEqual([
      'requested-occurrence',
      'resolved-occurrence',
      'cancelled-occurrence',
      'expired-occurrence',
    ]);
    expect(messages.map((message) => JSON.parse(JSON.stringify(parseChatMessage(message))))).toEqual(messages);
  });

  it('rejects a permission lifecycle message without occurrence identity', () => {
    expect(parseChatMessage({
      type: 'permission-cancelled',
      timestamp: AT,
      reason: 'aborted',
    })).toBeNull();
  });
});
