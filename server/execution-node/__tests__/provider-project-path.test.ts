import { expect, mock, test } from 'bun:test';
import type { AgentIntegration, AgentProjectPathUpdatePreparation, AgentProjectPathUpdates } from '@garcon/server-agent-interface';
import type { ProviderProjectPathUpdateRequest } from '../../execution-nodes/provider-project-path.js';
import { LocalProviderProjectPathUpdateService } from '../local-provider-project-path.js';

function fixture(profile = 'primary') {
  const nativeSession = { ownerId: 'synthetic', schemaVersion: 1, value: { profile, sessionId: 'colliding-session' } };
  const defaults = { ownerId: 'synthetic', schemaVersion: 1, values: { profile } };
  const integration = {
    descriptor: {
      id: 'synthetic', label: 'Synthetic', icon: null, supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'], supportsImages: false, supportsProjectPathUpdate: true,
      requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [], configuration: [],
    },
    settings: {
      defaults: () => defaults, describe: () => [], migrate: async (input) => input,
      parse: mock((input) => ({ ...input, values: { ...input.values, parsedBy: profile } })),
      applyPatch: (input) => input,
    },
  } satisfies Pick<AgentIntegration, 'descriptor' | 'settings'>;
  const preparation = {
    nativeSession,
    commit: mock(async () => {}),
    rollback: mock(async () => {}),
  } satisfies AgentProjectPathUpdatePreparation;
  const updates: AgentProjectPathUpdates = { prepare: mock(async () => preparation) };
  const request: ProviderProjectPathUpdateRequest = {
    chat: {
      chatId: '1000000000000001', agentId: 'synthetic', agentSessionId: 'colliding-session',
      projectPath: '/synthetic/project', model: 'synthetic-model', nativeSession,
      carryOverRevision: 'synthetic-carry', nativeSeedReceipt: null, settings: null,
    },
    nextProjectPath: '/synthetic/next',
  };
  return { integration, defaults, preparation, updates, request,
    service: new LocalProviderProjectPathUpdateService(integration, updates) };
}

test('project-path preparation parses defaults on the exact instance and retains cleanup ownership', async () => {
  const primary = fixture();
  const secondary = fixture('secondary');
  const signal = new AbortController().signal;
  expect(await secondary.service.prepare(secondary.request, signal)).toBe(secondary.preparation);
  expect(secondary.updates.prepare).toHaveBeenCalledWith({
    chat: { ...secondary.request.chat, settings: { ...secondary.defaults,
      values: { profile: 'secondary', parsedBy: 'secondary' } } },
    nextProjectPath: '/synthetic/next', signal,
  });
  expect(primary.updates.prepare).not.toHaveBeenCalled();
  expect(secondary.request.chat.settings).toBeNull();
  expect(secondary.preparation.commit).not.toHaveBeenCalled();
  expect(secondary.preparation.rollback).not.toHaveBeenCalled();
});

test('project-path preparation captures its request before native work and preserves the facet receiver', async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  const request = { chat: { ...f.request.chat, nativeSession: structuredClone(f.preparation.nativeSession),
    settings: structuredClone(f.defaults) }, nextProjectPath: f.request.nextProjectPath };
  f.updates.prepare = async function (input) {
    await gate.promise;
    expect(this).toBe(f.updates);
    expect(input.nextProjectPath).toBe('/synthetic/next');
    expect(input.chat.nativeSession?.value.profile).toBe('primary');
    expect(input.chat.settings.values.profile).toBe('primary');
    Reflect.set(input.chat.settings.values, 'profile', 'provider mutation');
    return f.preparation;
  };
  const pending = f.service.prepare(request, new AbortController().signal);
  request.nextProjectPath = '/caller/changed';
  request.chat.nativeSession.value.profile = 'caller mutation';
  request.chat.settings.values.profile = 'caller mutation';
  gate.resolve();
  expect(await pending).toBe(f.preparation);
  expect(request.chat.settings.values.profile).toBe('caller mutation');
});

test.each(['agent', 'native'] as const)('project-path preparation rejects a foreign %s owner before provider parsing', async (field) => {
  const f = fixture();
  const chat = field === 'agent'
    ? { ...f.request.chat, agentId: 'foreign' }
    : { ...f.request.chat, nativeSession: { ...f.preparation.nativeSession, ownerId: 'foreign' } };
  await expect(f.service.prepare({ ...f.request, chat }, new AbortController().signal))
    .rejects.toThrow('Native session owner mismatch');
  expect(f.integration.settings.parse).not.toHaveBeenCalled();
  expect(f.updates.prepare).not.toHaveBeenCalled();
});

test.each(['before', 'during parsing'] as const)('project-path cancellation %s prevents native mutation', async (phase) => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error('Synthetic cancelled preparation');
  if (phase === 'before') controller.abort(reason);
  else f.integration.settings.parse = mock((input) => {
    controller.abort(reason);
    return { ...input, values: { ...input.values, parsedBy: 'primary' } };
  });
  await expect(f.service.prepare(f.request, controller.signal)).rejects.toBe(reason);
  expect(f.updates.prepare).not.toHaveBeenCalled();
});

test('project-path cancellation during native work preserves the returned preparation and exact rollback', async () => {
  const f = fixture();
  const gate = Promise.withResolvers<AgentProjectPathUpdatePreparation>();
  const controller = new AbortController();
  f.updates.prepare = mock(() => gate.promise);
  const pending = f.service.prepare(f.request, controller.signal);
  controller.abort(new Error('Synthetic cancelled preparation'));
  gate.resolve(f.preparation);
  const result = await pending;
  expect(result).toBe(f.preparation);
  expect(f.updates.prepare).toHaveBeenCalledTimes(1);
  expect(f.preparation.rollback).not.toHaveBeenCalled();
  await result!.rollback();
  expect(f.preparation.rollback).toHaveBeenCalledTimes(1);
  expect(f.preparation.commit).not.toHaveBeenCalled();
});

test.each(['throw', 'reject'] as const)('project-path preparation preserves a provider %s without retrying', async (kind) => {
  const f = fixture();
  const reason = new Error('Synthetic preparation failure');
  f.updates.prepare = mock(() => {
    if (kind === 'throw') throw reason;
    return Promise.reject(reason);
  });
  await expect(f.service.prepare(f.request, new AbortController().signal)).rejects.toBe(reason);
  expect(f.updates.prepare).toHaveBeenCalledTimes(1);
});

test('project-path preparation preserves a provider-confirmed no-op', async () => {
  const f = fixture();
  f.updates.prepare = mock(async () => {});
  expect(await f.service.prepare(f.request, new AbortController().signal)).toBeUndefined();
  expect(f.updates.prepare).toHaveBeenCalledTimes(1);
});
