import { expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BashToolUseMessage } from '../../../common/chat-types.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { TranscriptLedgerStore } from '../../ledger/store.ts';
import { AgentRuntimeRouter } from '../runtime-router.ts';

const AT = '2026-08-16T00:00:00.000Z';
const OCCURRENCE_ID = '11111111-1111-4111-8111-111111111111';

it('[TLV5-PERM.10-CORE-UNIT-01] retries the exact live capability after a provider response failure', async () => {
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
    if (responseAttempts === 1) throw new Error('provider response failed');
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
      decision: { permissionOccurrenceId: OCCURRENCE_ID, respond },
    });
    const router = makeRouter(ledger, view);
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

function makeRouter(ledger, view) {
  return new AgentRuntimeRouter({
    registry: { getChat: mock(() => ({ agentId: 'test' })) },
    directory: {
      get: mock((agentId) => agentId === 'test' ? { descriptor: { id: 'test' } } : null),
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
