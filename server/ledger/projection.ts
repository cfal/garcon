import { isCarryoverMigrationQuarantineNoticeDetail } from '../../common/chat-types.js';
import type { LedgerRow, LedgerRowDraft } from './contracts.js';
import { isPresentationOnlyProviderRow } from './contracts.js';

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
      && isCarryoverMigrationQuarantineNoticeDetail(row.detail)
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
