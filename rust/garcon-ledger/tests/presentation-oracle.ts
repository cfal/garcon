import { stableJsonStringify } from '../../../common/json.ts';
import type { TranscriptExportCategory } from '../../../common/chat-export-contracts.ts';
import { decodeLedgerRow, encodeLedgerDraft, type StoredLedgerRow } from '../../../server/controller/ledger/codec.ts';
import { filterTranscriptExportEntries, foldRowsForExport } from '../../../server/controller/ledger/export-fold.ts';
import { ledgerRowToMessage, ledgerRowsToMessages, ledgerRowsToTranscriptMessages } from '../../../server/controller/ledger/presentation.ts';
import { frozenConversationDrafts, previewMessages } from '../../../server/controller/ledger/projection.ts';

type StoredInput = {
  kind: StoredLedgerRow['kind'];
  ordinal?: number;
  clientMessageId?: string;
  value: unknown;
};

const at = '2026-11-28T09:00:00.000Z';

function row(input: StoredInput) {
  return decodeLedgerRow({
    view_id: 'presentation-fixture',
    ordinal: input.ordinal ?? 1,
    kind: input.kind,
    at,
    client_message_id: input.clientMessageId ?? null,
    payload_json: stableJsonStringify({ providerMeta: null, value: input.value }),
  });
}

export function ledgerRowToMessageFixture(input: StoredInput) {
  return JSON.parse(JSON.stringify(ledgerRowToMessage(row(input))));
}

export function ledgerRowToMessageBytesFixture(input: StoredInput) {
  return JSON.stringify(ledgerRowToMessage(row(input)));
}

export function ledgerRowsToMessagesFixture(inputs: StoredInput[]) {
  return JSON.parse(JSON.stringify(ledgerRowsToMessages(inputs.map(row))));
}

export function ledgerRowsToTranscriptMessagesFixture(inputs: StoredInput[]) {
  return JSON.parse(JSON.stringify(ledgerRowsToTranscriptMessages(inputs.map(row))));
}

export function previewMessagesFixture(head: StoredInput[], omitted: number | null, tail: StoredInput[]) {
  return JSON.parse(JSON.stringify(previewMessages({ head: head.map(row), firstOmittedHeadOrdinal: omitted, tail: tail.map(row) })));
}

export function frozenDraftsFixture(inputs: StoredInput[]) {
  return frozenConversationDrafts(inputs.map(row)).map(draft => ({
    kind: draft.kind, at: draft.at, ...encodeLedgerDraft(draft),
  }));
}

export function exportFoldFixture(inputs: StoredInput[], exclusions: TranscriptExportCategory[]) {
  return JSON.parse(JSON.stringify(filterTranscriptExportEntries(foldRowsForExport(inputs.map(row)), exclusions)));
}
