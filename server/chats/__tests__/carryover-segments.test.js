import { describe, expect, it } from 'bun:test';
import {
  archivedLogicalCount,
  carryOverLayout,
  carryOverRevision,
  emptyEraId,
  reconcileArchivedTail,
} from '../carryover-segments.js';

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

  it('adds an exact trailing handoff without rewriting the selected segment', () => {
    const original = ref();
    const reconciled = reconcileArchivedTail(
      [original],
      { agentId: 'codex', model: 'gpt' },
      () => { throw new Error('no empty era expected'); },
      capturedAt,
    );

    expect(reconciled).toEqual([
      { ...original, trailingHandoff: { agentId: 'codex', model: 'gpt' } },
    ]);
  });

  it('records every skipped owner with one deterministic metadata-only era', () => {
    const original = ref({ trailingHandoff: { agentId: 'codex', model: 'gpt' } });
    const id = emptyEraId('chat-1', 'handoff-2');
    const reconciled = reconcileArchivedTail(
      [original],
      { agentId: 'pi', model: 'kimi' },
      () => id,
      capturedAt,
    );

    expect(reconciled).toEqual([
      original,
      {
        id,
        agentId: 'codex',
        model: 'gpt',
        capturedAt,
        storedMessageCount: 0,
        visibleMessageCount: 0,
        trailingHandoff: { agentId: 'pi', model: 'kimi' },
      },
    ]);
    expect(emptyEraId('chat-1', 'handoff-2')).toBe(id);
    expect(emptyEraId('chat-1', 'handoff-3')).not.toBe(id);
  });

  it('does not create a boundary for a same-agent model change', () => {
    const original = ref();
    const refs = [original];
    expect(reconcileArchivedTail(
      refs,
      { agentId: 'claude', model: 'sonnet' },
      () => { throw new Error('no empty era expected'); },
      capturedAt,
    )).toBe(refs);
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
