import {
  isCarryoverMigrationQuarantineNoticeDetail,
  isPreambleApplicationNoticeDetail,
} from '../../../common/transcript-notice-details.js';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { LedgerConversationRow, LedgerRow, LedgerRowDraft } from './contracts.js';
import { isConversationalLedgerRow, isPresentationOnlyProviderRow } from './contracts.js';

export function messageForConversationRow(row: LedgerConversationRow): ChatMessage {
  return row.kind === 'user-input' ? row.detail.message : row.message;
}

export function previewMessages(edges: { head: readonly LedgerRow[] | null; tail: readonly LedgerRow[] }): { first: ChatMessage; last: ChatMessage } | null {
  if (edges.head === null) return null;
  const head = edges.head.filter(isConversationalLedgerRow).map(messageForConversationRow);
  const tail = edges.tail.filter(isConversationalLedgerRow).map(messageForConversationRow);
  const first = head.find((message) => message.type === 'user-message') ?? head[0];
  const last = tail.at(-1);
  return first && last ? { first, last } : null;
}

export function frozenConversationDrafts(rows: readonly LedgerRow[]): LedgerRowDraft[] {
  return rows.flatMap((row): readonly LedgerRowDraft[] => {
    if (row.kind === 'user-input') {
      return [{ kind: 'user-input', at: row.at, detail: row.detail, providerMeta: null }];
    }
    // The handoff boundary is durable history, so it survives reload and fork the same way
    // the conversation does rather than being re-derived from ownership state.
    if (row.kind === 'agent-switch') {
      return [{ kind: 'agent-switch', at: row.at, detail: row.detail, providerMeta: null }];
    }
    if (row.kind === 'provider-row') {
      if (isPresentationOnlyProviderRow(row)) return [];
      return [{ kind: 'provider-row', at: row.at, message: row.message, providerMeta: null }];
    }
    if (
      row.kind === 'notice'
      && (
        isCarryoverMigrationQuarantineNoticeDetail(row.detail)
        || isPreambleApplicationNoticeDetail(row.detail)
      )
    ) {
      return [{
        kind: 'notice',
        at: row.at,
        message: row.message,
        detail: row.detail,
        providerMeta: null,
      }];
    }
    return [];
  });
}
