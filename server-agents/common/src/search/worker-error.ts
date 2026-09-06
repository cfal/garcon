import type { IndexerEvent, ReaderEvent } from './worker-protocol.js';

export class TranscriptSearchWorkerError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = 'TranscriptSearchWorkerError';
  }
}

export function workerEventError(event: IndexerEvent | ReaderEvent): Error | null {
  return event.type === 'error'
    ? new TranscriptSearchWorkerError(event.code, event.retryable)
    : null;
}
