import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { transcriptViewId, type LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);

const [mode, root] = Bun.argv.slice(2) as [string, string];
const chatId = 'ledger';
const at = '2026-11-28T09:00:00.000Z';
const old = transcriptViewId('old');
const replacement = transcriptViewId('replacement');
const store = new TranscriptLedgerStore(root, { now: () => at });

function notices(length: number, prefix: string): LedgerRowDraft[] {
  return Array.from({ length }, (_, i) => ({ kind: 'notice', at, message: `${prefix} ${i}`, detail: {} }));
}

function query(sql: string, viewId: string) {
  const db = new Database(join(root, chatId, 'ledger.sqlite'), { readonly: true, create: false });
  try {
    return db.query(sql).all(viewId);
  } finally {
    db.close();
  }
}

function count(viewId: string): number {
  return (query('SELECT count(*) AS total FROM transcript_rows WHERE view_id = ?', viewId)[0] as { total: number }).total;
}

try {
  if (mode === 'write') {
    const seeding = store.seedCurrentView(chatId, {
      viewId: old, contentStartOrdinal: 1, rows: notices(4501, 'old'),
    });
    if (store.currentView(chatId) !== null || count(old) !== 500) throw new Error('Seed must stay inert');
    await seeding;
    const newRows = notices(505, 'new');
    const startStage = performance.now();
    const staging = store.stageView(chatId, {
      viewId: replacement, contentStartOrdinal: 3, rows: newRows,
    });
    console.error(`Bun first staging batch (500 rows): ${(performance.now() - startStage).toFixed(2)} ms`);
    if (store.currentView(chatId)?.viewId !== old || count(replacement) !== 500) {
      throw new Error('Replacement must stay inert while staging');
    }
    await staging;
    const startPromotion = performance.now();
    store.replaceCurrentView(chatId, old, replacement);
    console.error(`Bun promotion and first discard batch (2000 rows): ${(performance.now() - startPromotion).toFixed(2)} ms`);
    if (count(old) !== 2501) throw new Error('Promotion must discard in bounded steps');
    for (let turn = 0; turn < 20 && count(old) !== 0; ++turn) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (count(old) !== 0) throw new Error('Detached discard did not complete');
  } else if (mode === 'unicode-batch') {
    store.initializeCurrentView(chatId, { viewId: old, contentStartOrdinal: 1 });
    const rows = Array.from({ length: 8 }, (): LedgerRowDraft => ({
      kind: 'notice', at, message: '\u754c'.repeat(400_000), detail: {},
    }));
    const startStage = performance.now();
    const staging = store.stageView(chatId, { viewId: replacement, contentStartOrdinal: 1, rows });
    console.error(`Bun first staging batch (UTF-16 cap): ${(performance.now() - startStage).toFixed(2)} ms`);
    const firstBatchRows = count(replacement);
    await staging;
    console.log(JSON.stringify({ firstBatchRows }));
  } else if (mode !== 'read') {
    throw new Error(`Invalid oracle mode: ${mode}`);
  }

  if (mode !== 'unicode-batch') {
    const view = store.existingCurrentView(chatId);
    if (!view) throw new Error('Expected current view');
    const page = store.page(chatId, view.viewId, 4);
    const stored = query(`SELECT view_id, ordinal, kind, at, client_message_id, payload_json
      FROM transcript_rows WHERE view_id = ? ORDER BY ordinal`, view.viewId);
    console.log(JSON.stringify({ view, page, stored }));
  }
} finally {
  store.close();
}
