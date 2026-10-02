import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage } from '../../../../common/chat-types.ts';
import {
  LedgerBulkOperationAbandonedError,
  StaleTranscriptViewError,
  TranscriptLedgerStore,
  transcriptViewId,
} from '../index.ts';

const at = '2026-08-12T00:00:00.000Z';
const LARGE = 1200;
let root;
let store;

beforeEach(async () => {
  root = path.join(os.tmpdir(), `garcon-ledger-bulk-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  store = new TranscriptLedgerStore(root, {
    createViewId: () => transcriptViewId(randomUUID()),
    now: () => at,
    connectionCacheSize: 1,
  });
});

afterEach(async () => {
  store?.close();
  await fs.rm(root, { recursive: true, force: true });
});

function provider(content) {
  return { kind: 'provider-row', at, message: new AssistantMessage(at, content) };
}

function rows(count, label) {
  return Array.from({ length: count }, (_, index) => provider(`${label} ${index}`));
}

// Counts event-loop turns taken while an operation runs and samples state during them.
function observeTurns(sample = () => undefined) {
  let turns = 0;
  let running = true;
  const samples = [];
  const tick = () => {
    if (!running) return;
    turns += 1;
    samples.push(sample());
    setImmediate(tick);
  };
  setImmediate(tick);
  return {
    stop() {
      running = false;
      return { turns, samples };
    },
  };
}

function viewRows(chatId) {
  const db = new Database(path.join(root, chatId, 'ledger.sqlite'), { readonly: true, create: false });
  try {
    return db.query(`
      SELECT v.view_id AS viewId, v.status AS status, count(r.ordinal) AS rows
      FROM transcript_views v LEFT JOIN transcript_rows r ON r.view_id = v.view_id
      GROUP BY v.view_id ORDER BY v.status
    `).all();
  } finally {
    db.close();
  }
}

describe('bounded transcript bulk operations', () => {
  it('streams a pinned prefix in bounded pages and rechecks the view after the final page', async () => {
    const view = store.initializeCurrentView('paged', { contentStartOrdinal: 1, rows: rows(2500, 'row') });
    const observer = observeTurns();
    let count = 0;
    for await (const page of store.rowPagesThrough('paged', { viewId: view.viewId, ordinal: 2100 })) {
      expect(page.length).toBeLessThanOrEqual(1000);
      expect(page[0].ordinal).toBe(count + 1);
      count += page.length;
    }
    expect(count).toBe(2100);
    expect(observer.stop().turns).toBeGreaterThan(1);

    const stream = store.rowPagesThrough('paged', { viewId: view.viewId, ordinal: 1 });
    expect((await stream.next()).value).toHaveLength(1);
    const next = await store.stageView('paged', { viewId: transcriptViewId('replacement'), contentStartOrdinal: 1, rows: [] });
    store.replaceCurrentView('paged', view.viewId, next.viewId);
    await expect(stream.next()).rejects.toBeInstanceOf(StaleTranscriptViewError);
  });

  it('seeds a long history across event-loop turns and exposes it only on promotion', async () => {
    const observer = observeTurns(() => store.currentView('seeded'));
    const view = await store.seedCurrentView('seeded', { contentStartOrdinal: 1, rows: rows(LARGE, 'seed') });
    const { turns, samples } = observer.stop();

    expect(turns).toBeGreaterThan(1);
    expect(samples.filter((sample) => sample !== null)).toEqual([]);
    expect(store.currentView('seeded')).toEqual(view);
    const stored = await store.rowsThrough('seeded', { viewId: view.viewId, ordinal: LARGE });
    expect(stored).toHaveLength(LARGE);
    expect(stored.at(-1)).toMatchObject({ ordinal: LARGE, message: { content: `seed ${LARGE - 1}` } });
  });

  it('keeps an in-progress staging view through a connection-cache reopen', async () => {
    const current = store.initializeCurrentView('reloaded', { contentStartOrdinal: 1, rows: rows(2, 'old') });
    const stagingId = transcriptViewId('staging-view');
    const observer = observeTurns(() => store.initializeCurrentView(`other-${randomUUID().slice(0, 8)}`, {
      contentStartOrdinal: 1,
    }));
    const staged = await store.stageView('reloaded', { viewId: stagingId, contentStartOrdinal: 1, rows: rows(LARGE, 'new') });
    const { turns } = observer.stop();

    expect(turns).toBeGreaterThan(1);
    const promoted = store.replaceCurrentView('reloaded', current.viewId, staged.viewId);
    expect(promoted.viewId).toBe(stagingId);
    expect((await store.rowsThrough('reloaded', { viewId: stagingId, ordinal: LARGE })).at(-1))
      .toMatchObject({ message: { content: `new ${LARGE - 1}` } });
  });

  it('retires a large replaced view in bounded steps without exposing it', async () => {
    const current = store.initializeCurrentView('retired', { contentStartOrdinal: 1, rows: rows(4500, 'old') });
    const staged = await store.stageView('retired', {
      viewId: transcriptViewId('replacement'),
      contentStartOrdinal: 1,
      rows: rows(1, 'new'),
    });

    store.replaceCurrentView('retired', current.viewId, staged.viewId);

    expect(() => store.page('retired', current.viewId, 10)).toThrow(StaleTranscriptViewError);
    const during = viewRows('retired').find((view) => view.viewId === current.viewId);
    expect(during).toMatchObject({ status: 'staging' });
    expect(during.rows).toBeGreaterThan(0);
    expect(during.rows).toBeLessThan(4500);
    for (let attempt = 0; attempt < 20 && viewRows('retired').length > 1; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(viewRows('retired')).toEqual([{ viewId: staged.viewId, status: 'current', rows: 1 }]);
  });

  it('abandons a seed when its chat is deleted and never recreates the ledger', async () => {
    const seeding = store.seedCurrentView('deleted', { contentStartOrdinal: 1, rows: rows(LARGE, 'seed') });
    await new Promise((resolve) => setImmediate(resolve));
    store.deleteChat('deleted');

    await expect(seeding).rejects.toBeInstanceOf(LedgerBulkOperationAbandonedError);
    expect(existsSync(path.join(root, 'deleted'))).toBe(false);
  });

  it('opens a ledger left with only an abandoned seed as uninitialized', async () => {
    const directory = path.join(root, 'crashed');
    await fs.mkdir(directory);
    const seeding = store.seedCurrentView('crashed', { contentStartOrdinal: 1, rows: rows(LARGE, 'seed') });
    await new Promise((resolve) => setImmediate(resolve));
    store.close();
    await expect(seeding).rejects.toBeInstanceOf(LedgerBulkOperationAbandonedError);

    store = new TranscriptLedgerStore(root, { now: () => at });
    expect(store.existingCurrentView('crashed')).toBeNull();
    expect(viewRows('crashed')).toEqual([]);
    const view = store.initializeCurrentView('crashed', { contentStartOrdinal: 1, rows: rows(1, 'fresh') });
    expect(store.currentRows('crashed')).toMatchObject([{ viewId: view.viewId, ordinal: 1 }]);
  });

  it('reads a long prefix in pages that yield between them', async () => {
    const view = store.initializeCurrentView('paged', { contentStartOrdinal: 1, rows: rows(2500, 'row') });
    const observer = observeTurns();
    const through = await store.rowsThrough('paged', { viewId: view.viewId, ordinal: 2100 });
    const { turns } = observer.stop();

    expect(turns).toBeGreaterThan(1);
    expect(through.map((row) => row.ordinal)).toEqual(Array.from({ length: 2100 }, (_, index) => index + 1));
    expect(store.currentRows('paged').slice(0, 2100)).toEqual(through);
  });
});
