import { describe, expect, it, mock } from 'bun:test';
import { UserMessage } from '../../../common/chat-types.js';
import {
  AgentIntegrationError,
  computeAgentTranscriptRevision,
  computeAgentTranscriptRevisions,
} from '@garcon/server-agent-interface';
import { AgentRuntimeRouter } from '../runtime-router.ts';

function makeRouter(fork) {
  const settings = { ownerId: 'test', schemaVersion: 1, values: {} };
  const entry = {
    id: 'source-chat',
    agentId: 'test',
    agentSessionId: 'session-1',
    nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'session-1' } },
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: { test: settings },
    projectPath: '/repo',
    model: 'model-a',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'default',
    thinkingMode: 'none',
    tags: [],
  };
  const messages = [
    new UserMessage('2026-07-21T00:00:00.000Z', 'first'),
    new UserMessage('2026-07-21T00:00:01.000Z', 'second'),
  ];
  const integration = {
    descriptor: {
      id: 'test',
      supportedEndpointProtocols: [],
      supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'],
    },
    settings: { parse: (value) => value },
    transcript: {
      load: mock(async () => ({
        messages,
        revision: computeAgentTranscriptRevision(messages),
      })),
    },
    forking: { fork },
  };
  const router = new AgentRuntimeRouter({
    registry: { getChat: mock(() => entry) },
    directory: { require: mock(() => integration) },
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
    events: {},
    getCarryOverRevision: () => 'carry-1',
    loadCarryOver: () => [],
  });
  return { router, entry, messages };
}

describe('AgentRuntimeRouter forks', () => {
  it('binds a point fork to the selected native prefix', async () => {
    const fork = mock(async () => ({
      agentSessionId: 'forked-session',
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'forked-session' } },
    }));
    const { router, entry, messages } = makeRouter(fork);

    await router.forkAgentSession({
      sourceSession: entry,
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      messageSequence: 1,
    });

    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      point: {
        messageSequence: 1,
        sourceRevision: {
          nativePrefix: computeAgentTranscriptRevisions(messages, 1).prefix,
          carryOver: 'carry-1',
        },
      },
    }));
  });

  it('maps a changed selected prefix to a retryable conflict', async () => {
    const fork = mock(async () => {
      throw new AgentIntegrationError(
        'SOURCE_REVISION_CHANGED',
        'Source transcript changed while the fork was being created',
        true,
      );
    });
    const { router, entry } = makeRouter(fork);

    await expect(router.forkAgentSession({
      sourceSession: entry,
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      messageSequence: 1,
    })).rejects.toMatchObject({
      code: 'SOURCE_REVISION_CHANGED',
      status: 409,
      retryable: true,
    });
  });
});
