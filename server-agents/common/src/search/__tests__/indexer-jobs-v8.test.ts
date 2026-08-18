import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleIndexerRequest } from '../indexer-jobs.js';
import type { IndexerEvent, IndexerRequest } from '../worker-protocol.js';

describe('transcript search v8 indexer grants', () => {
  it('observes known errors and clears the active grant after a local start-post failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'transcript-search-indexer-v8-'));
    const originalPostMessage = self.postMessage;
    const originalExit = process.exit;
    const events: IndexerEvent[] = [];
    let failNextStart = false;
    self.postMessage = ((message: unknown) => {
      if (failNextStart && (message as { type?: unknown }).type === 'step-started') {
        failNextStart = false;
        throw new Error('synthetic local post failure');
      }
      events.push(message as IndexerEvent);
    }) as typeof self.postMessage;
    process.exit = (() => undefined) as never;
    const lifecycleEpoch = 'synthetic-indexer-lifecycle';
    const send = (request: IndexerRequest) => handleIndexerRequest(request);
    try {
      await send({
        type: 'open',
        requestId: 1,
        lifecycleEpoch,
        dbPath: path.join(root, 'index.sqlite'),
        walEpoch: 1,
      });
      expect(events.at(-1)).toMatchObject({
        type: 'opened',
        wal: { walEpoch: 1, walObservationSequence: 1 },
      });

      failNextStart = true;
      await send({
        type: 'physical-step-grant',
        requestId: 2,
        lifecycleEpoch,
        grantId: 1,
        walEpoch: 1,
        step: {
          kind: 'plan-append',
          chatId: 'missing-chat',
          transcriptViewId: 'missing-view',
          expectedAfterOrdinal: 0,
          targetThrough: 1,
        },
      });
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        grantId: 1,
        code: 'INDEXER_INTERNAL',
        retryable: true,
      });
      expect(events.at(-1)).not.toHaveProperty('wal');

      await send({
        type: 'physical-step-grant',
        requestId: 3,
        lifecycleEpoch,
        grantId: 2,
        walEpoch: 1,
        step: {
          kind: 'plan-append',
          chatId: 'missing-chat',
          transcriptViewId: 'missing-view',
          expectedAfterOrdinal: 0,
          targetThrough: 1,
        },
      });
      expect(events.at(-2)).toMatchObject({ type: 'step-started', grantId: 2 });
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        grantId: 2,
        code: 'SEARCH_VIEW_MISMATCH',
        retryable: false,
        wal: { walEpoch: 1, walObservationSequence: 2 },
      });

      await send({ type: 'indexer-quiesce', requestId: 4, lifecycleEpoch });
      expect(events.at(-1)).toMatchObject({ type: 'indexer-quiesced', requestId: 4 });
    } finally {
      self.postMessage = originalPostMessage;
      process.exit = originalExit;
      await rm(root, { recursive: true, force: true });
    }
  });
});
