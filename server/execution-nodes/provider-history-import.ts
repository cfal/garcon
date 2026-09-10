import type { AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import type { ProviderNativeChatReference } from './provider-native-sessions.js';

export const PROVIDER_HISTORY_IMPORT_MAX_BATCH_ROWS = 256;

export interface ProviderHistoryImportRequest {
  readonly chat: ProviderNativeChatReference;
}

/** Delivers ordered, non-empty snapshots of at most 256 rows; normal EOF proves the source completed. */
export interface ProviderHistoryImportService {
  read(request: ProviderHistoryImportRequest, signal: AbortSignal): AsyncIterable<readonly AgentImportedTranscriptRow[]>;
}
