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
  const execution = {
    start: mock(async () => ({
      agentSessionId: 'started-session',
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'started-session' } },
      nativeSeedReceipt: null,
    })),
    resume: mock(async () => undefined),
    abort: mock(async () => true),
    runningSessions: mock(() => []),
  };
  const integration = {
    descriptor: {
      id: 'test',
      supportedEndpointProtocols: [],
      supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'],
    },
    settings: { parse: (value) => value },
    execution,
    transcript: {
      load: mock(async () => ({
        messages,
        revision: computeAgentTranscriptRevision(messages),
      })),
    },
    forking: { fork, discard: mock(async () => undefined) },
  };
  const projection = {
    open: mock(async () => ({
      kind: 'ready',
      value: {
        entries: messages.map((message, index) => ({ id: `entry-${index + 1}`, message })),
      },
    })),
  };
  const entries = new Map([['source-chat', entry]]);
  const registry = {
    getChat: mock((chatId) => entries.get(chatId) ?? null),
    updateChat: mock(async (chatId, patch) => {
      const current = entries.get(chatId);
      if (!current) return null;
      const updated = { ...current, ...patch };
      entries.set(chatId, updated);
      return updated;
    }),
  };
  const router = new AgentRuntimeRouter({
    registry,
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
    projection,
    getCarryOverRevision: () => 'carry-1',
    loadCarriedContext: async () => null,
    getCarryOverMessageCount: async () => 0,
  });
  return { router, entry, entries, execution, messages, integration, projection };
}

describe('AgentRuntimeRouter forks', () => {
  it('binds a point fork to the selected native prefix', async () => {
    const fork = mock(async () => ({
      kind: 'materialized',
      session: {
        agentSessionId: 'forked-session',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'forked-session' } },
      },
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
        archivedMessageCount: 0,
        sourceRevision: {
          nativePrefix: computeAgentTranscriptRevisions(messages, 1).prefix,
          carryOver: 'carry-1',
        },
      },
    }));
  });

  it('preserves a successful unmaterialized whole-session outcome', async () => {
    const fork = mock(async () => ({ kind: 'unmaterialized' }));
    const { router, entry, entries, execution } = makeRouter(fork);

    const outcome = await router.forkAgentSession({
      sourceSession: entry,
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
    });
    expect(outcome).toEqual({ kind: 'unmaterialized' });

    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ point: null }));

    entries.set('target-chat', {
      ...entry,
      id: 'target-chat',
      agentSessionId: null,
      nativeSession: null,
    });
    await router.runAgentTurn('target-chat', 'child prompt');

    expect(execution.start).toHaveBeenCalledOnce();
    expect(execution.start).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'target-chat', prompt: 'child prompt' }),
    );
    expect(execution.resume).not.toHaveBeenCalled();
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

  it('maps an unavailable point to a structured validation error', async () => {
    const fork = mock(async () => null);
    const { router, entry } = makeRouter(fork);

    await expect(router.forkAgentSession({
      sourceSession: entry,
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      messageSequence: 3,
    })).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      status: 422,
      retryable: false,
    });
    expect(fork).not.toHaveBeenCalled();
  });

  it('maps transcript-load failures before provider fork dispatch', async () => {
    const fork = mock(async () => null);
    const { router, entry, projection } = makeRouter(fork);
    projection.open.mockRejectedValue(new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'Source transcript is missing',
      false,
    ));

    await expect(router.forkAgentSession({
      sourceSession: entry,
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      messageSequence: 1,
    })).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      message: 'Chat transcript is unavailable.',
      status: 422,
      retryable: false,
    });
  });
});
