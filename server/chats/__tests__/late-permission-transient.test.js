import { expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BashToolUseMessage } from '../../../common/chat-types.ts';
import { transcriptViewId } from '../../ledger/contracts.ts';
import { PermissionNotActionableError } from '../../ledger/errors.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { TranscriptLedgerStore } from '../../ledger/store.ts';
import {
  ChatTransientFeedStore,
  TransientControlActionError,
} from '../chat-transient-feed.ts';

const AT = '2026-08-16T00:00:00.000Z';
const CHAT_ID = 'chat-1';
const RUN_ID = 'run-1';
const OCCURRENCE_ID = '11111111-1111-4111-8111-111111111111';

it('[TLV5-PERM.11-CORE-TRANSIENT-01] keeps a late permission fact durable but inert after its run ends', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-late-permission-'));
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => transcriptViewId('view-1'),
    now: () => AT,
  });
  const ledger = new TranscriptLedgerService(store, {
    now: () => AT,
    serverInstanceId: 'server-1',
  });
  const transientFeed = new ChatTransientFeedStore('server-1');
  const commitEvents = [];
  const unsubscribe = ledger.subscribe((event) => {
    commitEvents.push(event);
    transientFeed.apply(event);
  });
  const respond = mock(async () => undefined);
  const control = {
    serverInstanceId: 'server-1',
    chatId: CHAT_ID,
    runId: RUN_ID,
    permissionOccurrenceId: OCCURRENCE_ID,
  };

  try {
    ledger.initializeChat(CHAT_ID);
    const producer = ledger.openProducer(CHAT_ID, 'test');
    ledger.beginRun(CHAT_ID, RUN_ID);
    producer.sink.publish({ type: 'run-ended', runId: RUN_ID, outcome: 'finished' });
    producer.sink.publish({
      type: 'permission',
      runId: RUN_ID,
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId: OCCURRENCE_ID,
        requestedTool: new BashToolUseMessage(AT, 'tool-1', 'pwd'),
        options: [],
      },
      decision: { permissionOccurrenceId: OCCURRENCE_ID, respond },
    });
    await flushCommitEvents();

    const durableRows = ledger.currentRows(CHAT_ID);
    expect(durableRows.map((row) => [row.ordinal, row.kind])).toEqual([
      [1, 'run-ended'],
      [2, 'permission-requested'],
    ]);
    expect(durableRows[0]).toMatchObject({ outcome: 'finished' });
    expect(durableRows[1]).toMatchObject({
      lifecycle: { kind: 'requested', permissionOccurrenceId: OCCURRENCE_ID },
    });
    expect(commitEvents.map((event) => [event.type, event.runId])).toEqual([
      ['run-ended', RUN_ID],
      ['permission', null],
    ]);
    expect(commitEvents[1]).toMatchObject({
      row: { lifecycle: { permissionOccurrenceId: OCCURRENCE_ID } },
    });
    expect(() => ledger.claimPermissionResolution(control)).toThrow(PermissionNotActionableError);
    expect(transientFeed.currentSnapshot(CHAT_ID)?.rows).toEqual([]);
    expect(() => transientFeed.validateAction(control)).toThrow(TransientControlActionError);
    expect(respond).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

function flushCommitEvents() {
  return new Promise((resolve) => queueMicrotask(resolve));
}
