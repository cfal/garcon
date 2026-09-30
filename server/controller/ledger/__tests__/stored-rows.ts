import type { ChatMessage } from '../../../../common/chat-types.js';
import { encodeLedgerDraft, type StoredLedgerRow } from '../codec.js';
import type { LedgerRow } from '../contracts.js';
import type { StoredTranscriptSnapshot, TranscriptViewReader } from '../view-reader.js';

// Serves the snapshot a capture function returns to work, as the view reader does.
export function storedSnapshotReader(
  capture: (chatId: string) => Promise<StoredTranscriptSnapshot>,
): Pick<TranscriptViewReader, 'withStoredSnapshot'> {
  return {
    async withStoredSnapshot(chatId, work) {
      return work(await capture(chatId));
    },
  };
}

// Encodes rows the way the store persists them, for code that reads stored rows.
export function storedRow(row: LedgerRow): StoredLedgerRow {
  const encoded = encodeLedgerDraft(row);
  return {
    view_id: row.viewId,
    ordinal: row.ordinal,
    kind: row.kind,
    at: row.at,
    client_message_id: encoded.clientMessageId,
    payload_json: encoded.payloadJson,
  };
}

export function storedProviderRows(messages: readonly ChatMessage[], viewId = 'view-1'): StoredLedgerRow[] {
  return messages.map((message, index) => storedRow({
    viewId,
    ordinal: index + 1,
    at: message.timestamp,
    providerMeta: null,
    kind: 'provider-row',
    message,
  } as LedgerRow));
}
