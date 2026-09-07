export class LedgerError extends Error {
  override readonly name: string = 'LedgerError';
}

export class LedgerFencedError extends LedgerError {
  override readonly name = 'LedgerFencedError';

  constructor(readonly chatId: string, options?: ErrorOptions) {
    super(`Transcript ledger is fenced for chat ${chatId}`, options);
  }
}

export interface SafeFenceDiagnostic {
  readonly causeName: string;
  readonly causeCode: string;
}

const SAFE_CAUSE_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const SAFE_CAUSE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const UNKNOWN_CAUSE_FIELD = 'UNKNOWN';

// Reports only bounded, pattern-checked identifiers from a fence cause. Cause messages, stacks, and
// codes can carry a database path or chat identity, so a value failing its pattern is replaced
// outright rather than truncated, and no other cause field is ever read.
export function safeFenceDiagnostic(error: unknown): SafeFenceDiagnostic {
  const cause: unknown = error instanceof LedgerFencedError ? error.cause : null;
  const name = cause instanceof Error ? cause.name : null;
  const code = typeof cause === 'object' && cause !== null
    ? (cause as { readonly code?: unknown }).code
    : null;
  return {
    causeName: typeof name === 'string' && SAFE_CAUSE_NAME.test(name) ? name : UNKNOWN_CAUSE_FIELD,
    causeCode: typeof code === 'string' && SAFE_CAUSE_CODE.test(code) ? code : UNKNOWN_CAUSE_FIELD,
  };
}

export class TranscriptViewNotInitializedError extends LedgerError {
  override readonly name = 'TranscriptViewNotInitializedError';

  constructor(readonly chatId: string) {
    super(`Transcript ledger has no current view for chat ${chatId}`);
  }
}

export class StaleTranscriptViewError extends LedgerError {
  override readonly name = 'StaleTranscriptViewError';

  constructor(
    readonly chatId: string,
    readonly requestedViewId: string,
    readonly currentViewId: string,
  ) {
    super(`Transcript view ${requestedViewId} was replaced by ${currentViewId}`);
  }
}

export class InvalidTranscriptReplayRequestError extends LedgerError {
  override readonly name = 'InvalidTranscriptReplayRequestError';
}

export class SubmissionConflictError extends LedgerError {
  override readonly name = 'SubmissionConflictError';

  constructor(readonly clientMessageId: string) {
    super(`Client message ${clientMessageId} was already submitted with different content`);
  }
}

export class LedgerSchemaError extends LedgerError {
  override readonly name = 'LedgerSchemaError';
}

export class IncompleteLedgerCheckpointError extends LedgerError {
  override readonly name = 'IncompleteLedgerCheckpointError';

  constructor(readonly busyFrames: number, readonly logFrames: number, readonly checkpointedFrames: number) {
    super('Transcript ledger checkpoint did not complete');
  }
}

export class PermissionNotActionableError extends LedgerError {
  override readonly name = 'PermissionNotActionableError';

  constructor() {
    super('This permission request is no longer actionable');
  }
}
