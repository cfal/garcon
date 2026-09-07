import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LedgerFencedError,
  TranscriptLedgerStore,
  transcriptViewId,
} from '../index.ts';

let root;
let store;
let restoreDatabaseClose;

beforeEach(async () => {
  root = path.join(os.tmpdir(), `garcon-ledger-lru-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  store = new TranscriptLedgerStore(root, { connectionCacheSize: 1 });
});

afterEach(async () => {
  restoreDatabaseClose?.();
  restoreDatabaseClose = null;
  store?.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('TranscriptLedgerStore failed LRU close recovery', () => {
  it('retries an evicted handle when that chat is explicitly closed', () => {
    store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    const failure = failFirstEvictedDatabaseCloses(1);

    const opened = store.initializeCurrentView('chat-two', {
      viewId: transcriptViewId('view-two'),
      contentStartOrdinal: 1,
    });

    expect(opened.viewId).toBe('view-two');
    expect(failure.attempts()).toBe(1);
    expect(() => store.currentView('chat-one')).toThrow(LedgerFencedError);

    store.closeChat('chat-one');

    expect(failure.attempts()).toBe(2);
    store.closeChat('chat-one');
    expect(failure.attempts()).toBe(2);
    expect(store.currentView('chat-two')?.viewId).toBe('view-two');
  });

  it('does not delete a chat directory until its evicted handle closes', async () => {
    store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    const failure = failFirstEvictedDatabaseCloses(2);

    store.initializeCurrentView('chat-two', {
      viewId: transcriptViewId('view-two'),
      contentStartOrdinal: 1,
    });
    expect(failure.attempts()).toBe(1);

    expect(() => store.deleteChat('chat-one')).toThrow('injected ledger close failure');
    expect(failure.attempts()).toBe(2);
    expect(await fs.stat(path.join(root, 'chat-one')).catch(() => null)).not.toBeNull();
    expect(store.currentView('chat-two')?.viewId).toBe('view-two');

    store.deleteChat('chat-one');

    expect(failure.attempts()).toBe(3);
    expect(await fs.stat(path.join(root, 'chat-one')).catch(() => null)).toBeNull();
  });
});

function failFirstEvictedDatabaseCloses(failureCount) {
  const close = Database.prototype.close;
  let failedDatabase = null;
  let attempts = 0;
  let closed = false;

  Database.prototype.close = function () {
    if (failedDatabase === null) failedDatabase = this;
    if (this === failedDatabase) {
      attempts += 1;
      if (attempts <= failureCount) throw new Error('injected ledger close failure');
      closed = true;
    }
    return close.call(this);
  };

  restoreDatabaseClose = () => {
    Database.prototype.close = close;
    if (failedDatabase !== null && !closed) close.call(failedDatabase);
  };
  return { attempts: () => attempts };
}
