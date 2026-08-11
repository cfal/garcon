import { createHash } from 'node:crypto';
import { stableJsonStringify } from '@garcon/common/json';

// Identity of the composite transcript content: carryover revision, ownership
// epoch, and the current segment's ledger content epoch. Search results and
// share/export origins record it so a value captured before a revert, handoff,
// or carryover repair can be recognized as stale; ordinary tail append keeps
// the epoch stable.
export function compositeContentEpoch(input: {
  readonly carryOverRevision: string;
  readonly agentOwnershipEpoch: string;
  readonly segmentContentEpoch: string;
}): string {
  return `search-content-v1:${createHash('sha256').update(stableJsonStringify({
    version: 1,
    carryOverRevision: input.carryOverRevision,
    agentOwnershipEpoch: input.agentOwnershipEpoch,
    segmentContentEpoch: input.segmentContentEpoch,
  })).digest('hex')}`;
}
