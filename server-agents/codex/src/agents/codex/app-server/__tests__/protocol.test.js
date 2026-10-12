import { describe, expect, it } from 'bun:test';
import { parseThreadItemsListResponse, parseThreadTurnsListResponse } from '../protocol.ts';

function turnWithError(status, codexErrorInfo) {
  return {
    id: `turn-${codexErrorInfo}`,
    items: [],
    itemsView: 'notLoaded',
    status,
    error: {
      message: codexErrorInfo,
      codexErrorInfo,
      additionalDetails: null,
    },
    startedAt: 1_790_000_000,
    completedAt: 1_790_000_001,
    durationMs: 1_000,
  };
}

describe('Codex app-server protocol', () => {
  it('preserves turn lineage and opaque misalignment review targets', () => {
    const turn = {
      ...turnWithError('interrupted', 'misalignmentPolicyViolation'),
      rootTurnId: 'root-turn',
      error: {
        message: 'Synthetic refusal',
        codexErrorInfo: 'misalignmentPolicyViolation',
        additionalDetails: null,
        misalignment: { reviewTarget: 'opaque-review-target' },
      },
    };
    expect(parseThreadTurnsListResponse({
      data: [turn], nextCursor: null, backwardsCursor: null,
    }).data).toEqual([turn]);
  });

  it.each([
    ['root turn', (turn) => { turn.rootTurnId = 1; }, 'rootTurnId'],
    ['review target', (turn) => {
      turn.error.misalignment = { reviewTarget: [] };
    }, 'reviewTarget'],
  ])('rejects malformed %s metadata', (_label, mutate, field) => {
    const turn = turnWithError('failed', 'other');
    mutate(turn);
    expect(() => parseThreadTurnsListResponse({
      data: [turn], nextCursor: null, backwardsCursor: null,
    })).toThrow(field);
  });

  it.each(['commentary', 'partial_answer', 'final_answer', null, undefined])(
    'decodes assistant phase %j', (phase) => {
      const item = { type: 'agentMessage', id: 'assistant', text: 'Synthetic answer', phase, memoryCitation: null };
      expect(parseThreadItemsListResponse({
        data: [{ turnId: 'turn', item }], nextCursor: null, backwardsCursor: null,
      }).data[0].item).toEqual(item);
    },
  );

  it.each(['low', 'custom-effort'])('preserves resolved subagent effort %j', (reasoningEffort) => {
    const item = {
      type: 'subAgentActivity', id: 'activity', kind: 'started',
      agentThreadId: 'child', agentPath: '/root/worker',
      model: 'synthetic-model', reasoningEffort,
    };
    expect(parseThreadItemsListResponse({
      data: [{ turnId: 'turn', item }], nextCursor: null, backwardsCursor: null,
    }).data[0].item).toEqual(item);
  });

  it.each([
    { type: 'agentMessage', id: 'assistant', text: 'Synthetic answer', phase: 'future_phase' },
    { type: 'agentMessage', id: 'assistant', text: 'Synthetic answer', phase: ['final_answer'] },
    { type: 'subAgentActivity', id: 'activity', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker', model: [] },
    { type: 'subAgentActivity', id: 'activity', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker', reasoningEffort: 3 },
    { type: 'subAgentActivity', id: 'activity', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker', reasoningEffort: '' },
  ])('rejects malformed item metadata: %j', (item) => {
    expect(() => parseThreadItemsListResponse({
      data: [{ turnId: 'turn', item }], nextCursor: null, backwardsCursor: null,
    })).toThrow('Invalid');
  });

  it.each([
    ['failed', 'flexUnavailable'],
    ['interrupted', 'tooManyDenials'],
  ])('decodes %s turns with %s errors', (status, codexErrorInfo) => {
    const response = parseThreadTurnsListResponse({
      data: [turnWithError(status, codexErrorInfo)],
      nextCursor: null,
      backwardsCursor: null,
    });

    expect(response.data[0]).toMatchObject({
      status,
      error: { codexErrorInfo },
    });
  });

  it('continues to reject unknown error variants', () => {
    expect(() => parseThreadTurnsListResponse({
      data: [turnWithError('failed', 'futureError')],
      nextCursor: null,
      backwardsCursor: null,
    })).toThrow('Invalid Codex turn turn-futureError error codexErrorInfo');
  });
});
