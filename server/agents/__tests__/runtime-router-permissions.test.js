import { describe, expect, it, mock } from 'bun:test';

import { AgentRuntimeRouter } from '../runtime-router.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

function makeRouter(execution) {
  const transcript = createRuntimeTranscriptFixture({
    rows: [{
      kind: 'permission-requested',
      lifecycle: {
        kind: 'requested',
        requestId: 'permission-1',
        incarnation: 'incarnation-1',
      },
    }],
  });
  const integration = {
    descriptor: { id: 'test' },
    execution,
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
    loadCarriedContext: async () => null,
    getCarryOverMessageCount: async () => 0,
    ledger: transcript.ledger,
    adoption: transcript.adoption,
  });
}

describe('AgentRuntimeRouter permission replies', () => {
  it('invokes the integration permission handler with its execution receiver', async () => {
    const resolvePermission = mock(async () => undefined);
    const execution = {
      runtime: { resolvePermission },
      async respondToPermission(permissionRequestId, decision) {
        await this.runtime.resolvePermission(permissionRequestId, decision);
      },
    };
    const router = makeRouter(execution);
    const decision = { allow: true };

    await router.resolvePermission('chat-1', 'permission-1', decision);

    expect(resolvePermission).toHaveBeenCalledWith('permission-1', decision);
  });
});
