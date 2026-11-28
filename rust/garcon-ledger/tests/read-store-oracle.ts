import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { AssistantMessage } from '../../../common/chat-types.ts';
import { readAnchorBatch } from '../../../server/controller/ledger/anchor-page.ts';
import { transcriptViewId, type LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);

const [mode, root] = Bun.argv.slice(2) as [string, string];
const chatId = 'ledger';
const at = '2026-11-28T09:00:00.000Z';
const rows = 1207;
const viewId = transcriptViewId('read-interop');
const store = new TranscriptLedgerStore(root, { now: () => at });

function drafts(): LedgerRowDraft[] {
  return Array.from({ length: rows }, (_, i) => {
    if (i % 113 === 0) return { kind: 'provider-row', at, message: new AssistantMessage(at, `assistant ${i}`) };
    if (i % 3 === 0) return { kind: 'run-ended', at, outcome: 'finished', origin: 'core' };
    return { kind: 'notice', at, message: `notice ${i}`, detail: {} };
  });
}

try {
  if (mode === 'write') {
    await store.seedCurrentView(chatId, { viewId, contentStartOrdinal: 1, rows: drafts() });
  } else if (mode !== 'read') {
    throw new Error(`Invalid oracle mode: ${mode}`);
  }
  const watermark = store.highWatermark(chatId);
  const newest = await store.anchorPage(chatId, viewId, {
    direction: 'backward', cursorOrdinal: watermark.ordinal + 1, watermarkOrdinal: watermark.ordinal, anchorsRemaining: 3,
  });
  const oldest = await store.anchorPage(chatId, viewId, {
    direction: 'forward', cursorOrdinal: 1, watermarkOrdinal: watermark.ordinal - 30, anchorsRemaining: 2,
  });
  const input = { direction: 'forward' as const, cursorOrdinal: 0, watermarkOrdinal: watermark.ordinal, anchorsRemaining: 200 };
  const db = new Database(join(root, chatId, 'ledger.sqlite'), { readonly: true, create: false });
  let batch;
  try {
    const start = performance.now();
    batch = readAnchorBatch(db, viewId, input, input, () => false);
    console.error(`Bun single anchor batch (200 rows): ${(performance.now() - start).toFixed(2)} ms`);
  } finally {
    db.close();
  }
  const startReplay = performance.now();
  const replay = store.replayRows(chatId, viewId, 15, watermark.ordinal - 20, 1000);
  console.error(`Bun replay of 1000 raw rows: ${(performance.now() - startReplay).toFixed(2)} ms`);
  const startFull = performance.now();
  const currentCount = store.currentRows(chatId).length;
  console.error(`Bun currentRows of ${currentCount} rows: ${(performance.now() - startFull).toFixed(2)} ms`);
  const through = { viewId, ordinal: 1101 };
  const pages = [];
  for await (const page of store.rowPagesThrough(chatId, through, 7)) pages.push(page.map(row => row.ordinal));
  const stored = await store.withStoredRowsThrough(chatId, { viewId, ordinal: 4 }, async raw => raw);
  console.log(JSON.stringify({ watermark, newest, oldest, batch, replay, currentCount, pages, stored }));
} finally {
  store.close();
}
