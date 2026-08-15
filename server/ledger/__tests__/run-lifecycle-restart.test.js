import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { UserMessage } from '../../../common/chat-types.ts';
import { transcriptViewId } from '../contracts.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';

const CHAT_ID = 'chat-1';
const RUN_ID = 'run-1';
const TS = '2026-08-15T00:00:00.000Z';

describe('transcript run lifecycle across restart', () => {
  it('does not synthesize a run-ended row for a run lost with the process', async () => {
    await withLedgerRoot(async (root) => {
      const first = createLedger(root);
      const view = first.ledger.initializeChat(CHAT_ID);
      first.ledger.openProducer(CHAT_ID, 'test');
      first.ledger.appendInputAndCompose({
        chatId: CHAT_ID,
        viewId: view.viewId,
        message: new UserMessage(TS, 'accepted before crash'),
        attachments: [],
        clientMessageId: 'message-1',
        steer: false,
      });
      first.ledger.beginRun(CHAT_ID, RUN_ID);
      expect(first.ledger.activeRunId(CHAT_ID)).toBe(RUN_ID);

      first.store.close();

      const restarted = createLedger(root);
      try {
        expect(restarted.ledger.activeRunId(CHAT_ID)).toBeNull();
        expect(restarted.ledger.currentRows(CHAT_ID).map((row) => row.kind)).toEqual([
          'user-input',
        ]);
        expect(restarted.ledger.resendCandidates(CHAT_ID)).toEqual([{
          ordinal: 1,
          content: 'accepted before crash',
          attachmentNames: [],
        }]);
      } finally {
        restarted.ledger.close();
      }
    });
  });

  it('restores a failed run detail exactly without restoring an active run', async () => {
    await withLedgerRoot(async (root) => {
      const failure = {
        code: 'PROVIDER_FAILURE',
        message: 'provider failed: \u{1F642}\nsecond line',
      };
      const first = createLedger(root);
      first.ledger.initializeChat(CHAT_ID);
      const lease = first.ledger.openProducer(CHAT_ID, 'test');
      first.ledger.beginRun(CHAT_ID, RUN_ID);
      lease.sink.publish({
        type: 'run-ended',
        runId: RUN_ID,
        outcome: 'failed',
        error: failure,
      });
      first.ledger.close();

      const restarted = createLedger(root);
      try {
        expect(restarted.ledger.activeRunId(CHAT_ID)).toBeNull();
        expect(restarted.ledger.currentRows(CHAT_ID)).toEqual([{
          viewId: transcriptViewId('view-1'),
          ordinal: 1,
          kind: 'run-ended',
          at: TS,
          outcome: 'failed',
          origin: 'provider',
          error: failure,
          providerMeta: null,
        }]);
      } finally {
        restarted.ledger.close();
      }
    });
  });
});

async function withLedgerRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-run-lifecycle-restart-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createLedger(root) {
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => transcriptViewId('view-1'),
    now: () => TS,
  });
  const ledger = new TranscriptLedgerService(store, {
    now: () => TS,
    serverInstanceId: 'server-1',
  });
  return { ledger, store };
}
