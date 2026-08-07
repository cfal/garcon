import crypto from 'node:crypto';
import type { AgentName } from '../agents/session-types.js';
import type { CarryOverSegmentIndex } from './carryover-segment-types.js';
import type {
  CarryOverHandoffTarget,
  CarryOverMigrationQuarantine,
  CarryOverSegmentRef,
} from './store.js';

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

export function reconcileArchivedTail(
  refs: readonly CarryOverSegmentRef[],
  owner: CarryOverHandoffTarget,
  emptyId: () => string,
  capturedAt: string,
): readonly CarryOverSegmentRef[] {
  const last = refs.at(-1);
  if (!last) return refs;
  if (last.trailingHandoff === null) {
    if (last.agentId === owner.agentId) return refs;
    return [
      ...refs.slice(0, -1),
      { ...last, trailingHandoff: { ...owner } },
    ];
  }
  if (last.trailingHandoff.agentId === owner.agentId) return refs;
  return [
    ...refs,
    {
      id: emptyId(),
      agentId: last.trailingHandoff.agentId,
      model: last.trailingHandoff.model,
      capturedAt,
      storedMessageCount: 0,
      visibleMessageCount: 0,
      trailingHandoff: { ...owner },
    },
  ];
}

export function handoffSegmentId(chatId: string, clientRequestId: string): string {
  return deterministicUuid('garcon-carryover-segment-v1', chatId, clientRequestId);
}

export function emptyEraId(chatId: string, reconciliationIdentity: string): string {
  return deterministicUuid('garcon-carryover-empty-era-v1', chatId, reconciliationIdentity);
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

export function handoffTarget(agentId: AgentName, model: string): CarryOverHandoffTarget {
  return { agentId, model };
}

function deterministicUuid(namespace: string, ...parts: readonly string[]): string {
  const bytes = crypto.createHash('sha256')
    .update(namespace)
    .update('\0')
    .update(parts.join('\0'))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  ).join(',')}}`;
}
