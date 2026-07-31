import { describe, expect, it } from 'bun:test';
import {
  COMMAND_CORRELATION_ID_MAX_BYTES,
  CommandRequestValidationError,
  parseAgentRunCommandRequest,
  parseForkChatCommandRequest,
  parseForkRunCommandRequest,
  parseGoalControlCommandRequest,
  parsePermissionDecisionCommandRequest,
  parseQueueEntryMoveCommandRequest,
  parseQueueEntryReplaceCommandRequest,
  parseStartChatCommandRequest,
  parseSteerCommandRequest,
} from '../chat-command-contracts.ts';
import {
  CHAT_STOP_OUTCOMES,
  isAbortAcknowledged,
  isStopSatisfied,
} from '../chat-types.ts';

const CHAT_ID = '1783725900000000';
const SOURCE_CHAT_ID = '1783725900000001';

function agentSettings(ownerId = 'claude') {
  return { ownerId, schemaVersion: 1, values: {} };
}

describe('chat command request parsers', () => {
  it('classifies every Stop outcome by command satisfaction and provider acknowledgement', () => {
    expect(CHAT_STOP_OUTCOMES.map((outcome) => ({
      outcome,
      satisfied: isStopSatisfied(outcome),
      acknowledged: isAbortAcknowledged(outcome),
    }))).toEqual([
      { outcome: 'interrupt-requested', satisfied: true, acknowledged: true },
      { outcome: 'already-idle', satisfied: true, acknowledged: false },
      { outcome: 'failed', satisfied: false, acknowledged: false },
    ]);
  });

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

  it('preserves omitted resume overrides and normalizes additive tags', () => {
    const parsed = parseAgentRunCommandRequest({
      clientRequestId: 'request-2',
      clientMessageId: 'message-2',
      chatId: CHAT_ID,
      command: 'continue',
      agentSettings: agentSettings(),
      model: 'opus',
      expectedAgentId: 'claude',
      tagsToAdd: ['CLI', 'cli', ' Review '],
    });

    expect(parsed.permissionMode).toBeUndefined();
    expect(parsed.thinkingMode).toBeUndefined();
    expect(parsed.agentSettings).toEqual(agentSettings());
    expect(parsed.expectedAgentId).toBe('claude');
    expect(parsed.tagsToAdd).toEqual(['cli', 'review']);
  });

  it('rejects partial routing and non-canonical explicit modes', () => {
    const base = {
      clientRequestId: 'request-routing',
      clientMessageId: 'message-routing',
      chatId: CHAT_ID,
      command: 'continue',
    };
    expect(() => parseAgentRunCommandRequest({ ...base, apiProviderId: 'provider' }))
      .toThrow('model is required with routing overrides');
    expect(() => parseAgentRunCommandRequest({ ...base, model: 'opus', permissionMode: 'unsafe' }))
      .toThrow('permissionMode is invalid');
    expect(() => parseAgentRunCommandRequest({ ...base, model: 'opus', thinkingMode: 'think-hard' }))
      .toThrow('thinkingMode is invalid');
  });

  it('requires distinct request and message identities for steering', () => {
    expect(parseSteerCommandRequest({
      clientRequestId: ' request-steer ',
      clientMessageId: ' message-steer ',
      chatId: CHAT_ID,
      content: ' focus here ',
    })).toEqual({
      clientRequestId: 'request-steer',
      clientMessageId: 'message-steer',
      chatId: CHAT_ID,
      content: ' focus here ',
    });
    expect(() => parseSteerCommandRequest({
      clientRequestId: 'request-steer',
      chatId: CHAT_ID,
      content: 'focus here',
    })).toThrow(CommandRequestValidationError);
  });

  it('bounds command correlation identities by UTF-8 byte length', () => {
    const base = {
      clientRequestId: 'request-steer',
      clientMessageId: 'message-steer',
      chatId: CHAT_ID,
      content: 'focus here',
    };

    expect(parseSteerCommandRequest({
      ...base,
      clientRequestId: 'x'.repeat(COMMAND_CORRELATION_ID_MAX_BYTES),
    }).clientRequestId).toHaveLength(COMMAND_CORRELATION_ID_MAX_BYTES);
    expect(() => parseSteerCommandRequest({
      ...base,
      clientRequestId: 'x'.repeat(COMMAND_CORRELATION_ID_MAX_BYTES + 1),
    })).toThrow(`clientRequestId must be at most ${COMMAND_CORRELATION_ID_MAX_BYTES} bytes`);
    expect(() => parseSteerCommandRequest({
      ...base,
      clientMessageId: '\u00e9'.repeat((COMMAND_CORRELATION_ID_MAX_BYTES / 2) + 1),
    })).toThrow(`clientMessageId must be at most ${COMMAND_CORRELATION_ID_MAX_BYTES} bytes`);
  });

  it('keeps goal control on its request-only command identity', () => {
    expect(parseGoalControlCommandRequest({
      clientRequestId: 'request-goal',
      chatId: CHAT_ID,
      content: '/goal pause',
    })).toEqual({
      clientRequestId: 'request-goal',
      chatId: CHAT_ID,
      content: '/goal pause',
    });
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

    expect(() => parseForkChatCommandRequest({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: CHAT_ID,
      generationId: 'generation-1',
    })).toThrow('generationId requires upToSeq');

    expect(() => parseForkRunCommandRequest({
      clientRequestId: 'request-fork',
      clientMessageId: 'message-fork',
      sourceChatId: SOURCE_CHAT_ID,
      chatId: CHAT_ID,
      generationId: 'generation-1',
      command: 'continue',
    })).toThrow('generationId requires upToSeq');
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

  it('parses queue entry moves with explicit concurrency preconditions', () => {
    expect(parseQueueEntryMoveCommandRequest({
      clientRequestId: ' request-move ',
      chatId: CHAT_ID,
      entryId: ' entry-3 ',
      targetEntryId: ' entry-1 ',
      placement: 'before',
      expectedReorderRevision: 2,
      expectedSourceRevision: 3,
      expectedTargetRevision: 4,
    })).toEqual({
      clientRequestId: 'request-move',
      chatId: CHAT_ID,
      entryId: 'entry-3',
      targetEntryId: 'entry-1',
      placement: 'before',
      expectedReorderRevision: 2,
      expectedSourceRevision: 3,
      expectedTargetRevision: 4,
    });
  });

  it('rejects malformed queue entry moves', () => {
    const valid = {
      clientRequestId: 'request-move',
      chatId: CHAT_ID,
      entryId: 'entry-3',
      targetEntryId: 'entry-1',
      placement: 'after',
      expectedReorderRevision: 0,
      expectedSourceRevision: 1,
      expectedTargetRevision: 1,
    };

    expect(() => parseQueueEntryMoveCommandRequest({
      ...valid,
      targetEntryId: valid.entryId,
    })).toThrow('entryId and targetEntryId must differ');
    expect(() => parseQueueEntryMoveCommandRequest({
      ...valid,
      placement: 'middle',
    })).toThrow('placement must be before or after');
    expect(() => parseQueueEntryMoveCommandRequest({
      ...valid,
      expectedReorderRevision: -1,
    })).toThrow('expectedReorderRevision must be a non-negative integer');
    expect(() => parseQueueEntryMoveCommandRequest({
      ...valid,
      expectedSourceRevision: 0,
    })).toThrow('expected source and target revisions must be positive integers');
    expect(() => parseQueueEntryMoveCommandRequest({
      ...valid,
      expectedTargetRevision: 1.5,
    })).toThrow('expected source and target revisions must be positive integers');
  });

  it('uses one stable validation error type', () => {
    expect(() => parseStartChatCommandRequest(null)).toThrow(CommandRequestValidationError);
  });
});
