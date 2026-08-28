import { describe, expect, it } from 'bun:test';
import { resolveCarryOverOutcome } from '../carryover-outcome.ts';

describe('carryover outcome', () => {
  it('resolves no history without context or a notice', () => {
    expect(resolveCarryOverOutcome({ kind: 'no-history' })).toEqual({
      context: null,
      notice: null,
    });
  });

  it('resolves complete history with a compact presentation-only notice', () => {
    const context = { prefix: '<carried-context>Complete history</carried-context>\n\n' };

    expect(resolveCarryOverOutcome({ kind: 'complete', context })).toEqual({
      context,
      notice: {
        title: 'History carried without compaction',
        content: 'Earlier chat history was small enough to carry over as context.',
      },
    });
  });

  it('resolves compacted history with its typed handoff summary', () => {
    const context = { prefix: '<carried-context>Summary</carried-context>\n\n' };

    expect(resolveCarryOverOutcome({
      kind: 'compacted',
      context,
      summary: 'Objective and current state.',
    })).toEqual({
      context,
      notice: {
        title: 'Handoff summary',
        content: 'Objective and current state.',
        detail: { type: 'handoff-summary' },
      },
    });
  });

});
