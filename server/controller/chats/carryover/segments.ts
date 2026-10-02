import crypto from 'node:crypto';
import type { CarryOverSegmentIndex } from './segment-types.js';
import type { CarryOverMigrationQuarantine, CarryOverSegmentRef } from '../registry-contracts.js';

export interface CarryOverSegmentLayoutItem {
  readonly ref: CarryOverSegmentRef;
  readonly startSequence: number;
  readonly payloadEndSequence: number;
  readonly boundarySequence: number | null;
}

export function carryOverRevision(
  refs: readonly CarryOverSegmentRef[],
  quarantine: CarryOverMigrationQuarantine | null = null,
): string {
  if (refs.length === 0 && quarantine === null) return 'carry-v1:0';
  return `carry-v5:${crypto.createHash('sha256')
    .update(stableStringify({ refs, quarantine }))
    .digest('hex')}`;
}

export function archivedLogicalCount(refs: readonly CarryOverSegmentRef[]): number {
  return refs.reduce(
    (total, ref) => total + ref.visibleMessageCount + (ref.trailingHandoff ? 1 : 0),
    0,
  );
}

export function carryOverLayout(
  refs: readonly CarryOverSegmentRef[],
): readonly CarryOverSegmentLayoutItem[] {
  let sequence = 1;
  return refs.map((ref) => {
    const startSequence = sequence;
    const payloadEndSequence = sequence + ref.visibleMessageCount - 1;
    const boundarySequence = ref.trailingHandoff
      ? payloadEndSequence + 1
      : null;
    sequence = (boundarySequence ?? payloadEndSequence) + 1;
    return { ref, startSequence, payloadEndSequence, boundarySequence };
  });
}

export function assertSegmentBinding(
  ref: CarryOverSegmentRef,
  index: CarryOverSegmentIndex,
): void {
  if (ref.id !== index.id) throw new Error('Carryover segment ID mismatch');
  if (ref.storedMessageCount !== index.messageCount) {
    throw new Error('Carryover segment count mismatch');
  }
  if (ref.visibleMessageCount > index.messageCount) {
    throw new Error('Carryover segment cutoff is outside its artifact');
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  ).join(',')}}`;
}
