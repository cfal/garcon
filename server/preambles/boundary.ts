import crypto from 'node:crypto';
import type {
  PendingPreambleBoundary,
  PreambleBoundaryKind,
} from '../../common/preambles.js';

export interface PreambleBoundaryBinding {
  readonly agentOwnershipEpoch: string;
  readonly pendingPreambleBoundary: PendingPreambleBoundary;
}

export function createPreambleBoundaryBinding(
  kind: Exclude<PreambleBoundaryKind, 'selection-change'>,
  ownershipEpoch: string = crypto.randomUUID(),
): PreambleBoundaryBinding {
  return {
    agentOwnershipEpoch: ownershipEpoch,
    pendingPreambleBoundary: { kind, ownershipEpoch },
  };
}
