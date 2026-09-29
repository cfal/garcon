import { describe, expect, it } from 'bun:test';
import {
  AgentSwitchMessage,
  AssistantMessage,
  BashToolUseMessage,
  PermissionCancelledMessage,
  PermissionExpiredMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  TranscriptNoticeMessage,
  UserMessage,
} from '../../../../common/chat-types.ts';
import { frozenDrafts, importedDrafts } from '../imported-drafts.ts';

const AT = '2026-08-16T00:00:00.000Z';

describe('imported transcript drafts', () => {
  it('[TLV5-CHAT-ID-DISCOVERY.03-IMPORT-UNIT-01] strips requests and maps synthetic control inputs to one notice', async () => {
    expect(await importedDrafts([
      {
        message: new AssistantMessage(
          AT,
          '<garcon-get-chat-id />\n\nContinuing the response.',
        ),
        providerMeta: { nativeIdentity: { id: 'assistant-1' } },
      },
      {
        message: new UserMessage(
          AT,
          '<garcon-chat-id>1787836573296800</garcon-chat-id>',
        ),
        providerMeta: { nativeIdentity: { id: 'user-1' } },
      },
    ], () => AT)).toEqual([
      {
        kind: 'provider-row',
        at: AT,
        message: new AssistantMessage(AT, 'Continuing the response.'),
        providerMeta: { nativeIdentity: { id: 'assistant-1' } },
      },
      {
        kind: 'notice',
        at: AT,
        message: 'Agent requested chat ID',
        detail: { type: 'chat-id-request' },
        providerMeta: null,
      },
      {
        kind: 'notice',
        at: AT,
        message: 'Sent chat ID 1787836573296800 to agent.',
        detail: { type: 'chat-id-disclosure', title: 'Chat ID auto-discovery' },
        providerMeta: null,
      },
    ]);
  });

  it('retains a hidden marker-only request without synthesizing an outcome', async () => {
    expect(await importedDrafts([
      { message: new AssistantMessage(AT, '<garcon-get-chat-id />\n\n'), providerMeta: null },
    ], () => AT)).toEqual([{
      kind: 'notice',
      at: AT,
      message: 'Agent requested chat ID',
      detail: { type: 'chat-id-request' },
      providerMeta: null,
    }]);
  });

  it('canonicalizes outgoing commands and incoming inter-agent envelopes without dispatch', async () => {
    expect(await importedDrafts([
      {
        message: new AssistantMessage(
          AT,
          'Retained answer.\n'
            + '<garcon-send-message to="1787974832309199, 1787973671383699" hide-sender="false">\n'
            + 'message body\n'
            + '</garcon-send-message>',
        ),
        providerMeta: { nativeIdentity: { id: 'assistant-1' } },
      },
      {
        message: new UserMessage(
          AT,
          '<garcon-message from="1787974832309199">\nmessage body\n</garcon-message>',
        ),
        providerMeta: { nativeIdentity: { id: 'user-1' } },
      },
      {
        message: new UserMessage(
          AT,
          '<garcon-message>\nhidden body\n</garcon-message>',
        ),
        providerMeta: { nativeIdentity: { id: 'user-2' } },
      },
    ], () => AT)).toEqual([
      {
        kind: 'provider-row',
        at: AT,
        message: new AssistantMessage(AT, 'Retained answer.'),
        providerMeta: { nativeIdentity: { id: 'assistant-1' } },
      },
      {
        kind: 'notice',
        at: AT,
        message: 'Agent requested inter-agent message delivery',
        detail: {
          type: 'inter-agent-send-request',
          recipients: ['1787974832309199', '1787973671383699'],
          hideSender: false,
          body: 'message body',
        },
        providerMeta: null,
      },
      {
        kind: 'notice',
        at: AT,
        message: 'message body',
        detail: {
          type: 'inter-agent-message-received',
          fromChatId: '1787974832309199',
          title: 'Message from chat 1787974832309199',
        },
        providerMeta: null,
      },
      {
        kind: 'notice',
        at: AT,
        message: 'hidden body',
        detail: {
          type: 'inter-agent-message-received',
          fromChatId: null,
          title: 'Inter-agent message',
        },
        providerMeta: null,
      },
    ]);
  });

  it('preserves malformed outgoing commands without synthesizing a diagnostic', async () => {
    const message = new AssistantMessage(
      AT,
      '<garcon-send-message to="invalid" hide-sender="false">body</garcon-send-message>',
    );
    expect(await importedDrafts([{ message, providerMeta: null }], () => AT)).toEqual([{
      kind: 'provider-row',
      at: AT,
      message,
      providerMeta: null,
    }]);
  });

  it('preserves non-standalone disclosure content', async () => {
    const user = new UserMessage(
      AT,
      'Continue\n<garcon-chat-id>1787836573296800</garcon-chat-id>',
    );
    expect(await importedDrafts([
      { message: user, providerMeta: null },
    ], () => AT)).toEqual([{
      kind: 'user-input',
      at: AT,
      detail: {
        clientMessageId: null,
        message: user,
        attachments: [],
        steer: false,
        preambleBoundary: null,
        preamblePrefixReceipt: null,
      },
      providerMeta: null,
    }]);
  });

  it('converts a long history in bounded steps and still parses its Garcon elements', async () => {
    // Markup defeats the prefix pre-check, so converting these in one pass would take several
    // times the limit.
    const rows = [];
    for (let index = 0; index < 60_000; index += 1) {
      rows.push({ message: new UserMessage(AT, `<garcon-message from="1">Request ${index}</garcon-message> ${'Synthetic content. '.repeat(12)}`), providerMeta: null });
      rows.push({ message: new AssistantMessage(AT, `Reply ${index}. <garcon-note>x</garcon-note> ${'Synthetic content. '.repeat(12)}`), providerMeta: null });
    }
    rows.push({ message: new AssistantMessage(AT, '<garcon-get-chat-id />'), providerMeta: null });
    let last = performance.now();
    let longestGap = 0;
    const probe = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 1);
    const drafts = await importedDrafts(rows, () => AT);
    // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
    await new Promise((resolve) => setTimeout(resolve, 5));
    clearInterval(probe);

    expect(drafts).toHaveLength(120_001);
    expect(drafts.at(-1)).toMatchObject({ kind: 'notice', detail: { type: 'chat-id-request' } });
    expect(longestGap).toBeLessThan(100);
  });
});

describe('frozen transcript drafts', () => {
  it('[TLV5-ADOPT.09-FROZEN-CONVERSATION-UNIT-01] preserves user identity and provider-rendered rows without provider metadata', () => {
    const user = new UserMessage(AT, 'frozen question', undefined, {
      clientMessageId: 'legacy-client-message',
      upstreamRequestId: 'upstream-message',
    });
    const assistant = new AssistantMessage(AT, 'frozen answer');
    const tool = new BashToolUseMessage(AT, 'tool-1', 'pwd');

    expect(frozenDrafts([user, assistant, tool])).toEqual([
      {
        kind: 'user-input',
        at: AT,
        detail: {
          clientMessageId: 'upstream-message',
          message: user,
          attachments: [],
          steer: false,
          preambleBoundary: null,
          preamblePrefixReceipt: null,
        },
        providerMeta: null,
      },
      { kind: 'provider-row', at: AT, message: assistant, providerMeta: null },
      { kind: 'provider-row', at: AT, message: tool, providerMeta: null },
    ]);
  });

  it('[TLV5-ADOPT.09-FROZEN-DRAFT-UNIT-01] maps an ownership boundary to a durable agent-switch row', () => {
    expect(frozenDrafts([
      new AgentSwitchMessage(AT, 'claude', 'codex', 'opus', 'gpt-5.4'),
    ])).toEqual([{
      kind: 'agent-switch',
      at: AT,
      detail: {
        fromAgentId: 'claude',
        toAgentId: 'codex',
        fromModel: 'opus',
        toModel: 'gpt-5.4',
      },
      providerMeta: null,
    }]);
  });

  it('[TLV5-ADOPT.09-FROZEN-NOTICE-UNIT-01] preserves only the typed quarantine notice from core lifecycle presentation', () => {
    const quarantineDetail = {
      type: 'carryover-migration-quarantine',
      artifactId: 'artifact-1',
      errorCode: 'CARRYOVER_PARSE_FAILED',
    };
    const quarantineMessage = 'Some earlier chat history could not be migrated. Quarantine reference: artifact-1.';
    const requestedTool = new BashToolUseMessage(AT, 'tool-1', 'pwd');

    expect(frozenDrafts([
      new TranscriptNoticeMessage(AT, quarantineMessage, quarantineDetail),
      new TranscriptNoticeMessage(AT, 'Ordinary transcript notice.'),
      new TranscriptNoticeMessage(AT, quarantineMessage),
      new PermissionRequestMessage(AT, 'permission-1', requestedTool),
      new PermissionResolvedMessage(AT, 'permission-1', true),
      new PermissionCancelledMessage(AT, 'permission-2', 'cancelled'),
      new PermissionExpiredMessage(AT, 'permission-3'),
    ])).toEqual([{
      kind: 'notice',
      at: AT,
      message: quarantineMessage,
      detail: quarantineDetail,
      providerMeta: null,
    }]);
  });
});
