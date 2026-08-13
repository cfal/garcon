import type { LedgerRow, LedgerRowDraft } from './contracts.js';

export function frozenConversationDrafts(rows: readonly LedgerRow[]): LedgerRowDraft[] {
  return rows.flatMap((row): readonly LedgerRowDraft[] => {
    if (row.kind === 'user-input') {
      return [{ kind: 'user-input', at: row.at, detail: row.detail, providerMeta: null }];
    }
    if (row.kind === 'provider-row') {
      return [{ kind: 'provider-row', at: row.at, message: row.message, providerMeta: null }];
    }
    return [];
  });
}
