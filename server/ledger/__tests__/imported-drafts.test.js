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
import { frozenDrafts } from '../imported-drafts.ts';

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
      new TranscriptNoticeMessage(AT, quarantineMessage, undefined, quarantineDetail),
      new TranscriptNoticeMessage(AT, 'The transcript may have changed.', 'reload-native-history'),
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
