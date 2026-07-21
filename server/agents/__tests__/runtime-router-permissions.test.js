import { describe, expect, it, mock } from 'bun:test';

import { AgentRuntimeRouter } from '../runtime-router.ts';

function makeRouter(execution) {
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
    getCarryOverRevision: () => 'carry-1',
    loadCarryOver: () => [],
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

    router.resolvePermission('chat-1', 'permission-1', decision);
    await Promise.resolve();

    expect(resolvePermission).toHaveBeenCalledWith('permission-1', decision);
  });
});
