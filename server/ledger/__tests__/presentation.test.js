import { describe, expect, it } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
  UserMessage,
} from '../../../common/chat-types.ts';
import {
  ledgerRowsToMessages,
  ledgerRowsToTranscriptMessages,
} from '../presentation.ts';

const AT = '2026-08-15T00:00:00.000Z';

describe('transcript ledger presentation', () => {
  it('preserves the permission occurrence UUID through presentation', () => {
    const messages = ledgerRowsToMessages([
      permissionRow(1, {
        kind: 'requested',
        permissionOccurrenceId: 'first-occurrence',
        requestedTool: new BashToolUseMessage(AT, 'tool-1', 'first command'),
        options: [],
      }),
      permissionRow(2, {
        kind: 'requested',
        permissionOccurrenceId: 'second-occurrence',
        requestedTool: new BashToolUseMessage(AT, 'tool-2', 'second command'),
        options: [],
      }),
      permissionRow(3, {
        kind: 'cancelled',
        permissionOccurrenceId: 'first-occurrence',
        reason: 'superseded',
      }),
    ]);

    expect(messages.map((message) => ({
      type: message.type,
      permissionOccurrenceId: message.permissionOccurrenceId,
    }))).toEqual([
      {
        type: 'permission-request',
        permissionOccurrenceId: 'first-occurrence',
      },
      {
        type: 'permission-request',
        permissionOccurrenceId: 'second-occurrence',
      },
      {
        type: 'permission-cancelled',
        permissionOccurrenceId: 'first-occurrence',
      },
    ]);
  });

  it('renders every visible row kind in ordinal order and omits internal lifecycle rows', () => {
    const rows = [
      {
        kind: 'user-input',
        ordinal: 1,
        at: AT,
        providerMeta: null,
        detail: {
          clientMessageId: 'client-message-1',
          message: new UserMessage(AT, 'user input'),
          attachments: [],
          steer: false,
        },
      },
      {
        kind: 'provider-row',
        ordinal: 2,
        at: AT,
        providerMeta: null,
        message: new AssistantMessage(AT, 'assistant output'),
      },
      {
        kind: 'notice',
        ordinal: 3,
        at: AT,
        providerMeta: null,
        message: 'Ordinary durable notice.',
        detail: { type: 'ordinary-notice' },
      },
      {
        kind: 'agent-switch',
        ordinal: 4,
        at: AT,
        providerMeta: null,
        detail: {
          fromAgentId: 'claude',
          toAgentId: 'codex',
          fromModel: 'haiku',
          toModel: 'gpt-5.4',
        },
      },
      permissionRow(5, {
        kind: 'requested',
        permissionOccurrenceId: 'incarnation-1',
        requestedTool: new BashToolUseMessage(AT, 'tool-1', 'pwd'),
        options: [],
      }),
      permissionRow(6, {
        kind: 'resolved',
        permissionOccurrenceId: 'incarnation-1',
        decision: { allow: true, alwaysAllow: false },
      }),
      permissionRow(7, {
        kind: 'cancelled',
        permissionOccurrenceId: 'incarnation-2',
        reason: 'provider-cancelled',
      }),
      permissionRow(8, {
        kind: 'expired',
        permissionOccurrenceId: 'incarnation-3',
      }),
      {
        kind: 'session',
        ordinal: 9,
        at: AT,
        providerMeta: null,
        detail: {
          agentSessionId: 'session-1',
          nativeSession: null,
          nativeSeedReceipt: null,
        },
      },
      {
        kind: 'run-ended',
        ordinal: 10,
        at: AT,
        providerMeta: null,
        outcome: 'finished',
        origin: 'provider',
      },
    ];

    const rendered = ledgerRowsToTranscriptMessages(rows);

    expect(rendered.map((entry) => [entry.ordinal, entry.message.type])).toEqual([
      [1, 'user-message'],
      [2, 'assistant-message'],
      [3, 'transcript-notice'],
      [4, 'agent-switch'],
      [5, 'permission-request'],
      [6, 'permission-resolved'],
      [7, 'permission-cancelled'],
      [8, 'permission-expired'],
    ]);
    expect(rendered[0].message.metadata).toEqual({ clientMessageId: 'client-message-1' });
    expect(rendered[2].message).toMatchObject({
      type: 'transcript-notice',
      content: 'Ordinary durable notice.',
    });
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
