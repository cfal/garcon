import { describe, expect, it } from 'bun:test';
import { parseThreadTurnsListResponse } from '../protocol.ts';

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
