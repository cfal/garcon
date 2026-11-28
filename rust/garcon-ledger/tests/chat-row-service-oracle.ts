import { transcriptViewId } from '../../../server/controller/ledger/contracts.ts';
import { StaleTranscriptViewError, SubmissionConflictError } from '../../../server/controller/ledger/errors.ts';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);

const [mode, root] = Bun.argv.slice(2) as [string, string];
const at = '2026-11-28T09:00:00.000Z';
let now = at;
const rowsView = transcriptViewId('row-view');
const old = transcriptViewId('before');
const staged = transcriptViewId('after');
const store = new TranscriptLedgerStore(root, { now: () => at });
const service = new TranscriptLedgerService(store, { now: () => now });
const events: unknown[] = [];

try {
  if (mode === 'write') {
    store.initializeCurrentView('rows', { viewId: rowsView, contentStartOrdinal: 1, rows: [] });
    store.initializeCurrentView('replace', { viewId: old, contentStartOrdinal: 1, rows: [] });
    await store.stageView('replace', { viewId: staged, contentStartOrdinal: 1, rows: [] });
    service.subscribe(event => {
      if (event.type === 'rows') {
        events.push({ type: event.type, chatId: event.chatId, viewId: event.viewId,
          ordinals: event.rows.map(row => row.ordinal) });
      } else if (event.type === 'view-replaced') {
        events.push({ type: event.type, chatId: event.chatId, previousViewId: event.previousViewId,
          viewId: event.view.viewId });
      } else throw new Error(`Unexpected event: ${event.type}`);
    });
    const input = {
      chatId: 'rows', viewId: rowsView, clientMessageId: 'synthetic-submission',
      presentation: { style: 'custom', customStyle: { lightAccent: '#112233', darkAccent: '#445566' } },
      format: 'markdown', disclosure: 'collapsed', title: '  Release validation  ',
      content: '  Synthetic release notes\n',
    } as const;
    const first = service.appendChatRow(input);
    now = '2026-11-28T09:00:01.000Z';
    const retry = service.appendChatRow(input);
    if (!first.inserted || retry.inserted || retry.row.at !== first.row.at) {
      throw new Error('Retry changed an accepted submission');
    }
    try {
      service.appendChatRow({ ...input, content: 'changed' });
      throw new Error('Committed a conflicting submission');
    } catch (error) {
      if (!(error instanceof SubmissionConflictError)) throw error;
    }
    service.replaceCurrentView('replace', old, staged);
    try {
      service.appendChatRow({ ...input, chatId: 'replace', viewId: old });
      throw new Error('Committed a stale submission');
    } catch (error) {
      if (!(error instanceof StaleTranscriptViewError)) throw error;
    }
    if (events.length !== 0) throw new Error('Delivered listeners synchronously');
    await Promise.resolve();
  } else if (mode !== 'read') {
    throw new Error(`Unknown fixture mode: ${mode}`);
  }
  const head = store.highWatermark('rows');
  const rows = await store.withStoredRowsThrough('rows', head, async rows => rows);
  const replacement = store.currentView('replace');
  console.log(JSON.stringify({ durable: JSON.stringify({ head, rows, replacement }), events }));
} finally {
  service.close();
}
