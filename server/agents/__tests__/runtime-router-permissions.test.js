import { describe, expect, it, mock } from 'bun:test';

import { AgentRuntimeRouter } from '../runtime-router.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

function makeRouter(permissionDecisions, transcript = createRuntimeTranscriptFixture({
    rows: [{
      kind: 'permission-requested',
      lifecycle: {
        kind: 'requested',
        requestId: 'permission-1',
        incarnation: 'incarnation-1',
      },
    }],
  })) {
  const integration = {
    descriptor: { id: 'test' },
    permissionDecisions,
  };
  return new AgentRuntimeRouter({
    registry: {
      getChat: mock(() => ({ agentId: 'test' })),
    },
    directory: {
      get: mock((agentId) => agentId === 'test' ? integration : null),
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
  it('invokes the integration permission handler with its execution receiver', async () => {
    const resolvePermission = mock(async () => undefined);
    const permissionDecisions = {
      runtime: { resolvePermission },
      async respond(permissionRequestId, decision) {
        await this.runtime.resolvePermission(permissionRequestId, decision);
      },
    };
    const router = makeRouter(permissionDecisions);
    const decision = { allow: true };

    await router.resolvePermission('chat-1', 'permission-1', decision, permissionControl());

    expect(resolvePermission).toHaveBeenCalledWith('permission-1', decision);
  });

  it('releases the actionability claim when the provider rejects the decision', async () => {
    const respondToPermission = mock(async () => {
      throw new Error('provider rejected permission');
    });
    const abandoned = mock(() => undefined);
    const transcript = createRuntimeTranscriptFixture({ onPermissionAbandoned: abandoned });
    const router = new AgentRuntimeRouter({
      registry: { getChat: mock(() => ({ agentId: 'test' })) },
      directory: {
        get: mock(() => ({
          descriptor: { id: 'test' },
          permissionDecisions: { respond: respondToPermission },
        })),
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

    await expect(router.resolvePermission(
      'chat-1',
      'permission-1',
      { allow: false },
      permissionControl(),
    )).rejects.toThrow('provider rejected permission');
    expect(abandoned).toHaveBeenCalledTimes(1);
  });

  it('responds through the exact claimed permission occurrence capability', async () => {
    const legacyRespond = mock(async () => undefined);
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
    const router = makeRouter({ respond: legacyRespond }, transcript);
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
    expect(legacyRespond).not.toHaveBeenCalled();
  });

  it('rejects a mismatched permission incarnation before provider code executes', async () => {
    const legacyRespond = mock(async () => undefined);
    const exactRespond = mock(async () => undefined);
    const transcript = createRuntimeTranscriptFixture();
    const activeClaim = permissionClaim('incarnation-1', exactRespond);
    transcript.ledger.claimPermissionResolution = mock((control) => {
      if (control.incarnation === activeClaim.incarnation) return activeClaim;
      throw new Error('Permission occurrence is not actionable');
    });
    const router = makeRouter({ respond: legacyRespond }, transcript);

    await expect(router.resolvePermission(
      'chat-1',
      'permission-1',
      { allow: true },
      permissionControl({ incarnation: 'wrong-incarnation' }),
    )).rejects.toThrow('Permission occurrence is not actionable');

    expect(exactRespond).not.toHaveBeenCalled();
    expect(legacyRespond).not.toHaveBeenCalled();
  });
});

function permissionControl(overrides = {}) {
  return {
    serverInstanceId: 'server-1',
    chatId: 'chat-1',
    agentOwnershipEpoch: 'ownership-1',
    turnOwner: {
      agentOwnershipEpoch: 'ownership-1',
      commandType: 'agent-run',
      clientRequestId: 'run-1',
      turnId: 'run-1',
    },
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
