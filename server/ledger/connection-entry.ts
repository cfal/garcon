import type { Database } from 'bun:sqlite';
import type { TranscriptView } from './contracts.js';

export interface ViewRecord {
  readonly view_id: string;
  readonly status: 'current' | 'staging';
  readonly created_at: string;
  readonly content_start_ordinal: number;
}


export type ConnectionCloseAttempt =
  | { readonly closed: true; readonly checkpointFailure: Error | null }
  | { readonly closed: false; readonly failure: Error };


export interface ConnectionEntry {
  readonly chatId: string;
  readonly directory: string;
  readonly db: Database;
  current: TranscriptView | null;
  nextOrdinal: number;
}
