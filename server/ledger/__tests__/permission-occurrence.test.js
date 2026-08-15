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

  it('drops old occurrence capabilities when the producer sink is replaced', async () => {
    await withLedger((ledger) => {
      const first = startRun(ledger);
      const firstDecision = permissionDecision('incarnation-1');
      publishRequest(first.sink, 'incarnation-1', firstDecision);

      ledger.closeProducer(CHAT_ID);
      const second = ledger.openProducer(CHAT_ID, 'test');
      ledger.beginRun(CHAT_ID, 'run-2');
      const secondDecision = permissionDecision('incarnation-2');
      publishRequest(second.sink, 'incarnation-2', secondDecision, 'run-2');

      expect(() => ledger.claimPermissionResolution(
        permissionControl('incarnation-1', RUN_ID),
      )).toThrow(PermissionNotActionableError);
      expect(ledger.claimPermissionResolution(
        permissionControl('incarnation-2', 'run-2'),
      ).decision).toBe(secondDecision);
      expect(() => first.sink.publish({ type: 'rows', rows: [] }))
        .toThrow('Transcript producer sink is closed');
    });
  });

  it('invalidates an in-flight permission claim when its run ends', async () => {
    await withLedger((ledger) => {
      const lease = startRun(ledger);
      publishRequest(
        lease.sink,
        'incarnation-1',
        permissionDecision('incarnation-1'),
      );
      const claim = ledger.claimPermissionResolution(permissionControl('incarnation-1'));

      lease.sink.publish({
        type: 'run-ended',
        runId: RUN_ID,
        outcome: 'finished',
      });

      expect(() => ledger.completePermissionResolution(claim, { allow: true }))
        .toThrow(PermissionNotActionableError);
      expect(ledger.currentRows(CHAT_ID).map((row) => row.kind)).toEqual([
        'permission-requested',
        'run-ended',
      ]);
    });
  });

  it('invalidates an in-flight permission claim when its occurrence is cancelled', async () => {
    await withLedger((ledger) => {
      const lease = startRun(ledger);
      publishRequest(
        lease.sink,
        'incarnation-1',
        permissionDecision('incarnation-1'),
      );
      const claim = ledger.claimPermissionResolution(permissionControl('incarnation-1'));

      lease.sink.publish({
        type: 'permission',
        runId: RUN_ID,
        lifecycle: {
          kind: 'cancelled',
          requestId: REQUEST_ID,
          incarnation: 'incarnation-1',
          reason: 'provider cancelled',
        },
      });

      expect(() => ledger.completePermissionResolution(claim, { allow: true }))
        .toThrow(PermissionNotActionableError);
      expect(ledger.currentRows(CHAT_ID).map((row) => row.kind)).toEqual([
        'permission-requested',
        'permission-cancelled',
      ]);
    });
  });

  it('retires only the exact claimed occurrence when a request id is reused', async () => {
    await withLedger((ledger) => {
      const lease = startRun(ledger);
      publishRequest(
        lease.sink,
        'incarnation-1',
        permissionDecision('incarnation-1'),
      );
      publishRequest(
        lease.sink,
        'incarnation-2',
        permissionDecision('incarnation-2'),
      );
      const first = ledger.claimPermissionResolution(permissionControl('incarnation-1'));
      const second = ledger.claimPermissionResolution(permissionControl('incarnation-2'));

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

      expect(() => ledger.completePermissionResolution(first, { allow: true }))
        .toThrow(PermissionNotActionableError);
      expect(ledger.completePermissionResolution(second, { allow: false })).toMatchObject({
        kind: 'permission-resolved',
        lifecycle: {
          requestId: REQUEST_ID,
          incarnation: 'incarnation-2',
          decision: { allow: false },
        },
      });
    });
  });

  it('invalidates an in-flight permission claim when control moves to another run', async () => {
    await withLedger((ledger) => {
      const lease = startRun(ledger);
      publishRequest(
        lease.sink,
        'incarnation-1',
        permissionDecision('incarnation-1'),
      );
      const claim = ledger.claimPermissionResolution(permissionControl('incarnation-1'));

      ledger.handoffRun(CHAT_ID, RUN_ID, 'run-2');

      expect(() => ledger.completePermissionResolution(claim, { allow: true }))
        .toThrow(PermissionNotActionableError);
      expect(ledger.currentRows(CHAT_ID).map((row) => row.kind)).toEqual([
        'permission-requested',
      ]);
    });
  });

  it('keeps permission history but restores no actionability after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-permission-restart-'));
    try {
      const first = createLedger(root);
      const lease = startRun(first.ledger);
      publishRequest(lease.sink, 'incarnation-1', permissionDecision('incarnation-1'));
      first.ledger.close();

      const restarted = createLedger(root);
      try {
        expect(restarted.ledger.currentRows(CHAT_ID).map((row) => row.kind)).toEqual([
          'permission-requested',
        ]);
        expect(() => restarted.ledger.claimPermissionResolution(
          permissionControl('incarnation-1'),
        )).toThrow(PermissionNotActionableError);
      } finally {
        restarted.ledger.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function withLedger(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-permission-occurrence-'));
  const { ledger } = createLedger(root);
  try {
    await run(ledger);
  } finally {
    ledger.close();
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

function startRun(ledger) {
  ledger.initializeChat(CHAT_ID);
  const lease = ledger.openProducer(CHAT_ID, 'test');
  ledger.beginRun(CHAT_ID, RUN_ID);
  return lease;
}

function publishRequest(sink, incarnation, decision, runId = RUN_ID) {
  sink.publish({
    type: 'permission',
    runId,
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

function permissionControl(incarnation, runId = RUN_ID) {
  return {
    serverInstanceId: 'server-1',
    chatId: CHAT_ID,
    runId,
    id: REQUEST_ID,
    incarnation,
  };
}
