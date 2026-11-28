import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import { encodeLedgerDraft } from '../../../server/controller/ledger/codec.ts';
import { transcriptViewId, type LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { filterTranscriptExportEntries, foldRowsForExport } from '../../../server/controller/ledger/export-fold.ts';
import { ledgerRowsToTranscriptMessages } from '../../../server/controller/ledger/presentation.ts';
import { frozenConversationDrafts, previewMessages } from '../../../server/controller/ledger/projection.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);

const [mode, root] = Bun.argv.slice(2) as [string, string];
const at = '2026-11-28T09:00:00.000Z';
const viewId = transcriptViewId('fold-view');
const store = new TranscriptLedgerStore(root, { now: () => at });
const chatId = 'ledger';
const omitted = '\u754c'.repeat(24_000);

try {
  if (mode === 'write') {
    const rows = Array.from({ length: 70 }, (_, i): LedgerRowDraft => ({
      kind: 'notice', at, message: `Synthetic ${i}`, detail: {},
    }));
    rows[0] = { kind: 'provider-row', at, message: new UserMessage(at, 'first') };
    rows[2] = { kind: 'provider-row', at, message: new UserMessage(at, omitted) };
    rows[67] = { kind: 'provider-row', at, message: new AssistantMessage(at, 'last bounded') };
    rows[68] = { kind: 'provider-row', at, message: new AssistantMessage(at, omitted) };
    rows[69] = { kind: 'run-ended', at, outcome: 'failed', origin: 'core', error: { code: 'SYNTHETIC', message: 'failure' } };
    store.initializeCurrentView(chatId, { viewId, contentStartOrdinal: 1, rows });
  } else if (mode !== 'read') {
    throw new Error(`Invalid oracle mode: ${mode}`);
  }
  const edges = store.previewEdges(chatId, viewId);
  const rows = [...store.replayRows(chatId, viewId, 0, 2, 2), ...store.replayRows(chatId, viewId, 69, 70, 1)];
  const wideRows = Array.from({ length: 20_000 }, (_, index) => ({ ...rows[1]!, ordinal: index + 1 }));
  const start = performance.now();
  const wide = JSON.stringify(ledgerRowsToTranscriptMessages(wideRows));
  console.error(`Bun presentation plus JSON (20,000 notices): ${(performance.now() - start).toFixed(2)} ms`);
  console.log(JSON.stringify({ edges, preview: previewMessages(edges),
    frozen: frozenConversationDrafts(rows).map(encodeLedgerDraft),
    exported: filterTranscriptExportEntries(foldRowsForExport(rows), ['diagnostics']),
    wideBytes: Buffer.byteLength(wide),
  }));
} finally {
  store.close();
}
