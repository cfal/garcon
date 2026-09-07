import { describe, expect, it, mock } from 'bun:test';
import { AgentRuntimeRouter } from '../runtime-router.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

function makeRouter(hasPendingOwnershipTransfer) {
  const transcript = createRuntimeTranscriptFixture();
  const execution = {
    start: mock(async () => ({ agentSessionId: 'session-a', nativeSession: null })),
    resume: mock(async () => undefined),
    abort: mock(async () => true),
    runningSessions: mock(() => []),
  };
  const entry = {
    agentId: 'test',
    model: 'model-a',
    projectPath: '/workspace',
    agentSessionId: 'session-a',
    agentOwnershipEpoch: 'epoch-1',
  };
  const integration = {
    descriptor: {
      id: 'test',
      supportedEndpointProtocols: [],
      supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'],
    },
    settings: { parse: (value) => value ?? {}, defaults: () => ({}) },
    execution,
    forking: null,
  };
  const router = new AgentRuntimeRouter({
    registry: {
      getChat: mock(() => entry),
      updateChat: mock(async () => entry),
    },
    directory: {
      require: mock(() => integration),
      list: mock(() => [integration]),
    },
    endpointResolver: {
      resolveSelection: mock(() => ({
        model: 'model-a',
        apiProviderId: null,
        endpointId: null,
        protocol: null,
        isLocal: false,
      })),
      resolveEndpointReference: mock(() => null),
    },
    events: { trackTurn: mock(() => undefined), clearTurn: mock(() => undefined) },
    getCarryOverRevision: () => 'carry-1',
    createCarriedContext: async () => ({ kind: 'no-history' }),
    ledger: transcript.ledger,
    hasPendingOwnershipTransfer,
    adoption: transcript.adoption,
  });
  return { router, execution };
}

describe('AgentRuntimeRouter ownership fence', () => {
  it('[TLV5-HANDOFF.02-CORE-UNIT-01] refuses to publish while a decided handoff has not rolled forward', async () => {
    const { router, execution } = makeRouter(() => true);

    await expect(router.runAgentTurn('chat-1', 'hello', {
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    })).rejects.toMatchObject({ code: 'OWNERSHIP_TRANSFER_PENDING' });
    expect(execution.resume).not.toHaveBeenCalled();
  });

  it('[TLV5-HANDOFF.04-CORE-UNIT-01] resumes publishing once roll-forward discharges the decision', async () => {
    let pending = true;
    const { router, execution } = makeRouter(() => pending);

    await expect(router.runAgentTurn('chat-1', 'hello', {
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    })).rejects.toMatchObject({ code: 'OWNERSHIP_TRANSFER_PENDING' });

    pending = false;
    await router.runAgentTurn('chat-1', 'hello', {
      clientRequestId: 'request-2',
      clientMessageId: 'message-2',
      turnId: 'turn-2',
    });

    expect(execution.resume).toHaveBeenCalledTimes(1);
  });
});
