import type { LedgerRow, TranscriptViewId } from './contracts.js';
import type { TranscriptLedgerService } from './service.js';

type UserExportRow = Exclude<LedgerRow, { readonly kind: 'session' }> extends infer Row
  ? Row extends LedgerRow
    ? Omit<Row, 'providerMeta'>
    : never
  : never;

export interface UserTranscriptExport {
  readonly chatId: string;
  readonly transcriptViewId: TranscriptViewId;
  readonly rows: readonly UserExportRow[];
}

export interface RawSupportTranscriptExport {
  readonly chatId: string;
  readonly transcriptViewId: TranscriptViewId;
  readonly rows: readonly LedgerRow[];
}

export function exportUserTranscript(
  ledger: TranscriptLedgerService,
  chatId: string,
): UserTranscriptExport {
  const view = requireCurrentView(ledger, chatId);
  const rows = ledger.currentRows(chatId).flatMap((row): readonly UserExportRow[] => {
    if (row.kind === 'session') return [];
    const { providerMeta: _providerMeta, ...exported } = row;
    return [exported as UserExportRow];
  });
  return { chatId, transcriptViewId: view.viewId, rows };
}

export function exportRawSupportTranscript(
  ledger: TranscriptLedgerService,
  chatId: string,
): RawSupportTranscriptExport {
  const view = requireCurrentView(ledger, chatId);
  return { chatId, transcriptViewId: view.viewId, rows: ledger.currentRows(chatId) };
}

function requireCurrentView(ledger: TranscriptLedgerService, chatId: string) {
  const view = ledger.currentView(chatId);
  if (!view) throw new TypeError(`Transcript view is not initialized for ${chatId}`);
  return view;
}
