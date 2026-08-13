export class LedgerError extends Error {
  override readonly name: string = 'LedgerError';
}

export class LedgerFencedError extends LedgerError {
  override readonly name = 'LedgerFencedError';

  constructor(readonly chatId: string, options?: ErrorOptions) {
    super(`Transcript ledger is fenced for chat ${chatId}`, options);
  }
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
