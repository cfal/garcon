import { AssistantMessage } from '../../../common/chat-types.ts';
import { transcriptViewId } from '../../../server/controller/ledger/contracts.ts';
import { TranscriptSinkClosedError } from '../../../server/controller/ledger/errors.ts';
import { ProducerLease } from '../../../server/controller/ledger/producer-lease.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);

const [mode, root] = Bun.argv.slice(2) as [string, string];
const chatId = 'lease';
const viewId = transcriptViewId('lease-view');
const at = '2026-11-28T09:00:00.000Z';
const store = new TranscriptLedgerStore(root, { now: () => at });
const lease = new ProducerLease(event => {
  if (event.type !== 'rows') throw new Error('Expected only row events in this fixture');
  store.append(chatId, viewId, event.rows.map(row => ({
    kind: 'provider-row', at: row.message.timestamp, message: row.message, providerMeta: row.providerMeta,
  })));
}, () => undefined);
const oldSink = lease.sink;

try {
  if (mode === 'write') {
    store.initializeCurrentView(chatId, { viewId, contentStartOrdinal: 1, rows: [] });
    oldSink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'Synthetic accepted response') }] });
    if (store.highWatermark(chatId).ordinal !== 1) throw new Error('Publish did not commit synchronously');
  } else if (mode !== 'read') {
    throw new Error(`Invalid oracle mode: ${mode}`);
  }
  lease.close();
  let rejection: { name: string; message: string };
  try {
    oldSink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'Synthetic retired response') }] });
    throw new Error('The retired sink accepted an event');
  } catch (error) {
    if (!(error instanceof TranscriptSinkClosedError)) throw error;
    rejection = { name: error.name, message: error.message };
  }
  const head = store.highWatermark(chatId);
  const rows = await store.withStoredRowsThrough(chatId, head, async rows => rows);
  console.log(JSON.stringify({ head, rows, rejection }));
} finally {
  store.close();
}
