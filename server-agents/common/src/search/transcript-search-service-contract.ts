import type { AgentLogger } from '@garcon/server-agent-interface';
import type { HistoricalSearchMessageRow } from './rows.js';
import type {
  IndexerEvent,
  IndexerRecordableBuildErrorCode,
  PhysicalStepResult,
  ReaderEvent,
  SearchChatState,
  WalObservation,
} from './worker-protocol.js';
import {
  isIndexerRecordableBuildErrorCode,
  isIndexerWalAuthoritativeErrorCode,
} from './worker-protocol.js';

export interface TranscriptSearchServiceOptions {
  readonly workspaceDirectory: string;
  readonly logger: AgentLogger;
  readonly workerFactory?: (role: 'indexer' | 'reader', moduleUrl: string) => Worker;
  readonly indexWriteTimeoutMs?: number;
}

export interface TranscriptSearchIndexInput {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly expectedAfterOrdinal: number;
  readonly throughOrdinal: number;
  readonly rows: readonly HistoricalSearchMessageRow[];
}

export class TranscriptSearchWorkerError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly grantId: number | null = null,
    readonly wal?: WalObservation,
  ) {
    super(code);
    this.name = 'TranscriptSearchWorkerError';
  }
}

export function workerEventError(event: IndexerEvent | ReaderEvent): Error | null {
  return event.type === 'error'
    ? new TranscriptSearchWorkerError(
        event.code,
        event.retryable,
        event.grantId,
        'wal' in event ? event.wal : undefined,
      )
    : null;
}

export function isKnownIndexerGrantError(
  error: unknown,
  grantId: number,
): error is TranscriptSearchWorkerError {
  return error instanceof TranscriptSearchWorkerError
    && error.grantId === grantId
    && isIndexerWalAuthoritativeErrorCode(error.code);
}

export function grantMatches(event: IndexerEvent, grantId: number): boolean {
  if (event.type === 'error') return event.grantId === grantId;
  return (event.type === 'step-started' || event.type === 'physical-step-complete')
    && event.grantId === grantId;
}

export function isReplacementCheckpointResult(
  result: PhysicalStepResult,
): result is Extract<PhysicalStepResult,
  { kind: 'replacement-checkpoint' }
  | { kind: 'sync-plan'; disposition: 'checkpoint' }> {
  return result.kind === 'replacement-checkpoint'
    || (result.kind === 'sync-plan' && result.disposition === 'checkpoint');
}

export function resultState(result: PhysicalStepResult): SearchChatState {
  if ('state' in result) return result.state;
  throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
}

export function requireIndexInput(input: TranscriptSearchIndexInput): void {
  if (!Number.isSafeInteger(input.expectedAfterOrdinal) || input.expectedAfterOrdinal < 0
      || !Number.isSafeInteger(input.throughOrdinal)
      || input.throughOrdinal < input.expectedAfterOrdinal) {
    throw new Error('SEARCH_INDEX_INPUT_INVALID');
  }
  let priorOrdinal = input.expectedAfterOrdinal;
  for (const row of input.rows) {
    if (!Number.isSafeInteger(row.ordinal)
        || row.ordinal <= priorOrdinal
        || row.ordinal > input.throughOrdinal) {
      throw new Error('SEARCH_INDEX_INPUT_INVALID');
    }
    priorOrdinal = row.ordinal;
  }
}

export function recordableBuildFailureCode(
  error: unknown,
): IndexerRecordableBuildErrorCode | null {
  return error instanceof TranscriptSearchWorkerError
    && !error.retryable
    && isIndexerRecordableBuildErrorCode(error.code)
    ? error.code
    : null;
}
