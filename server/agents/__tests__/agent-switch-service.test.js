import { describe, expect, it, mock } from 'bun:test';

import { AgentSwitchError, AgentSwitchService } from '../agent-switch-service.ts';
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';
import { UserMessage } from '../../../common/chat-types.js';

const envelope = (ownerId, values = {}) => ({ ownerId, schemaVersion: 1, values });

function integration(id, overrides = {}) {
  return {
    descriptor: {
      id,
      supportedPermissionModes: ['default', 'acceptEdits'],
      supportedThinkingModes: ['none', 'high'],
      ...overrides.descriptor,
    },
    execution: {
      isRunning: overrides.isRunning ?? mock(() => false),
    },
    transcript: {
      load: overrides.load ?? mock(async () => ({
        messages: [new UserMessage('2026-07-07T00:00:00.000Z', 'prior turn')],
        revision: 'native-1',
      })),
    },
    settings: {
      defaults: mock(() => envelope(id)),
      parse: mock((input) => input),
    },
  };
}

function makeService(overrides = {}) {
  const entry = {
    id: '1',
    agentId: 'source',
    agentSessionId: 'source-session',
    nativeSession: { ownerId: 'source', schemaVersion: 1, value: { path: '/tmp/source.jsonl' } },
    agentOwnershipEpoch: 'epoch-source',
    agentSettingsById: { source: envelope('source', { retained: true }) },
    projectPath: '/repo',
    model: 'source-model',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'acceptEdits',
    thinkingMode: 'high',
    tags: [],
    ...overrides.entry,
  };
  const source = integration('source', overrides.source);
  const target = integration('target', overrides.target);
  const registry = { getChat: mock(() => entry) };
  const directory = {
    get: mock((id) => id === 'source' ? source : id === 'target' ? target : null),
    require: mock((id) => {
      const found = id === 'source' ? source : id === 'target' ? target : null;
      if (!found) throw new Error(`Unknown integration: ${id}`);
      return found;
    }),
  };
  const endpointResolver = {
    resolveSelection: mock((request) => ({
      model: request.model,
      apiProviderId: request.apiProviderId ?? null,
      endpointId: request.modelEndpointId ?? null,
      protocol: null,
      isLocal: false,
      credentialRef: null,
      baseUrl: null,
    })),
  };
  const carryOver = { getRevision: mock(() => 'carry-1') };
  const ownership = {
    transfer: mock(async (request) => ({
      ...entry,
      ...request.patch,
      agentId: request.targetAgentId,
      agentSessionId: null,
      nativeSession: null,
      agentOwnershipEpoch: 'epoch-target',
    })),
  };
  const service = new AgentSwitchService({
    registry,
    directory,
    endpointResolver,
    carryOver,
    ownership,
    chatMutationLock: overrides.lock ?? new KeyedPromiseLock(),
  });
  return { service, source, target, ownership, endpointResolver };
}

describe('AgentSwitchService', () => {
  it('loads the source transcript and delegates the atomic ownership transfer', async () => {
    const { service, source, target, ownership } = makeService();

    const updated = await service.switchAgentModel({ chatId: '1', agentId: 'target', model: 'target-model' });

    expect(source.transcript.load).toHaveBeenCalledTimes(1);
    expect(ownership.transfer).toHaveBeenCalledWith(expect.objectContaining({
      chatId: '1',
      targetAgentId: 'target',
      carryOverSegment: expect.objectContaining({ agentId: 'source', model: 'source-model' }),
      patch: expect.objectContaining({
        model: 'target-model',
        permissionMode: 'acceptEdits',
        thinkingMode: 'high',
        agentSettingsById: {
          source: envelope('source', { retained: true }),
          target: envelope('target'),
        },
      }),
    }));
    expect(target.settings.parse).toHaveBeenCalledWith(envelope('target'));
    expect(updated.agentId).toBe('target');
  });

  it('rejects a switch while the source integration reports a running session', async () => {
    const { service, ownership } = makeService({ source: { isRunning: mock(() => true) } });

    await expect(service.switchAgentModel({ chatId: '1', agentId: 'target', model: 'target-model' }))
      .rejects.toBeInstanceOf(AgentSwitchError);
    expect(ownership.transfer).not.toHaveBeenCalled();
  });

  it('normalizes modes against the target descriptor without provider rules', async () => {
    const { service, ownership } = makeService({
      entry: { permissionMode: 'plan', thinkingMode: 'ultra' },
      target: { descriptor: { supportedPermissionModes: ['default'], supportedThinkingModes: ['none'] } },
    });

    await service.switchAgentModel({ chatId: '1', agentId: 'target', model: 'target-model' });

    expect(ownership.transfer.mock.calls[0][0].patch).toMatchObject({
      permissionMode: 'default',
      thinkingMode: 'none',
    });
  });

  it('does not duplicate carry-over when the source has no native session', async () => {
    const { service, source, ownership } = makeService({
      entry: { agentSessionId: null, nativeSession: null },
    });

    await service.switchAgentModel({ chatId: '1', agentId: 'target', model: 'target-model' });

    expect(source.transcript.load).not.toHaveBeenCalled();
    expect(ownership.transfer.mock.calls[0][0].carryOverSegment).toBeNull();
  });

  it('serializes same-chat transfers through the shared mutation lock', async () => {
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const load = mock(async () => {
      order.push('load');
      await gate;
      return { messages: [], revision: 'native-1' };
    });
    const { service, ownership } = makeService({ source: { load } });
    ownership.transfer.mockImplementation(async (request) => {
      order.push(`transfer:${request.patch.model}`);
      return { agentId: request.targetAgentId, ...request.patch };
    });

    const first = service.switchAgentModel({ chatId: '1', agentId: 'target', model: 'one' });
    const second = service.switchAgentModel({ chatId: '1', agentId: 'target', model: 'two' });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['load']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['load', 'transfer:one', 'load', 'transfer:two']);
  });
});
