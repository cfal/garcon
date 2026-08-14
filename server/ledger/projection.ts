import type { LedgerRow, LedgerRowDraft } from './contracts.js';

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
      return [{ kind: 'provider-row', at: row.at, message: row.message, providerMeta: null }];
    }
    return [];
  });
}
