import { describe, expect, it } from 'bun:test';
import { BashToolUseMessage } from '../../../common/chat-types.ts';
import { ledgerRowsToMessages } from '../presentation.ts';

const AT = '2026-08-15T00:00:00.000Z';

describe('transcript ledger permission presentation', () => {
  it('preserves permission incarnation when a provider reuses a request id', () => {
    const messages = ledgerRowsToMessages([
      permissionRow(1, {
        kind: 'requested',
        requestId: 'shared-request',
        incarnation: 'first-occurrence',
        requestedTool: new BashToolUseMessage(AT, 'tool-1', 'first command'),
        options: [],
      }),
      permissionRow(2, {
        kind: 'requested',
        requestId: 'shared-request',
        incarnation: 'second-occurrence',
        requestedTool: new BashToolUseMessage(AT, 'tool-2', 'second command'),
        options: [],
      }),
      permissionRow(3, {
        kind: 'cancelled',
        requestId: 'shared-request',
        incarnation: 'first-occurrence',
        reason: 'superseded',
      }),
    ]);

    expect(messages.map((message) => ({
      type: message.type,
      requestId: message.permissionRequestId,
      incarnation: message.incarnation,
    }))).toEqual([
      {
        type: 'permission-request',
        requestId: 'shared-request',
        incarnation: 'first-occurrence',
      },
      {
        type: 'permission-request',
        requestId: 'shared-request',
        incarnation: 'second-occurrence',
      },
      {
        type: 'permission-cancelled',
        requestId: 'shared-request',
        incarnation: 'first-occurrence',
      },
    ]);
  });
});

function permissionRow(ordinal, lifecycle) {
  return {
    kind: `permission-${lifecycle.kind}`,
    ordinal,
    at: AT,
    providerMeta: null,
    lifecycle,
  };
}
