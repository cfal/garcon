import { createHash } from 'node:crypto';
import type { Preamble } from '../../../common/preambles.js';
import { DomainError } from '../../common/domain-error.js';

export interface AutomationAdmission {
  readonly signal: AbortSignal;
  readonly providerRevision: number | null;
  readonly assertEligible: () => void;
  readonly assertPreambles: (preambles: readonly Preamble[]) => void;
  readonly dispatchFailed: (error: unknown) => void;
  inputPublished: boolean;
}

export function pinAutomationPreambles(preambles: readonly Preamble[]): AutomationAdmission['assertPreambles'] {
  const digest = (preamble: Preamble) => createHash('sha256').update(preamble.content).digest('hex');
  const pinned = preambles.map(preamble => ({ id: preamble.id, hash: digest(preamble) }));
  return actual => {
    if (actual.length !== pinned.length || actual.some((preamble, index) => (
      preamble.id !== pinned[index].id || digest(preamble) !== pinned[index].hash
    ))) throw new DomainError('VALIDATION_FAILED', 'Selected preambles changed before the managed start', 409);
  };
}
