import { describe, expect, it } from 'bun:test';
import {
  CommandRequestValidationError,
  parseAgentRunCommandRequest,
  parseForkChatCommandRequest,
  parsePermissionDecisionCommandRequest,
  parseQueueEntryReplaceCommandRequest,
  parseStartChatCommandRequest,
} from '../chat-command-contracts.ts';

const CHAT_ID = '1783725900000000';
const SOURCE_CHAT_ID = '1783725900000001';

function agentSettings(ownerId = 'claude') {
  return { ownerId, schemaVersion: 1, values: {} };
}

describe('chat command request parsers', () => {
  it('normalizes start modes and tags once at the wire boundary', () => {
    const parsed = parseStartChatCommandRequest({
      clientRequestId: ' request-1 ',
      clientMessageId: ' message-1 ',
      chatId: CHAT_ID,
      agentId: 'claude',
      projectPath: ' /repo ',
      model: ' opus ',
      permissionMode: 'not-a-mode',
      thinkingMode: 'not-a-mode',
      agentSettings: agentSettings(),
      command: ' hello ',
      tags: ['Review Needed', 'review-needed', ' QA ', 42],
    });

    expect(parsed).toMatchObject({
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      projectPath: '/repo',
      model: 'opus',
      permissionMode: 'default',
      thinkingMode: 'none',
      command: 'hello',
      tags: ['qa', 'review-needed'],
    });
  });

  it('returns a fully typed run request with canonical defaults', () => {
    const parsed = parseAgentRunCommandRequest({
      clientRequestId: 'request-2',
      clientMessageId: 'message-2',
      chatId: CHAT_ID,
      command: 'continue',
      agentSettings: agentSettings(),
      model: 'opus',
    });

    expect(parsed.permissionMode).toBe('default');
    expect(parsed.thinkingMode).toBe('none');
    expect(parsed.agentSettings).toEqual(agentSettings());
  });

  it('rejects malformed command identities and fork cutoffs', () => {
    expect(() => parseAgentRunCommandRequest({
      clientRequestId: 'request-3',
      clientMessageId: 'message-3',
      chatId: 'not-a-chat-id',
      command: 'continue',
      agentSettings: agentSettings(),
      model: 'opus',
    })).toThrow('chatId must be a valid 16-digit Unix-microsecond timestamp');

    expect(() => parseForkChatCommandRequest({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: CHAT_ID,
      upToSeq: '2abc',
    })).toThrow('upToSeq must be a positive integer');
  });

  it('rejects malformed structured command fields', () => {
    expect(() => parseQueueEntryReplaceCommandRequest({
      clientRequestId: 'request-4',
      chatId: CHAT_ID,
      entryId: 'entry-1',
      content: 'replacement',
      expectedRevision: 0,
    })).toThrow('expectedRevision must be a positive integer');

    expect(() => parsePermissionDecisionCommandRequest({
      clientRequestId: 'request-5',
      chatId: CHAT_ID,
      permissionRequestId: 'permission-1',
      allow: 'yes',
      alwaysAllow: false,
    })).toThrow('allow must be a boolean');
  });

  it('uses one stable validation error type', () => {
    expect(() => parseStartChatCommandRequest(null)).toThrow(CommandRequestValidationError);
  });
});
