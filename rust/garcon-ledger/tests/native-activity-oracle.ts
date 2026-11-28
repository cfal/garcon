import { decodeLedgerRow } from '../../../server/controller/ledger/codec.ts';
import { transcriptViewId, type LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

if (Bun.version !== '1.4.3') throw new Error('Expected Bun 1.4.3, received ' + Bun.version);
const [mode, root] = Bun.argv.slice(2) as [string, string];
const at = '2026-11-28T09:00:00.000Z';
const later = '2026-11-28T10:00:00.000Z';
const viewId = transcriptViewId('activity-view');
const store = new TranscriptLedgerStore(root, { now: () => at, createViewId: () => viewId });
const text = await Bun.file(new URL('./inputs/native-activity.jsonl', import.meta.url)).text();
const drafts = text.trimEnd().split('\n').map((line): LedgerRowDraft => {
  const [kind, value, clientMessageId] = JSON.parse(line) as [string, unknown, string?];
  const { viewId: _, ordinal, ...draft } = decodeLedgerRow({
    view_id: viewId, ordinal: 1, at, kind,
    client_message_id: clientMessageId ?? null,
    payload_json: JSON.stringify({ providerMeta: null, value }),
  });
  return draft;
});
const initial = drafts[0]!;
const ignored = (index: number): LedgerRowDraft => ({
  kind: 'notice', at: later, message: 'Synthetic notice ' + index, detail: { type: 'ordinary-notice' }, providerMeta: null,
});
const snapshots = (chatId: string) => store.nativeActivityState(chatId);

try {
  if (mode === 'measure') {
    const rows = [initial, ...Array.from({ length: 20_000 }, (_, index) => ignored(index))];
    await store.seedCurrentView('suffix', { viewId, contentStartOrdinal: 1, rows });
    const started = performance.now();
    const state = snapshots('suffix');
    console.error('Bun native activity, 20,000-row excluded suffix: ' + (performance.now() - started).toFixed(2) + ' ms');
    console.log(JSON.stringify(state));
  } else {
    if (mode === 'write') {
      drafts.forEach((draft, index) => {
        store.initializeCurrentView('case-' + index, { viewId, contentStartOrdinal: 1, rows: [initial, draft, ignored(index)] });
      });
      store.initializeCurrentView('after-switch', { viewId, contentStartOrdinal: 2, rows: [initial, ignored(0)] });
    } else if (mode !== 'read') {
      throw new Error('Unexpected mode: ' + mode);
    }
    console.log(JSON.stringify([...drafts.map((_, index) => snapshots('case-' + index)), snapshots('after-switch')]));
  }
} finally {
  store.close();
}
