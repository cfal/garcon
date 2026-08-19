import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSearchDatabase } from '../schema.js';
import { SearchTokenizer } from '../tokenizer.js';
import type { ReaderEvent, ReaderRequest } from '../worker-protocol.js';
import { isReaderEvent, SEARCH_READER_MAX_ALLOWLIST_ROWS } from '../worker-protocol.js';

test('reader sender rejects structurally invalid outbound events', async () => {
  const previousOnMessage = self.onmessage;
  const { assertReaderEventForPost } = await import('../reader-main.js');
  try {
    expect(() => assertReaderEventForPost({
      type: 'reader-step-complete',
      requestId: 1,
      lifecycleEpoch: 'reader-sender-test',
      grantId: 1,
      result: { kind: 'continue' },
    })).not.toThrow();
    expect(() => assertReaderEventForPost({
      type: 'reader-step-complete',
      requestId: 1,
      lifecycleEpoch: 'reader-sender-test',
      grantId: 1,
      result: { kind: 'continue' },
      unexpected: true,
    })).toThrow('INVALID_READER_EVENT');
    expect(() => assertReaderEventForPost({
      type: 'reader-step-complete',
      requestId: 1,
      lifecycleEpoch: 'reader-sender-test',
      grantId: 1,
      result: {
        kind: 'result-chunk',
        chunkIndex: 0,
        results: [],
        done: true,
      },
    })).toThrow('INVALID_READER_EVENT');
  } finally {
    self.onmessage = previousOnMessage;
  }
});

function receive(worker: Worker): Promise<ReaderEvent> {
  return new Promise((resolve, reject) => {
    const message = (event: MessageEvent<unknown>) => {
      cleanup();
      if (!isReaderEvent(event.data)) {
        reject(new Error('INVALID_READER_EVENT'));
        return;
      }
      resolve(event.data);
    };
    const error = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error(event.message));
    };
    const cleanup = () => {
      worker.removeEventListener('message', message);
      worker.removeEventListener('error', error);
    };
    worker.addEventListener('message', message);
    worker.addEventListener('error', error);
  });
}

async function exchange(worker: Worker, request: ReaderRequest): Promise<ReaderEvent> {
  const event = receive(worker);
  worker.postMessage(request);
  return event;
}

async function finishSearch(
  worker: Worker,
  requestId: number,
  lifecycleEpoch: string,
): Promise<Extract<ReaderEvent, { type: 'reader-step-complete' }>> {
  for (let grantId = 1; grantId <= 100; grantId += 1) {
    const event = await exchange(worker, {
      type: 'reader-step-grant',
      requestId,
      lifecycleEpoch,
      grantId,
    });
    if (event.type === 'reader-step-complete'
        && event.result.kind === 'result-chunk' && event.result.done) return event;
  }
  throw new Error('READER_TEST_GRANT_LIMIT');
}

test('[TLV5-SEARCH.07-READER-WORKER-CORE-UNIT-01] reader Worker acknowledges input, advances only on grants, and cooperatively closes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'garcon-reader-v8-'));
  const tokenizer = SearchTokenizer.create();
  let worker: Worker | null = null;
  try {
    const dbPath = path.join(directory, 'search.sqlite');
    const opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    opened.db.close();
    worker = new Worker(new URL('../reader-main.ts', import.meta.url));
    const lifecycleEpoch = 'reader-v8-test';
    expect(await exchange(worker, {
      type: 'open',
      requestId: 1,
      lifecycleEpoch,
      dbPath,
    })).toEqual({ type: 'opened', requestId: 1, lifecycleEpoch });
    expect(await exchange(worker, {
      type: 'search-start',
      requestId: 2,
      lifecycleEpoch,
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'needle', normalized: 'needle', match: 'exact' }],
        }],
      },
      limit: 20,
    })).toEqual({
      type: 'search-input-ack',
      requestId: 2,
      lifecycleEpoch,
      chunkIndex: null,
      ready: false,
    });
    expect(await exchange(worker, {
      type: 'search-allowlist-chunk',
      requestId: 2,
      lifecycleEpoch,
      chunkIndex: 0,
      allowedChats: [],
      done: true,
    })).toEqual({
      type: 'search-input-ack',
      requestId: 2,
      lifecycleEpoch,
      chunkIndex: 0,
      ready: true,
    });

    let grantId = 1;
    let final: ReaderEvent | null = null;
    while (!final) {
      const event = await exchange(worker, {
        type: 'reader-step-grant',
        requestId: 2,
        lifecycleEpoch,
        grantId,
      });
      grantId += 1;
      if (event.type === 'reader-step-complete'
          && event.result.kind === 'result-chunk' && event.result.done) final = event;
      else expect(event).toMatchObject({
        type: 'reader-step-complete',
        requestId: 2,
        lifecycleEpoch,
        result: { kind: 'continue' },
      });
    }
    expect(final).toMatchObject({
      type: 'reader-step-complete',
      result: {
        kind: 'result-chunk',
        chunkIndex: 0,
        results: [],
        index: {
          indexedChatCount: 0,
          pendingChatCount: 0,
          failedChatCount: 0,
          unsupportedChatCount: 0,
        },
        done: true,
      },
    });

    const closed = new Promise<void>((resolve) => worker!.addEventListener('close', () => resolve(), {
      once: true,
    }));
    expect(await exchange(worker, {
      type: 'reader-quiesce',
      requestId: 3,
      lifecycleEpoch,
    })).toEqual({ type: 'reader-quiesced', requestId: 3, lifecycleEpoch });
    await closed;
    worker = null;
  } finally {
    worker?.terminate();
    tokenizer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reader Worker reports copied-chat corruption without emitting a result frame', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'garcon-reader-corrupt-v8-'));
  const tokenizer = SearchTokenizer.create();
  let worker: Worker | null = null;
  try {
    const dbPath = path.join(directory, 'search.sqlite');
    const opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    const document = tokenizer.tokenizeDocument('needle private body');
    opened.db.query(`
      INSERT INTO search_chat_state VALUES (
        'owner', 'owner-view', 'indexed', 'idle', 1, 1, NULL, 1, ?, NULL, ?
      )
    `).run(document.tokenCount, '2026-01-01T00:00:00.000Z');
    const chunkId = Number(opened.db.query<{ id: number }, []>(`
      INSERT INTO search_chunks(
        chat_id, transcript_view_id, ordinal, role, timestamp, body, body_bytes,
        token_count, term_count, term_bytes, position_bytes
      ) VALUES (
        'owner', 'owner-view', 1, 1, NULL, 'needle private body', 19, ?, ?, ?, ?
      ) RETURNING id
    `).get(
      document.tokenCount,
      document.termCount,
      document.termBytes,
      document.positionBytes,
    )!.id);
    opened.db.query('INSERT INTO search_chunk_progress VALUES (?, 1, ?, ?, ?, ?, ?)').run(
      chunkId,
      document.termCount,
      document.tokenCount - 1,
      document.termBytes,
      document.positionBytes,
      document.postings.at(-1)!.term,
    );
    for (const posting of document.postings) {
      opened.db.query('INSERT INTO search_chunk_terms VALUES (?, ?, ?, ?, ?)').run(
        chunkId,
        'forged',
        posting.term,
        posting.frequency,
        posting.positions,
      );
    }
    opened.db.query(`
      UPDATE search_corpus_stats SET document_count=1, total_token_count=? WHERE singleton=1
    `).run(document.tokenCount);
    opened.db.close();

    worker = new Worker(new URL('../reader-main.ts', import.meta.url));
    const lifecycleEpoch = 'reader-corrupt-v8-test';
    expect((await exchange(worker, {
      type: 'open', requestId: 1, lifecycleEpoch, dbPath,
    })).type).toBe('opened');
    expect((await exchange(worker, {
      type: 'search-start',
      requestId: 2,
      lifecycleEpoch,
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'needle', normalized: 'needle', match: 'exact' }],
        }],
      },
      limit: 20,
    })).type).toBe('search-input-ack');
    expect(await exchange(worker, {
      type: 'search-allowlist-chunk',
      requestId: 2,
      lifecycleEpoch,
      chunkIndex: 0,
      allowedChats: [{ chatId: 'owner', transcriptViewId: 'owner-view', throughOrdinal: 1 }],
      done: true,
    })).toMatchObject({ type: 'search-input-ack', ready: true });

    let grantId = 1;
    let corruption: ReaderEvent | null = null;
    let emittedResult = false;
    while (!corruption) {
      const event = await exchange(worker, {
        type: 'reader-step-grant',
        requestId: 2,
        lifecycleEpoch,
        grantId,
      });
      if (event.type === 'error') corruption = event;
      if (event.type === 'reader-step-complete' && event.result.kind === 'result-chunk') {
        emittedResult = true;
      }
      grantId += 1;
    }
    expect(emittedResult).toBe(false);
    expect(corruption).toEqual({
      type: 'error',
      requestId: 2,
      lifecycleEpoch,
      grantId: grantId - 1,
      code: 'SEARCH_INDEX_CORRUPT',
      retryable: true,
    });

    const closed = new Promise<void>((resolve) => worker!.addEventListener('close', () => resolve(), {
      once: true,
    }));
    expect((await exchange(worker, {
      type: 'reader-quiesce', requestId: 3, lifecycleEpoch,
    })).type).toBe('reader-quiesced');
    await closed;
    worker = null;
  } finally {
    worker?.terminate();
    tokenizer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reader Worker streams multi-frame TEMP allowlists and clears them on completion and error', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'garcon-reader-allowlist-v8-'));
  const tokenizer = SearchTokenizer.create();
  let worker: Worker | null = null;
  try {
    const dbPath = path.join(directory, 'search.sqlite');
    const opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    opened.db.close();
    worker = new Worker(new URL('../reader-main.ts', import.meta.url));
    const lifecycleEpoch = 'reader-allowlist-v8-test';
    expect((await exchange(worker, {
      type: 'open', requestId: 1, lifecycleEpoch, dbPath,
    })).type).toBe('opened');

    expect((await exchange(worker, {
      type: 'search-start',
      requestId: 2,
      lifecycleEpoch,
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'needle', normalized: 'needle', match: 'exact' }],
        }],
      },
      limit: 20,
    })).type).toBe('search-input-ack');
    const allowedChats = Array.from({ length: SEARCH_READER_MAX_ALLOWLIST_ROWS + 1 }, (_, index) => ({
      chatId: `chat-${index.toString().padStart(4, '0')}`,
      transcriptViewId: `view-${index.toString().padStart(4, '0')}`,
      throughOrdinal: 1,
    }));
    expect(await exchange(worker, {
      type: 'search-allowlist-chunk',
      requestId: 2,
      lifecycleEpoch,
      chunkIndex: 0,
      allowedChats: allowedChats.slice(0, SEARCH_READER_MAX_ALLOWLIST_ROWS),
      done: false,
    })).toMatchObject({ type: 'search-input-ack', chunkIndex: 0, ready: false });
    expect(await exchange(worker, {
      type: 'search-allowlist-chunk',
      requestId: 2,
      lifecycleEpoch,
      chunkIndex: 1,
      allowedChats: allowedChats.slice(SEARCH_READER_MAX_ALLOWLIST_ROWS),
      done: true,
    })).toMatchObject({ type: 'search-input-ack', chunkIndex: 1, ready: true });
    const final = await finishSearch(worker, 2, lifecycleEpoch);
    expect(final.result).toMatchObject({
      kind: 'result-chunk',
      results: [],
      done: true,
      index: {
        indexedChatCount: 0,
        pendingChatCount: SEARCH_READER_MAX_ALLOWLIST_ROWS + 1,
        failedChatCount: 0,
        unsupportedChatCount: 0,
      },
    });

    expect((await exchange(worker, {
      type: 'search-start',
      requestId: 3,
      lifecycleEpoch,
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'needle', normalized: 'needle', match: 'exact' }],
        }],
      },
      limit: 20,
    })).type).toBe('search-input-ack');
    expect(await exchange(worker, {
      type: 'search-allowlist-chunk',
      requestId: 3,
      lifecycleEpoch,
      chunkIndex: 0,
      allowedChats: [
        { chatId: 'duplicate', transcriptViewId: 'view', throughOrdinal: 1 },
        { chatId: 'duplicate', transcriptViewId: 'other-view', throughOrdinal: 1 },
      ],
      done: true,
    })).toEqual({
      type: 'error',
      requestId: 3,
      lifecycleEpoch,
      grantId: null,
      code: 'INVALID_SEARCH_REQUEST',
      retryable: false,
    });

    expect((await exchange(worker, {
      type: 'search-start',
      requestId: 4,
      lifecycleEpoch,
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'needle', normalized: 'needle', match: 'exact' }],
        }],
      },
      limit: 20,
    })).type).toBe('search-input-ack');
    expect(await exchange(worker, {
      type: 'search-allowlist-chunk',
      requestId: 4,
      lifecycleEpoch,
      chunkIndex: 0,
      allowedChats: [],
      done: true,
    })).toMatchObject({ type: 'search-input-ack', ready: true });
    expect((await finishSearch(worker, 4, lifecycleEpoch)).result).toMatchObject({
      kind: 'result-chunk', results: [], done: true,
    });

    const closed = new Promise<void>((resolve) => worker!.addEventListener('close', () => resolve(), {
      once: true,
    }));
    expect((await exchange(worker, {
      type: 'reader-quiesce', requestId: 5, lifecycleEpoch,
    })).type).toBe('reader-quiesced');
    await closed;
    worker = null;
  } finally {
    worker?.terminate();
    tokenizer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
