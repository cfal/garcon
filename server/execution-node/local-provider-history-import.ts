import {
  isNormalizedJsonObject,
  snapshotNormalizedMessage,
  type AgentHistoryImport,
  type AgentImportedTranscriptRow,
  type AgentIntegration,
} from '@garcon/server-agent-interface';
import {
  PROVIDER_HISTORY_IMPORT_MAX_BATCH_ROWS,
  type ProviderHistoryImportRequest,
  type ProviderHistoryImportService,
} from '../execution-nodes/provider-history-import.js';
import type { ProviderNativeChatReference } from '../execution-nodes/provider-native-sessions.js';
import { assertNativeChatOwner, parseNativeChatReference } from './local-native-chat-reference.js';

export class LocalProviderHistoryImportService implements ProviderHistoryImportService {
  constructor(
    private readonly integration: Pick<AgentIntegration, 'descriptor' | 'settings'>,
    private readonly source: AgentHistoryImport,
  ) {}

  read(request: ProviderHistoryImportRequest, signal: AbortSignal): AsyncIterable<readonly AgentImportedTranscriptRow[]> {
    signal.throwIfAborted();
    const chat = structuredClone(request.chat);
    assertNativeChatOwner(this.integration, chat);
    const settings = structuredClone(chat.settings ?? this.integration.settings.defaults());
    return this.#read({ ...chat, settings }, signal);
  }

  async *#read(input: ProviderNativeChatReference, signal: AbortSignal): AsyncIterable<readonly AgentImportedTranscriptRow[]> {
    signal.throwIfAborted();
    assertNativeChatOwner(this.integration, input);
    const chat = parseNativeChatReference(this.integration, input);
    signal.throwIfAborted();
    try {
      const iterator = this.source.load({ chat, signal })[Symbol.asyncIterator]();
      let completed = false;
      let failure: { error: unknown } | null = null;
      try {
        while (!completed) {
          signal.throwIfAborted();
          const result = await iterator.next();
          completed = result.done === true;
          signal.throwIfAborted();
          if (completed) break;
          const batch = result.value;
          if (!Array.isArray(batch)) throw new TypeError('Invalid history import batch');
          const snapshot = Array.from(batch, snapshotRow);
          for (let start = 0; start < snapshot.length; start += PROVIDER_HISTORY_IMPORT_MAX_BATCH_ROWS) {
            const rows = snapshot.slice(start, start + PROVIDER_HISTORY_IMPORT_MAX_BATCH_ROWS);
            signal.throwIfAborted();
            yield rows;
            signal.throwIfAborted();
          }
        }
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        // A rejected next() does not close an iterator through for-await's implicit cleanup.
        if (!completed) {
          try {
            await iterator.return?.();
          } catch (error) {
            if (!failure) throw error;
            throw new AggregateError(
              [failure.error, error],
              failure.error instanceof Error ? failure.error.message : 'History import and cleanup failed',
            );
          }
          signal.throwIfAborted();
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
    signal.throwIfAborted();
  }
}

function snapshotRow(row: AgentImportedTranscriptRow): AgentImportedTranscriptRow {
  const providerMeta = structuredClone(row.providerMeta);
  if (providerMeta !== undefined && !isNormalizedJsonObject(providerMeta)) throw new TypeError('Invalid history provider metadata');
  return {
    message: snapshotNormalizedMessage(row.message),
    ...(providerMeta === undefined ? {} : { providerMeta }),
  };
}
