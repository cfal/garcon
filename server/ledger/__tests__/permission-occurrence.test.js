import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BashToolUseMessage } from '../../../common/chat-types.ts';
import { transcriptViewId } from '../contracts.ts';
import { PermissionNotActionableError } from '../errors.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';

const CHAT_ID = 'chat-1';
const RUN_ID = 'run-1';
const REQUEST_ID = 'permission-1';
const TS = '2026-08-15T00:00:00.000Z';

describe('transcript permission occurrences', () => {
  it('applies a delayed cancellation only to its exact reused occurrence', async () => {
    await withLedger((ledger) => {
      const lease = startRun(ledger);
      const firstDecision = permissionDecision('incarnation-1');
      const secondDecision = permissionDecision('incarnation-2');
      publishRequest(lease.sink, 'incarnation-1', firstDecision);
      publishRequest(lease.sink, 'incarnation-2', secondDecision);

      lease.sink.publish({
        type: 'permission',
        runId: RUN_ID,
        lifecycle: {
          kind: 'cancelled',
          requestId: REQUEST_ID,
          incarnation: 'incarnation-1',
          reason: null,
        },
      });

      expect(() => ledger.claimPermissionResolution(permissionControl('incarnation-1')))
        .toThrow(PermissionNotActionableError);
      const second = ledger.claimPermissionResolution(permissionControl('incarnation-2'));
      expect(second.decision).toBe(secondDecision);
      expect(ledger.currentRows(CHAT_ID).map((row) => row.kind)).toEqual([
        'permission-requested',
        'permission-requested',
        'permission-cancelled',
      ]);
    });
  });

  it('rejects a mismatched response capability before appending history', async () => {
    await withLedger((ledger) => {
      const lease = startRun(ledger);
      const lifecycle = permissionRequest('incarnation-1');

      for (const decision of [
        permissionDecision('incarnation-1', 'permission-2'),
        permissionDecision('incarnation-2'),
      ]) {
        expect(() => lease.sink.publish({
          type: 'permission',
          runId: RUN_ID,
          lifecycle,
          decision,
        })).toThrow('Permission response capability does not match its request occurrence');
      }

      expect(ledger.currentRows(CHAT_ID)).toEqual([]);
      expect(() => ledger.claimPermissionResolution(permissionControl('incarnation-1')))
        .toThrow(PermissionNotActionableError);
    });
  });
});

async function withLedger(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-permission-occurrence-'));
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => transcriptViewId('view-1'),
    now: () => TS,
  });
  const ledger = new TranscriptLedgerService(store, {
    now: () => TS,
    serverInstanceId: 'server-1',
  });
  try {
    await run(ledger);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

function startRun(ledger) {
  ledger.initializeChat(CHAT_ID);
  const lease = ledger.openProducer(CHAT_ID, 'test');
  ledger.beginRun(CHAT_ID, RUN_ID);
  return lease;
}

function publishRequest(sink, incarnation, decision) {
  sink.publish({
    type: 'permission',
    runId: RUN_ID,
    lifecycle: permissionRequest(incarnation),
    decision,
  });
}

function permissionRequest(incarnation) {
  return {
    kind: 'requested',
    requestId: REQUEST_ID,
    incarnation,
    requestedTool: new BashToolUseMessage(TS, `tool-${incarnation}`, 'pwd'),
    options: [],
  };
}

function permissionDecision(incarnation, requestId = REQUEST_ID) {
  return {
    requestId,
    incarnation,
    respond: async () => undefined,
  };
}

function permissionControl(incarnation) {
  return {
    serverInstanceId: 'server-1',
    chatId: CHAT_ID,
    runId: RUN_ID,
    id: REQUEST_ID,
    incarnation,
  };
}
