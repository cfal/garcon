import {
  cliRowFingerprint,
  decodeClonedStoredRows as decodeClones,
  decodeLedgerRow as decode,
  decodeStoredLedgerRow as decodeStored,
  encodeLedgerDraft,
  parseLedgerCliRowNoticeDetail,
  submissionFingerprint,
  type StoredLedgerRow,
} from '../../../server/controller/ledger/codec.ts';
import { LedgerFencedError, safeFenceDiagnostic } from '../../../server/controller/ledger/errors.ts';
import {
  isConversationalLedgerRow,
  isLedgerCliRowNoticeRow,
  isLedgerPreambleSelectionChangedNoticeRow,
  isPresentationOnlyProviderRow,
} from '../../../server/controller/ledger/contracts.ts';
import type { JsonObject } from '../../../common/json.ts';

export {
  parseLedgerCliRowNoticeDetail,
  parseLedgerPreambleSelectionChangedNoticeDetail,
} from '../../../server/controller/ledger/codec.ts';
export {
  isLedgerCliRowNoticeDetail,
  isLedgerPreambleSelectionChangedNoticeDetail,
  projectLedgerAgentCommandOutcome,
  projectLedgerTicketCommandOutcome,
  transcriptViewId,
} from '../../../server/controller/ledger/contracts.ts';

export function decodeLedgerRow(row: StoredLedgerRow) {
  return JSON.parse(JSON.stringify(decode(row)));
}

export function decodeStoredLedgerRow(row: StoredLedgerRow) {
  return JSON.parse(JSON.stringify(decodeStored(row)));
}

export function decodeClonedStoredRows(rows: unknown[]) {
  return JSON.parse(JSON.stringify(decodeClones(rows)));
}

export function encodeDecodedLedgerDraft(row: StoredLedgerRow) {
  return encodeLedgerDraft(decode(row));
}

export function classifyDecodedLedgerRow(row: StoredLedgerRow) {
  const decoded = decode(row);
  return {
    conversational: isConversationalLedgerRow(decoded),
    presentationOnly: isPresentationOnlyProviderRow(decoded),
    cliRow: isLedgerCliRowNoticeRow(decoded),
    preambleSelection: isLedgerPreambleSelectionChangedNoticeRow(decoded),
  };
}

export function fingerprintDecodedSubmission(row: StoredLedgerRow) {
  const decoded = decode(row);
  return decoded.kind === 'user-input' ? submissionFingerprint(decoded.detail) : null;
}

export function fingerprintDecodedCliRow(message: string, input: JsonObject) {
  const detail = parseLedgerCliRowNoticeDetail(input);
  return detail ? cliRowFingerprint(message, detail) : null;
}

export function fenceDiagnostic(name: string, code: string, fenced: boolean) {
  const cause = Object.assign(new Error('synthetic detail'), { name, code });
  return safeFenceDiagnostic(fenced ? new LedgerFencedError('synthetic-chat', { cause }) : cause);
}
