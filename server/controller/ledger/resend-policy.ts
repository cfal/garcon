import { isPresentationOnlyProviderRow, type LedgerRow } from './contracts.js';

export function resendRole(row: LedgerRow): 'candidate' | 'skip' | 'boundary' {
  if (row.kind === 'user-input') return row.detail.message.metadata?.contentMode === 'literal' ? 'skip' : 'candidate';
  if (row.kind === 'run-ended' && row.outcome === 'interrupted') return 'skip';
  if (isPresentationOnlyProviderRow(row)) return 'skip';
  return row.kind === 'provider-row' || row.kind === 'permission-requested' || row.kind === 'run-ended' ? 'boundary' : 'skip';
}
