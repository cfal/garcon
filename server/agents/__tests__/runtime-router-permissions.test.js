import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BashToolUseMessage } from '../../../common/chat-types.ts';
import { PermissionNotActionableError } from '../../ledger/errors.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { TranscriptLedgerStore } from '../../ledger/store.ts';
import { AgentRuntimeRouter } from '../runtime-router.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

const AT = '2026-08-15T00:00:00.000Z';

function makeRouter(transcript = createRuntimeTranscriptFixture({
    rows: [{
      kind: 'permission-requested',
      lifecycle: {
        kind: 'requested',
        requestId: 'permission-1',
        incarnation: 'incarnation-1',
      },
    }],
  })) {
  return new AgentRuntimeRouter({
    registry: {
      getChat: mock(() => ({ agentId: 'test' })),
    },
    directory: {
      get: mock((agentId) => agentId === 'test' ? { descriptor: { id: 'test' } } : null),
    },
    endpointResolver: {},
    events: {},
    projection: {},
    getCarryOverRevision: () => 'carry-1',
createCarriedContext: async () => null,
    getCarryOverMessageCount: async () => 0,
    ledger: transcript.ledger,
    hasPendingOwnershipTransfer: () => false,
    adoption: transcript.adoption,
  });
}

describe('AgentRuntimeRouter permission replies', () => {
  it('invokes the exact permission capability with its receiver', async () => {
    const resolvePermission = mock(async () => undefined);
    const decisionCapability = {
      requestId: 'permission-1',
      incarnation: 'incarnation-1',
      runtime: { resolvePermission },
      async respond(decision) {
        await this.runtime.resolvePermission(decision);
      },
    };
    const transcript = createRuntimeTranscriptFixture({
      permissionDecision: decisionCapability,
    });
    const router = makeRouter(transcript);
    const decision = { allow: true };

    await router.resolvePermission('chat-1', 'permission-1', decision, permissionControl());

    expect(resolvePermission).toHaveBeenCalledWith(decision);
  });

  it('releases the actionability claim when the provider rejects the decision', async () => {
    const respondToPermission = mock(async () => {
      throw new Error('provider rejected permission');
    });
    const abandoned = mock(() => undefined);
    const transcript = createRuntimeTranscriptFixture({
      onPermissionAbandoned: abandoned,
      permissionDecision: {
        requestId: 'permission-1',
        incarnation: 'incarnation-1',
        respond: respondToPermission,
      },
    });
    const router = makeRouter(transcript);

    await expect(router.resolvePermission(
      'chat-1',
      'permission-1',
      { allow: false },
      permissionControl(),
    )).rejects.toThrow('provider rejected permission');
    expect(abandoned).toHaveBeenCalledTimes(1);
  });

  it('responds through the exact claimed permission occurrence capability', async () => {
    const firstRespond = mock(async () => undefined);
    const secondRespond = mock(async () => undefined);
    const transcript = createRuntimeTranscriptFixture();
    const claims = new Map([
      ['incarnation-1', permissionClaim('incarnation-1', firstRespond)],
      ['incarnation-2', permissionClaim('incarnation-2', secondRespond)],
    ]);
    transcript.ledger.claimPermissionResolution = mock((control) => {
      const claim = claims.get(control.incarnation);
      if (!claim) throw new Error('Permission occurrence is not actionable');
      return claim;
    });
    const router = makeRouter(transcript);
    const firstDecision = { allow: true };
    const secondDecision = { allow: false };

    await router.resolvePermission(
      'chat-1',
      'permission-1',
      firstDecision,
      permissionControl({ incarnation: 'incarnation-1' }),
    );
    await router.resolvePermission(
      'chat-1',
      'permission-1',
      secondDecision,
      permissionControl({ incarnation: 'incarnation-2' }),
    );

    expect(firstRespond).toHaveBeenCalledWith(firstDecision);
    expect(secondRespond).toHaveBeenCalledWith(secondDecision);
  });

  it('rejects a mismatched permission incarnation before provider code executes', async () => {
    const exactRespond = mock(async () => undefined);
    const transcript = createRuntimeTranscriptFixture();
    const activeClaim = permissionClaim('incarnation-1', exactRespond);
    transcript.ledger.claimPermissionResolution = mock((control) => {
      if (control.incarnation === activeClaim.incarnation) return activeClaim;
      throw new Error('Permission occurrence is not actionable');
    });
    const router = makeRouter(transcript);

    await expect(router.resolvePermission(
      'chat-1',
      'permission-1',
      { allow: true },
      permissionControl({ incarnation: 'wrong-incarnation' }),
    )).rejects.toThrow('Permission occurrence is not actionable');

    expect(exactRespond).not.toHaveBeenCalled();
  });

  it('[TLV5-PERM.05-CORE-UNIT-02] routes a response only to the occurrence left live by a delayed terminal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-permission-delayed-terminal-'));
    const store = new TranscriptLedgerStore(root, {
      createViewId: () => 'view-1',
      now: () => AT,
    });
    const ledger = new TranscriptLedgerService(store, {
      now: () => AT,
      serverInstanceId: 'server-1',
    });
    const legacyRequestId = 'legacy-public-id';
    const firstOccurrence = '11111111-1111-4111-8111-111111111111';
    const secondOccurrence = '22222222-2222-4222-8222-222222222222';
    const firstRespond = mock(async () => undefined);
    const secondRespond = mock(async () => undefined);
    try {
      const view = ledger.initializeChat('chat-1');
      const producer = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      for (const [incarnation, command, respond] of [
        [firstOccurrence, 'first', firstRespond],
        [secondOccurrence, 'second', secondRespond],
      ]) {
        producer.sink.publish({
          type: 'permission',
          runId: 'run-1',
          lifecycle: {
            kind: 'requested',
            requestId: legacyRequestId,
            incarnation,
            requestedTool: new BashToolUseMessage(AT, `tool-${command}`, command),
            options: [],
          },
          decision: { requestId: legacyRequestId, incarnation, respond },
        });
      }
      producer.sink.publish({
        type: 'permission',
        runId: 'run-1',
        lifecycle: {
          kind: 'cancelled',
          requestId: legacyRequestId,
          incarnation: firstOccurrence,
          reason: 'delayed terminal',
        },
      });
      const router = makeRouter({ ledger, adoption: { ensure: async () => view } });
      const decision = { allow: true };

      await router.resolvePermission(
        'chat-1',
        legacyRequestId,
        decision,
        permissionControl({ id: legacyRequestId, incarnation: secondOccurrence }),
      );

      expect(firstRespond).not.toHaveBeenCalled();
      expect(secondRespond).toHaveBeenCalledTimes(1);
      expect(secondRespond).toHaveBeenCalledWith(decision);
      expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
        'permission-requested',
        'permission-requested',
        'permission-cancelled',
        'permission-resolved',
      ]);
    } finally {
      ledger.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not resolve a permission whose run ends while the provider response is pending', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-permission-response-race-'));
    const store = new TranscriptLedgerStore(root, {
      createViewId: () => 'view-1',
      now: () => AT,
    });
    const ledger = new TranscriptLedgerService(store, {
      now: () => AT,
      serverInstanceId: 'server-1',
    });
    const responseStarted = deferred();
    const releaseResponse = deferred();
    const respond = mock(async () => {
      responseStarted.resolve();
      await releaseResponse.promise;
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
          requestId: 'permission-1',
          incarnation: 'incarnation-1',
          requestedTool: new BashToolUseMessage(AT, 'tool-1', 'pwd'),
          options: [],
        },
        decision: {
          requestId: 'permission-1',
          incarnation: 'incarnation-1',
          respond,
        },
      });
      const router = makeRouter({
        ledger,
        adoption: { ensure: async () => view },
      });

      const resolution = router.resolvePermission(
        'chat-1',
        'permission-1',
        { allow: true },
        permissionControl(),
      );
      await responseStarted.promise;
      expect(ledger.interruptRun('chat-1')).toMatchObject({ outcome: 'interrupted' });
      releaseResponse.resolve();

      await expect(resolution).rejects.toBeInstanceOf(PermissionNotActionableError);
      expect(respond).toHaveBeenCalledTimes(1);
      expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
        'permission-requested',
        'run-ended',
      ]);
    } finally {
      ledger.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function permissionControl(overrides = {}) {
  return {
    serverInstanceId: 'server-1',
    chatId: 'chat-1',
    runId: 'run-1',
    id: 'permission-1',
    incarnation: 'incarnation-1',
    ...overrides,
  };
}

function permissionClaim(incarnation, respond) {
  return {
    chatId: 'chat-1',
    viewId: 'view-1',
    runId: 'run-1',
    requestId: 'permission-1',
    incarnation,
    claimId: `claim-${incarnation}`,
    decision: {
      requestId: 'permission-1',
      incarnation,
      respond,
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}
