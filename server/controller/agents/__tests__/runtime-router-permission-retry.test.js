import { resolveFileMentionsInCommand } from "../../../runtime/projects/file-mentions.ts";
import { expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BashToolUseMessage } from '../../../../common/chat-types.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { TranscriptLedgerStore } from '../../ledger/store.ts';
import { PermissionNotActionableError } from '../../ledger/errors.ts';
import { ChatTransientFeedStore } from '../../chats/chat-transient-feed.ts';
import { AgentRuntimeRouter } from '../runtime-router.ts';
import { AgentCallError } from '@garcon/server-agent-interface';
import { permissionResponse, permissionFixture } from './producer-fixture.ts';

const AT = '2026-08-16T00:00:00.000Z';
const OCCURRENCE_ID = '11111111-1111-4111-8111-111111111111';

it('[TLV5-PERM.10-CORE-UNIT-01] retries the exact live capability only after definite non-dispatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-permission-retry-'));
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => 'view-1',
    now: () => AT,
  });
  const ledger = new TranscriptLedgerService(store, {
    now: () => AT,
    serverInstanceId: 'server-1',
  });
  let responseAttempts = 0;
  const respond = mock(async () => {
    responseAttempts += 1;
    if (responseAttempts === 1) throw new AgentCallError('not-dispatched', 'provider response failed');
  });

  try {
    const view = ledger.initializeChat('chat-1');
    const producer = ledger.openProducer('chat-1', 'test');
    ledger.beginRun('chat-1', 'run-1');
    producer.sink.publish({
      type: 'permission',
      runId: 'run-1',
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId: OCCURRENCE_ID,
        requestedTool: new BashToolUseMessage(AT, 'tool-1', 'pwd'),
        options: [],
      },
      decision: { permissionOccurrenceId: OCCURRENCE_ID, response: permissionResponse(OCCURRENCE_ID) },
    });
    const router = makeRouter(ledger, view, respond);
    const decision = { allow: true };

    await expect(router.resolvePermission(
      'chat-1',
      OCCURRENCE_ID,
      decision,
      permissionControl(),
    )).rejects.toThrow('provider response failed');
    expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
      'permission-requested',
    ]);

    await expect(router.resolvePermission(
      'chat-1',
      OCCURRENCE_ID,
      decision,
      permissionControl(),
    )).resolves.toBeUndefined();

    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls).toEqual([[decision], [decision]]);
    expect(ledger.currentRows('chat-1')).toEqual([
      expect.objectContaining({
        kind: 'permission-requested',
        lifecycle: expect.objectContaining({ permissionOccurrenceId: OCCURRENCE_ID }),
      }),
      expect.objectContaining({
        kind: 'permission-resolved',
        lifecycle: expect.objectContaining({
          permissionOccurrenceId: OCCURRENCE_ID,
          decision,
        }),
      }),
    ]);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of [
  new AgentCallError('rejected', 'Synthetic expired permission'),
  new AgentCallError('unknown', 'Synthetic uncertain response'),
  new Error('Synthetic interrupted response'),
]) {
  it(`retires the permission control without recording success after ${failure.message}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-permission-retire-'));
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(root), { serverInstanceId: 'server-1' });
    const feed = new ChatTransientFeedStore('server-1');
    ledger.subscribe(event => { feed.apply(event); });
    ledger.subscribePermissionRetired(control => { feed.retirePermission(control); });
    const respond = mock(async () => { throw failure; });
    try {
      const view = ledger.initializeChat('chat-1');
      const producer = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      producer.sink.publish({
        type: 'permission', runId: 'run-1',
        lifecycle: {
          kind: 'requested', permissionOccurrenceId: OCCURRENCE_ID,
          requestedTool: new BashToolUseMessage(AT, 'tool-1', 'pwd'), options: [],
        },
        decision: { permissionOccurrenceId: OCCURRENCE_ID, response: permissionResponse(OCCURRENCE_ID) },
      });
      await Promise.resolve();
      expect(feed.validateAction(permissionControl()).permissionOccurrenceId).toBe(OCCURRENCE_ID);
      const router = makeRouter(ledger, view, respond);
      await expect(router.resolvePermission('chat-1', OCCURRENCE_ID, { allow: true }, permissionControl()))
        .rejects.toBe(failure);
      await expect(router.resolvePermission('chat-1', OCCURRENCE_ID, { allow: true }, permissionControl()))
        .rejects.toBeInstanceOf(PermissionNotActionableError);
      expect(respond).toHaveBeenCalledTimes(1);
      expect(ledger.currentRows('chat-1').map(row => row.kind)).toEqual(['permission-requested']);
      expect(ledger.isRunActive('chat-1', 'run-1')).toBe(true);
      expect(feed.currentSnapshot('chat-1').rows).toEqual([]);
      producer.sink.publish({
        type: 'permission', runId: 'run-1',
        lifecycle: { kind: 'cancelled', permissionOccurrenceId: OCCURRENCE_ID, reason: null },
      });
      expect(ledger.currentRows('chat-1').map(row => row.kind)).toEqual(['permission-requested', 'permission-cancelled']);
    } finally {
      ledger.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

function makeRouter(ledger, view, respond) {
  return new AgentRuntimeRouter({
    resolveFileMentions: resolveFileMentionsInCommand,
    registry: { getChat: mock(() => ({ agentId: 'test' })) },
    directory: {
      get: mock((agentId) => agentId === 'test' ? { descriptor: { id: 'test' } } : null),
      require: () => ({ permissions: permissionFixture(new Map([[OCCURRENCE_ID, respond]])) }),
    },
    endpointResolver: {},
    events: {},
    projection: {},
    getCarryOverRevision: () => 'carry-1',
    createCarriedContext: async () => ({ kind: 'no-history' }),
    getCarryOverMessageCount: async () => 0,
    ledger,
    hasPendingOwnershipTransfer: () => false,
    adoption: { ensure: async () => view },
  });
}

function permissionControl() {
  return {
    serverInstanceId: 'server-1',
    chatId: 'chat-1',
    runId: 'run-1',
    permissionOccurrenceId: OCCURRENCE_ID,
  };
}
