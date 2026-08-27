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

describe('imported transcript drafts', () => {
  it('removes chat ID controls while preserving provider metadata', () => {
    const providerMeta = { providerOccurrence: 'provider-1' };
    expect(importedDrafts([
      {
        message: new AssistantMessage(AT, '<get-garcon-chat-id />answer'),
        providerMeta,
      },
      {
        message: new AssistantMessage(AT, '<get-garcon-chat-id />'),
        providerMeta: { providerOccurrence: 'provider-2' },
      },
      {
        message: new UserMessage(
          AT,
          'continue\n\n<garcon-chat-id>1787836573296801</garcon-chat-id>',
        ),
        providerMeta: { providerOccurrence: 'provider-3' },
      },
    ], () => AT)).toEqual([
      {
        kind: 'provider-row',
        at: AT,
        message: new AssistantMessage(AT, 'answer'),
        providerMeta,
      },
      {
        kind: 'user-input',
        at: AT,
        detail: {
          clientMessageId: null,
          message: new UserMessage(AT, 'continue'),
          attachments: [],
          steer: false,
        },
        providerMeta: { providerOccurrence: 'provider-3' },
      },
    ]);
  });

  it('does not synthesize discovery notices or alter malformed controls', () => {
    const assistant = new AssistantMessage(AT, ' <get-garcon-chat-id />answer');
    const user = new UserMessage(
      AT,
      'continue\n\n<garcon-chat-id>invalid</garcon-chat-id>',
    );
    expect(importedDrafts([
      { message: assistant, providerMeta: null },
      { message: user, providerMeta: null },
    ], () => AT)).toEqual([
      { kind: 'provider-row', at: AT, message: assistant, providerMeta: null },
      {
        kind: 'user-input',
        at: AT,
        detail: {
          clientMessageId: null,
          message: user,
          attachments: [],
          steer: false,
        },
        providerMeta: null,
      },
    ]);
  });
});
