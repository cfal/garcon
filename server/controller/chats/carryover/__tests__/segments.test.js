import { describe, expect, it } from 'bun:test';
import {
  archivedLogicalCount,
  carryOverLayout,
  carryOverRevision,
} from '../segments.js';

const capturedAt = '2026-08-07T00:00:00.000Z';

function ref(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    agentId: 'claude',
    model: 'opus',
    capturedAt,
    storedMessageCount: 2,
    visibleMessageCount: 2,
    trailingHandoff: null,
    ...overrides,
  };
}

describe('carryover segment sequences', () => {
  it('counts explicit boundaries including metadata-only eras', () => {
    const refs = [
      ref({ trailingHandoff: { agentId: 'codex', model: 'gpt' } }),
      ref({
        id: '22222222-2222-4222-8222-222222222222',
        agentId: 'codex',
        model: 'gpt',
        storedMessageCount: 0,
        visibleMessageCount: 0,
        trailingHandoff: { agentId: 'pi', model: 'kimi' },
      }),
    ];

    expect(archivedLogicalCount(refs)).toBe(4);
    expect(carryOverLayout(refs)).toEqual([
      expect.objectContaining({ startSequence: 1, payloadEndSequence: 2, boundarySequence: 3 }),
      expect.objectContaining({ startSequence: 4, payloadEndSequence: 3, boundarySequence: 4 }),
    ]);
  });

  it('changes the revision for refs or quarantine state', () => {
    const refs = [ref()];
    const revision = carryOverRevision(refs);
    expect(revision).toMatch(/^carry-v5:[a-f0-9]{64}$/);
    expect(carryOverRevision([{ ...refs[0], visibleMessageCount: 1 }])).not.toBe(revision);
    expect(carryOverRevision(refs, {
      artifactId: '22222222-2222-4222-8222-222222222222',
      errorCode: 'INVALID_CARRYOVER_ENTRY',
    })).not.toBe(revision);
  });
});
