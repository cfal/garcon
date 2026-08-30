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
} from '../../../common/chat-types.ts';
import { frozenDrafts, importedDrafts } from '../imported-drafts.ts';

const AT = '2026-08-16T00:00:00.000Z';

describe('imported transcript drafts', () => {
  it('[TLV5-CHAT-ID-DISCOVERY.03-IMPORT-UNIT-01] strips requests and maps synthetic control inputs to one notice', () => {
    expect(importedDrafts([
      {
        message: new AssistantMessage(
          AT,
          '<garcon-get-chat-id />\nContinuing the response.',
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

  it('retains a hidden marker-only request without synthesizing an outcome', () => {
    expect(importedDrafts([
      { message: new AssistantMessage(AT, '<garcon-get-chat-id />'), providerMeta: null },
    ], () => AT)).toEqual([{
      kind: 'notice',
      at: AT,
      message: 'Agent requested chat ID',
      detail: { type: 'chat-id-request' },
      providerMeta: null,
    }]);
  });

  it('canonicalizes outgoing commands and incoming inter-agent envelopes without dispatch', () => {
    expect(importedDrafts([
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

  it('reconstructs start evidence and exact delivered results without dispatch', () => {
    const ref = '69b623a7-757e-49f6-93b8-4b7ea1bc569b';
    expect(importedDrafts([
      {
        message: new AssistantMessage(
          AT,
          'Retained answer.\n'
            + '<garcon-start-agent>\n'
            + `{"prompt":"Investigate the failure.","params":[{"ref":"${ref}","agent":"codex","model":"gpt-5.4","projectPath":"/projects/alpha","permissions":"plan"}]}\n`
            + '</garcon-start-agent>',
        ),
        providerMeta: { nativeIdentity: { id: 'assistant-start' } },
      },
      {
        message: new UserMessage(
          AT,
          `<garcon-create-chat-result ref="${ref}" error="false" msg="created" chat-id="1787974832309199" />`,
        ),
        providerMeta: { nativeIdentity: { id: 'start-result' } },
      },
    ], () => AT)).toEqual([
      {
        kind: 'provider-row',
        at: AT,
        message: new AssistantMessage(AT, 'Retained answer.'),
        providerMeta: { nativeIdentity: { id: 'assistant-start' } },
      },
      {
        kind: 'notice',
        at: AT,
        message: 'Agent requested sub-agent creation',
        detail: {
          type: 'sub-agent-start-request',
          prompt: 'Investigate the failure.',
          params: [{
            ref,
            agentId: 'codex',
            providerId: null,
            endpointId: null,
            model: 'gpt-5.4',
            reasoningEffort: null,
            projectPath: '/projects/alpha',
            permissionMode: 'plan',
          }],
        },
        providerMeta: null,
      },
      {
        kind: 'notice',
        at: AT,
        message: `Results delivered to the requesting agent.\nCreated: ${ref} -> chat 1787974832309199`,
        detail: {
          type: 'sub-agent-start-outcome',
          deliveryStatus: 'delivered',
          results: [{
            ref,
            error: false,
            msg: 'created',
            chatId: '1787974832309199',
          }],
          title: 'Sub-agent start',
        },
        providerMeta: null,
      },
    ]);
  });

  it('preserves malformed outgoing commands without synthesizing a diagnostic', () => {
    const message = new AssistantMessage(
      AT,
      '<garcon-send-message to="invalid" hide-sender="false">body</garcon-send-message>',
    );
    expect(importedDrafts([{ message, providerMeta: null }], () => AT)).toEqual([{
      kind: 'provider-row',
      at: AT,
      message,
      providerMeta: null,
    }]);
  });

  it('preserves non-standalone disclosure content', () => {
    const user = new UserMessage(
      AT,
      'Continue\n<garcon-chat-id>1787836573296800</garcon-chat-id>',
    );
    expect(importedDrafts([
      { message: user, providerMeta: null },
    ], () => AT)).toEqual([{
      kind: 'user-input',
      at: AT,
      detail: {
        clientMessageId: null,
        message: user,
        attachments: [],
        steer: false,
      },
      providerMeta: null,
    }]);
  });

  it('preserves non-standalone create-chat result content as user input', () => {
    const ref = '69b623a7-757e-49f6-93b8-4b7ea1bc569b';
    const user = new UserMessage(
      AT,
      `Continue\n<garcon-create-chat-result ref="${ref}" error="true" msg="disabled" />`,
    );
    expect(importedDrafts([{ message: user, providerMeta: null }], () => AT)).toEqual([{
      kind: 'user-input',
      at: AT,
      detail: {
        clientMessageId: null,
        message: user,
        attachments: [],
        steer: false,
      },
      providerMeta: null,
    }]);
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
