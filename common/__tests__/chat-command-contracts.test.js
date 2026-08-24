import { describe, expect, it } from 'bun:test';
import {
  COMMAND_CORRELATION_ID_MAX_BYTES,
  QUEUE_ENTRY_ID_MAX_BYTES,
  CommandRequestValidationError,
  parseAgentRunCommandRequest,
  parseForkChatCommandRequest,
  parseForkRunCommandRequest,
  parseGoalControlCommandRequest,
  parsePermissionDecisionCommandRequest,
  parseQueueEntryMoveCommandRequest,
  parseQueueEntrySteerCommandRequest,
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
const TRANSCRIPT_VIEW_ID = 'view-1';

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
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      command: 'continue',
      agentSettings: agentSettings(),
      model: 'opus',
      expectedAgentId: 'claude',
      tagsToAdd: ['CLI', 'cli', ' Review '],
      permissionFallbackPolicy: 'require-explicit-bypass',
    });

    expect(parsed.permissionMode).toBeUndefined();
    expect(parsed.thinkingMode).toBeUndefined();
    expect(parsed.agentSettings).toEqual(agentSettings());
    expect(parsed.expectedAgentId).toBe('claude');
    expect(parsed.tagsToAdd).toEqual(['cli', 'review']);
    expect(parsed.permissionFallbackPolicy).toBe('require-explicit-bypass');
  });

  it('normalizes one-shot resend exclusions at the request boundary', () => {
    const parsed = parseAgentRunCommandRequest({
      clientRequestId: 'request-resend',
      clientMessageId: 'message-resend',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      command: 'continue',
      excludedResendOrdinals: [3, 1, 3],
    });

    expect(parsed.excludedResendOrdinals).toEqual([1, 3]);
    expect(() => parseAgentRunCommandRequest({
      ...parsed,
      excludedResendOrdinals: [0],
    })).toThrow('excludedResendOrdinals must contain positive integers');
  });

  it('parses one fenced handoff without flattening target execution settings', () => {
    const parsed = parseAgentRunCommandRequest({
      clientRequestId: 'request-handoff',
      clientMessageId: 'message-handoff',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      command: 'continue elsewhere',
      permissionFallbackPolicy: 'require-explicit-bypass',
      handoff: {
        expectedAgentOwnershipEpoch: 'epoch-1',
        target: {
          agentId: 'codex',
          model: 'gpt-5.6-sol',
          apiProviderId: 'openai',
          modelEndpointId: 'responses',
          modelProtocol: 'openai-compatible',
          permissionMode: 'bypassPermissions',
          thinkingMode: 'max',
          agentSettings: agentSettings('codex'),
        },
      },
    });

    expect(parsed).toMatchObject({
      handoff: {
        expectedAgentOwnershipEpoch: 'epoch-1',
        target: {
          agentId: 'codex',
          model: 'gpt-5.6-sol',
          apiProviderId: 'openai',
          modelEndpointId: 'responses',
          modelProtocol: 'openai-compatible',
          permissionMode: 'bypassPermissions',
          thinkingMode: 'max',
          agentSettings: agentSettings('codex'),
        },
      },
    });
    expect(parsed.model).toBeUndefined();
    expect(parsed.permissionMode).toBeUndefined();
  });

  it('rejects incomplete or contradictory handoff requests', () => {
    const base = {
      clientRequestId: 'request-handoff-invalid',
      clientMessageId: 'message-handoff-invalid',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      command: 'continue elsewhere',
      handoff: {
        expectedAgentOwnershipEpoch: 'epoch-1',
        target: {
          agentId: 'codex',
          model: 'gpt-5.6-sol',
          agentSettings: agentSettings('codex'),
        },
      },
    };

    expect(() => parseAgentRunCommandRequest({
      ...base,
      handoff: { target: base.handoff.target },
    })).toThrow('expectedAgentOwnershipEpoch is required');
    expect(() => parseAgentRunCommandRequest({
      ...base,
      handoff: {
        ...base.handoff,
        target: { ...base.handoff.target, agentSettings: agentSettings('claude') },
      },
    })).toThrow('handoff.target.agentSettings must be owned by handoff.target.agentId');
    expect(() => parseAgentRunCommandRequest({
      ...base,
      model: 'flat-model',
    })).toThrow('handoff cannot be combined with same-agent execution overrides');
  });

  it('rejects partial routing and non-canonical explicit modes', () => {
    const base = {
      clientRequestId: 'request-routing',
      clientMessageId: 'message-routing',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      command: 'continue',
    };
    expect(() => parseAgentRunCommandRequest({ ...base, apiProviderId: 'provider' }))
      .toThrow('model is required with routing overrides');
    expect(() => parseAgentRunCommandRequest({ ...base, model: 'opus', permissionMode: 'unsafe' }))
      .toThrow('permissionMode is invalid');
    expect(() => parseAgentRunCommandRequest({ ...base, model: 'opus', thinkingMode: 'think-hard' }))
      .toThrow('thinkingMode is invalid');
    expect(() => parseAgentRunCommandRequest({ ...base, permissionFallbackPolicy: 'inherit' }))
      .toThrow('permissionFallbackPolicy is invalid');
  });

  it('requires distinct request and message identities for steering', () => {
    expect(parseSteerCommandRequest({
      clientRequestId: ' request-steer ',
      clientMessageId: ' message-steer ',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      content: ' focus here ',
    })).toEqual({
      clientRequestId: 'request-steer',
      clientMessageId: 'message-steer',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      content: ' focus here ',
    });
    expect(() => parseSteerCommandRequest({
      clientRequestId: 'request-steer',
      chatId: CHAT_ID,
      content: 'focus here',
    })).toThrow(CommandRequestValidationError);
  });

  it('validates presentation on run and steer requests', () => {
    const run = parseAgentRunCommandRequest({
      clientRequestId: 'request-presentation',
      clientMessageId: 'message-presentation',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      command: 'continue',
      userMessagePresentation: { origin: 'cli', style: 'notice', title: '  Context  ' },
    });
    expect(run.userMessagePresentation).toEqual({
      origin: 'cli', style: 'notice', title: 'Context',
    });
    expect(parseSteerCommandRequest({
      clientRequestId: 'request-steer-presentation',
      clientMessageId: 'message-steer-presentation',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      content: 'stop here',
      userMessagePresentation: { origin: 'cli', style: 'info' },
    }).userMessagePresentation).toEqual({ origin: 'cli', style: 'info' });
    expect(() => parseAgentRunCommandRequest({
      ...run,
      userMessagePresentation: { origin: 'cli', style: 'notice', extra: true },
    })).toThrow('unsupported field');
  });

  it('parses queue steering with explicit entry concurrency preconditions', () => {
    expect(parseQueueEntrySteerCommandRequest({
      clientRequestId: ' request-steer-queue ',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      entryId: ' entry-1 ',
      expectedRevision: 2,
      expectedReorderRevision: 4,
    })).toEqual({
      clientRequestId: 'request-steer-queue',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      entryId: 'entry-1',
      expectedRevision: 2,
      expectedReorderRevision: 4,
    });
    expect(() => parseQueueEntrySteerCommandRequest({
      clientRequestId: 'request-steer-queue',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      entryId: 'entry-1',
      expectedRevision: 0,
      expectedReorderRevision: 0,
    })).toThrow('expectedRevision must be a positive integer');
    expect(() => parseQueueEntrySteerCommandRequest({
      clientRequestId: 'request-steer-queue',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      entryId: 'entry-1',
      expectedRevision: 1,
      expectedReorderRevision: -1,
    })).toThrow('expectedReorderRevision must be a non-negative integer');
  });

  it('bounds command correlation identities by UTF-8 byte length', () => {
    const base = {
      clientRequestId: 'request-steer',
      clientMessageId: 'message-steer',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
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

  it('bounds queue entry identities by UTF-8 byte length', () => {
    const base = {
      clientRequestId: 'request-steer-queue',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      expectedRevision: 1,
      expectedReorderRevision: 0,
    };

    expect(parseQueueEntrySteerCommandRequest({
      ...base,
      entryId: 'x'.repeat(QUEUE_ENTRY_ID_MAX_BYTES),
    }).entryId).toHaveLength(QUEUE_ENTRY_ID_MAX_BYTES);
    expect(() => parseQueueEntrySteerCommandRequest({
      ...base,
      entryId: 'x'.repeat(QUEUE_ENTRY_ID_MAX_BYTES + 1),
    })).toThrow(`entryId must be at most ${QUEUE_ENTRY_ID_MAX_BYTES} bytes`);
    expect(() => parseQueueEntrySteerCommandRequest({
      ...base,
      entryId: '\u00e9'.repeat((QUEUE_ENTRY_ID_MAX_BYTES / 2) + 1),
    })).toThrow(`entryId must be at most ${QUEUE_ENTRY_ID_MAX_BYTES} bytes`);
  });

  it('qualifies goal control with logical message and transcript identities', () => {
    expect(parseGoalControlCommandRequest({
      clientRequestId: 'request-goal',
      clientMessageId: 'message-goal',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
      content: '/goal pause',
    })).toEqual({
      clientRequestId: 'request-goal',
      clientMessageId: 'message-goal',
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
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
      upToOrdinal: '2abc',
    })).toThrow('upToOrdinal must be a positive integer');

    expect(() => parseForkChatCommandRequest({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: CHAT_ID,
      transcriptViewId: TRANSCRIPT_VIEW_ID,
    })).toThrow('transcriptViewId requires upToOrdinal');

    expect(() => parseForkChatCommandRequest({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: CHAT_ID,
      upToOrdinal: 2,
    })).toThrow('upToOrdinal requires transcriptViewId');
  });

  it('carries handoff-fork consent on both fork request shapes', () => {
    const forkRun = {
      clientRequestId: 'request-fork-run',
      clientMessageId: 'message-fork-run',
      sourceChatId: SOURCE_CHAT_ID,
      chatId: CHAT_ID,
      command: 'continue in fork',
    };

    expect(parseForkRunCommandRequest({ ...forkRun, allowHandoffFork: true }))
      .toMatchObject({ allowHandoffFork: true });
    expect(parseForkChatCommandRequest({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: CHAT_ID,
      allowHandoffFork: true,
    })).toMatchObject({ allowHandoffFork: true });
    expect(parseForkRunCommandRequest({ ...forkRun, allowHandoffFork: false }))
      .not.toHaveProperty('allowHandoffFork');
    expect(() => parseForkRunCommandRequest({ ...forkRun, allowHandoffFork: 'yes' }))
      .toThrow('allowHandoffFork must be a boolean');
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
      permissionOccurrenceId: 'occurrence-1',
      allow: 'yes',
      alwaysAllow: false,
    })).toThrow('allow must be a boolean');
  });

  it('binds permission decisions to the exact transient occurrence', () => {
    const control = {
      serverInstanceId: 'server-1',
      chatId: CHAT_ID,
      runId: 'run-1',
      permissionOccurrenceId: 'occurrence-1',
    };
    const request = {
      clientRequestId: 'decision-1',
      chatId: CHAT_ID,
      permissionOccurrenceId: 'occurrence-1',
      allow: true,
      alwaysAllow: false,
      control,
    };

    expect(parsePermissionDecisionCommandRequest(request).control).toEqual(control);
    expect(() => parsePermissionDecisionCommandRequest({
      ...request,
      permissionOccurrenceId: 'occurrence-2',
    })).toThrow('control does not match');
    expect(() => parsePermissionDecisionCommandRequest({
      ...request,
      control: { ...control, runId: '' },
    })).toThrow('control is invalid');
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
