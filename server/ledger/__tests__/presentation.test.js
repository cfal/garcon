import { describe, expect, it } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
  ErrorMessage,
  TranscriptNoticeMessage,
  UserMessage,
} from '../../../common/chat-types.ts';
import {
  ledgerRowsToMessages,
  ledgerRowsToTranscriptMessages,
  ledgerRowToMessage,
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
      {
        kind: 'notice',
        ordinal: 5,
        at: AT,
        providerMeta: null,
        message: '  exact notice\n',
        detail: {
          type: 'cli-row',
          clientMessageId: 'chat-row-notice',
          presentation: 'notice',
          title: 'Deployment',
        },
      },
      {
        kind: 'notice',
        ordinal: 6,
        at: AT,
        providerMeta: null,
        message: 'exact error',
        detail: {
          type: 'cli-row',
          clientMessageId: 'chat-row-error',
          presentation: 'error',
          title: null,
        },
      },
      permissionRow(7, {
        kind: 'requested',
        permissionOccurrenceId: 'incarnation-1',
        requestedTool: new BashToolUseMessage(AT, 'tool-1', 'pwd'),
        options: [],
      }),
      permissionRow(8, {
        kind: 'resolved',
        permissionOccurrenceId: 'incarnation-1',
        decision: { allow: true, alwaysAllow: false },
      }),
      permissionRow(9, {
        kind: 'cancelled',
        permissionOccurrenceId: 'incarnation-2',
        reason: 'provider-cancelled',
      }),
      permissionRow(10, {
        kind: 'expired',
        permissionOccurrenceId: 'incarnation-3',
      }),
      {
        kind: 'session',
        ordinal: 11,
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
        ordinal: 12,
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
      [5, 'transcript-notice'],
      [6, 'error'],
      [7, 'permission-request'],
      [8, 'permission-resolved'],
      [9, 'permission-cancelled'],
      [10, 'permission-expired'],
    ]);
    expect(rendered[0].message.metadata).toEqual({ clientMessageId: 'client-message-1' });
    expect(rendered[2].message).toMatchObject({
      type: 'transcript-notice',
      content: 'Ordinary durable notice.',
    });
    expect(rendered[2].message.title).toBeUndefined();
    const titled = ledgerRowToMessage({
      kind: 'notice',
      ordinal: 13,
      at: AT,
      providerMeta: null,
      message: 'Model provider retrying: quota exhausted.',
      detail: { title: 'Provider retry' },
    });
    expect(titled).toBeInstanceOf(TranscriptNoticeMessage);
    expect(titled).toMatchObject({
      content: 'Model provider retrying: quota exhausted.',
      title: 'Provider retry',
    });
    expect(titled.detail).toBeUndefined();
    expect(rendered[4].message).toBeInstanceOf(TranscriptNoticeMessage);
    expect(rendered[4].message).toMatchObject({ content: '  exact notice\n' });
    expect(rendered[4].message.detail).toEqual({
      type: 'cli-row',
      title: 'Deployment',
    });
    expect(rendered[5].message).toBeInstanceOf(ErrorMessage);
    expect(rendered[5].message).toMatchObject({ content: 'exact error', timestamp: AT });
    expect(rendered[5].message.detail).toEqual({ type: 'cli-row' });
    expect(JSON.stringify([rendered[4].message, rendered[5].message]))
      .not.toContain('clientMessageId');
    expect(JSON.stringify([rendered[4].message, rendered[5].message]))
      .not.toContain('presentation');
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
