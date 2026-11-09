import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage } from '../../../../common/chat-types.ts';
import {
  LedgerBulkOperationAbandonedError,
  LedgerFencedError,
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

describe('cooperative anchor responses', () => {
  function initialize() {
    return store.initializeCurrentView('anchors', { contentStartOrdinal: 1,
      rows: Array.from({ length: 650 }, () => ({ kind: 'run-ended', at, origin: 'core', outcome: 'finished' })) });
  }

  function read(view, signal) {
    return store.anchorPage('anchors', view.viewId, {
      direction: 'forward', cursorOrdinal: 0, watermarkOrdinal: 650, anchorsRemaining: 1,
    }, signal);
  }

  it('lets the event loop progress within one complete response', async () => {
    const view = initialize();
    let time = performance.now();
    const clock = spyOn(performance, 'now').mockImplementation(() => ++time);
    const observer = observeTurns();
    try {
      const result = await read(view);
      expect(result.pageStatus).toBe('exhausted');
      expect(result.rows.map(row => row.ordinal)).toEqual(Array.from({ length: 650 }, (_, i) => i + 1));
      expect(observer.stop().turns).toBeGreaterThan(1);
    } finally {
      observer.stop();
      clock.mockRestore();
    }
  });

  it.each(['append', 'evict', 'replace', 'delete', 'closeChat', 'close', 'abort', 'corrupt', 'query-failure'])(
    'revalidates ownership and data after a held batch: %s', async action => {
      const view = initialize();
      const replacement = await store.stageView('anchors', {
        viewId: transcriptViewId('replacement'), contentStartOrdinal: 1, rows: [],
      });
      const held = Promise.withResolvers();
      const pause = spyOn(EventLoopSteps.prototype, 'next').mockImplementationOnce(() => held.promise);
      const abort = new AbortController();
      const pending = read(view, abort.signal);
      try {
        expect(pause).toHaveBeenCalledTimes(1);
        if (action === 'append') store.append('anchors', view.viewId, [provider('new anchor')]);
        if (action === 'evict') store.initializeCurrentView('other', { contentStartOrdinal: 1 });
        if (action === 'replace') store.replaceCurrentView('anchors', view.viewId, replacement.viewId);
        if (action === 'delete') store.deleteChat('anchors');
        if (action === 'closeChat') store.closeChat('anchors');
        if (action === 'close') store.close();
        if (action === 'abort') abort.abort(new Error('synthetic cancellation'));
        if (action === 'corrupt' || action === 'query-failure') {
          const db = new Database(path.join(root, 'anchors', 'ledger.sqlite'));
          if (action === 'corrupt') db.query("UPDATE transcript_rows SET payload_json = 'invalid' WHERE ordinal = 350").run();
          else db.run('DROP TABLE transcript_rows');
          db.close();
        }
        held.resolve();
        if (action === 'replace') await expect(pending).rejects.toBeInstanceOf(StaleTranscriptViewError);
        else if (['delete', 'closeChat', 'close'].includes(action)) {
          await expect(pending).rejects.toBeInstanceOf(LedgerBulkOperationAbandonedError);
        } else if (action === 'abort') await expect(pending).rejects.toBe(abort.signal.reason);
        else if (action === 'corrupt' || action === 'query-failure') {
          await expect(pending).rejects.toBeInstanceOf(LedgerFencedError);
          expect(() => store.currentView('anchors')).toThrow(LedgerFencedError);
          expect(store.initializeCurrentView('healthy', { contentStartOrdinal: 1 })).not.toBeNull();
        } else {
          const result = await pending;
          expect(result.rows.map(row => row.ordinal)).toEqual(Array.from({ length: 650 }, (_, i) => i + 1));
          expect(result).toMatchObject({ startOrdinal: 1, endOrdinal: 651, pageStatus: 'exhausted', anchorsRemaining: 1 });
        }
        if (action === 'delete') expect(existsSync(path.join(root, 'anchors'))).toBe(false);
        if (action === 'abort' || action === 'replace') expect(store.currentView('anchors')).not.toBeNull();
        if (action === 'append') {
          expect((await store.anchorPage('anchors', view.viewId, {
            direction: 'forward', cursorOrdinal: 650, watermarkOrdinal: 651, anchorsRemaining: 1,
          })).rows.map(row => row.ordinal)).toEqual([651]);
        }
      } finally {
        held.resolve();
        await pending.catch(() => {});
        pause.mockRestore();
      }
    },
  );

  for (const terminal of ['complete', 'exhausted']) {
    it.each(['delete', 'closeChat', 'close', 'abort'])(
      `revalidates ownership after the final ${terminal} batch: %s`, async action => {
        const view = store.initializeCurrentView('anchors', { contentStartOrdinal: 1,
          rows: [provider('first anchor'), ...Array.from({ length: 10 }, () => ({
            kind: 'run-ended', at, origin: 'core', outcome: 'finished',
          })), ...(terminal === 'complete' ? [provider('excluded anchor')] : [])] });
        const held = Promise.withResolvers();
        const clock = spyOn(performance, 'now').mockReturnValue(0);
        const pause = spyOn(EventLoopSteps.prototype, 'next').mockImplementationOnce(() => held.promise);
        const existing = spyOn(store, 'existingCurrentView');
        const abort = new AbortController();
        const pending = store.anchorPage('anchors', view.viewId, {
          direction: 'forward', cursorOrdinal: 0,
          watermarkOrdinal: terminal === 'complete' ? 12 : 11, anchorsRemaining: 1,
        }, abort.signal);
        try {
          expect(pause).toHaveBeenCalledTimes(1);
          expect(existing).toHaveBeenCalledTimes(1);
          if (action === 'delete') store.deleteChat('anchors');
          if (action === 'closeChat') store.closeChat('anchors');
          if (action === 'close') store.close();
          if (action === 'abort') abort.abort(new Error('synthetic final cancellation'));
          held.resolve();
          if (action === 'abort') await expect(pending).rejects.toBe(abort.signal.reason);
          else await expect(pending).rejects.toBeInstanceOf(LedgerBulkOperationAbandonedError);
          expect(existing).toHaveBeenCalledTimes(1);
          if (action === 'delete') expect(existsSync(path.join(root, 'anchors'))).toBe(false);
          if (action === 'abort') expect(store.currentView('anchors').viewId).toBe(view.viewId);
        } finally {
          held.resolve();
          await pending.catch(() => {});
          existing.mockRestore();
          pause.mockRestore();
          clock.mockRestore();
        }
      },
    );
  }

  it('does not create storage for a missing chat', async () => {
    await expect(read({ viewId: transcriptViewId('missing') })).rejects.toThrow('no current view');
    expect(existsSync(path.join(root, 'anchors'))).toBe(false);
  });
});
