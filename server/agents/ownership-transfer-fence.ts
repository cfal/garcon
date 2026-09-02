import { DomainError } from '../lib/domain-error.js';

// A handoff decision is durable before roll-forward installs the successor's content
// boundary. Work admitted in that window would run under the superseded owner and append
// rows past the recorded watermark, which roll-forward then folds into the successor's
// range. Admission and producer publication both reject until the decision is discharged.
export class OwnershipTransferPendingError extends DomainError {
  override readonly name = 'OwnershipTransferPendingError';

  constructor(cause?: unknown) {
    super(
      'OWNERSHIP_TRANSFER_PENDING',
      'This chat is completing an agent handoff. Try again shortly.',
      409,
      true,
      cause === undefined ? undefined : { cause },
    );
  }
}

export function ownershipTransferPendingError(): OwnershipTransferPendingError {
  return new OwnershipTransferPendingError();
}
