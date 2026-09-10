import { expect, mock, test } from 'bun:test';
import { LocalProviderNativeSessionService } from '../local-provider-native-sessions.js';
import { LocalProviderNativeActivityService } from '../local-provider-native-activity.js';

function fixture(profile = 'primary') {
  const nativeSession = { ownerId: 'synthetic', schemaVersion: 1, value: { profile, sessionId: 'colliding-session' } };
  const defaults = { ownerId: 'synthetic', schemaVersion: 1, values: { profile } };
  const source = { kind: 'provider-reference', value: `${profile}/colliding-session` };
  const activity = { kind: 'ready', value: { lastEntryAt: '2026-09-10T00:00:00.000Z' } };
  /** @satisfies {Pick<import('@garcon/server-agent-interface').AgentIntegration, 'descriptor' | 'settings' | 'nativeSessions' | 'nativeActivity'>} */
  const integration = {
    descriptor: {
      id: 'synthetic', label: 'Synthetic', icon: null, supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'], supportsImages: false, supportsProjectPathUpdate: false,
      requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [], configuration: [],
    },
    settings: {
      defaults: () => defaults, describe: () => [], migrate: async (input) => input,
      parse: mock((input) => ({ ...input, values: { ...input.values, parsedBy: profile } })),
      applyPatch: (input) => input,
    },
    nativeSessions: {
      resolveNativeSession: mock(async () => nativeSession),
      describeSource: mock(async () => source),
      release: mock(async () => {}),
    },
    nativeActivity: { lastActivity: mock(async () => activity) },
  };
  /** @satisfies {import('../../execution-nodes/provider-native-sessions.js').ProviderNativeSessionRequest} */
  const request = { chat: {
    chatId: '1000000000000001', agentId: 'synthetic', agentSessionId: 'colliding-session',
    projectPath: '/synthetic/project', model: 'synthetic-model', nativeSession: structuredClone(nativeSession),
    carryOverRevision: '', nativeSeedReceipt: null, settings: null,
  } };
  return {
    integration, request, nativeSession, source, activity, defaults,
    sessions: new LocalProviderNativeSessionService(integration),
    probe: new LocalProviderNativeActivityService(integration),
  };
}

test('native services keep colliding sessions and settings on their bound profile', async () => {
  const first = fixture('primary');
  const second = fixture('secondary');
  const signal = new AbortController().signal;
  for (const f of [first, second]) {
    expect(await f.sessions.resolve(f.request, signal)).toEqual(f.nativeSession);
    expect(await f.sessions.describe(f.request, signal)).toEqual(f.source);
    expect(await f.probe.lastActivity(f.nativeSession, signal)).toEqual(f.activity);
  }
  await second.sessions.release({ ...second.request, reason: 'deleted' }, signal);
  expect(first.integration.nativeSessions.release).not.toHaveBeenCalled();
  expect(second.integration.nativeSessions.release).toHaveBeenCalledWith({
    chat: { ...second.request.chat, settings: { ...second.defaults, values: { profile: 'secondary', parsedBy: 'secondary' } } },
    reason: 'deleted', signal,
  });
});

test('native services copy provider-owned results and parse a private settings copy', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  f.integration.settings.parse = (input) => {
    input.values.parsed = true;
    return input;
  };
  (await f.sessions.resolve(f.request, signal)).value.profile = 'caller mutation';
  (await f.sessions.describe(f.request, signal)).value = 'caller mutation';
  (await f.probe.lastActivity(f.nativeSession, signal)).value.lastEntryAt = null;
  expect(f.nativeSession.value.profile).toBe('primary');
  expect(f.source.value).toBe('primary/colliding-session');
  expect(f.activity.value.lastEntryAt).toBe('2026-09-10T00:00:00.000Z');
  expect(f.defaults.values).toEqual({ profile: 'primary' });
  expect(f.request.chat.settings).toBeNull();
});

test.each([
  ['resolve', 'resolveNativeSession'], ['describe', 'describeSource'], ['release', 'release'],
])('%s captures the complete native request and preserves its provider receiver', async (method, providerMethod) => {
  const f = fixture();
  const response = Promise.withResolvers();
  const received = [];
  const signal = new AbortController().signal;
  f.request.chat.settings = structuredClone(f.defaults);
  f.integration.nativeSessions[providerMethod] = async function (input) {
    await response.promise;
    expect(this).toBe(f.integration.nativeSessions);
    received.push(structuredClone(input.chat));
    input.chat.nativeSession.value.profile = 'provider mutation';
    return method === 'resolve' ? f.nativeSession : method === 'describe' ? f.source : undefined;
  };
  const request = { ...f.request, reason: 'deleted' };
  const pending = f.sessions[method](request, signal);
  request.chat.nativeSession.value.profile = 'caller mutation';
  request.chat.settings.values.profile = 'caller mutation';
  request.chat.projectPath = '/changed/project';
  response.resolve();
  await pending;
  expect(received[0]).toMatchObject({ projectPath: '/synthetic/project',
    nativeSession: { value: { profile: 'primary' } }, settings: { values: { profile: 'primary' } } });
  expect(request.chat.nativeSession.value.profile).toBe('caller mutation');
});

test.each([
  ['resolve', 'resolveNativeSession'], ['describe', 'describeSource'], ['release', 'release'],
])('%s checks cancellation before provider entry and after delivery', async (method, providerMethod) => {
  const f = fixture();
  const response = Promise.withResolvers();
  const controller = new AbortController();
  const cancellation = new Error('Synthetic native cancellation');
  void response.promise.then(() => controller.abort(cancellation));
  f.integration.nativeSessions[providerMethod] = mock(() => response.promise);
  const request = { ...f.request, reason: 'deleted' };
  const pending = f.sessions[method](request, controller.signal);
  response.resolve(method === 'resolve' ? f.nativeSession : method === 'describe' ? f.source : undefined);
  await expect(pending).rejects.toBe(cancellation);
  await expect(f.sessions[method](request, controller.signal)).rejects.toBe(cancellation);
  expect(f.integration.nativeSessions[providerMethod]).toHaveBeenCalledTimes(1);
  expect(f.integration.nativeSessions[providerMethod].mock.calls[0][0].signal).toBe(controller.signal);
});

test('activity isolates the native reference and observes a handoff-time cancellation', async () => {
  const f = fixture();
  const response = Promise.withResolvers();
  const controller = new AbortController();
  const cancellation = new Error('Synthetic probe cancellation');
  void response.promise.then(() => controller.abort(cancellation));
  f.integration.nativeActivity.lastActivity = mock(function (ref, signal) {
    expect(this).toBe(f.integration.nativeActivity);
    expect(signal).toBe(controller.signal);
    ref.value.profile = 'provider mutation';
    return response.promise;
  });
  const pending = f.probe.lastActivity(f.nativeSession, controller.signal);
  response.resolve(f.activity);
  await expect(pending).rejects.toBe(cancellation);
  await expect(f.probe.lastActivity(f.nativeSession, controller.signal)).rejects.toBe(cancellation);
  expect(f.nativeSession.value.profile).toBe('primary');
  expect(f.integration.nativeActivity.lastActivity).toHaveBeenCalledTimes(1);
});

test.each([
  ['agent', true], ['native', true], ['agent', false], ['native', false],
])('rejects a mismatched %s owner even when native access is absent (supported: %s)', async (field, supported) => {
  const f = fixture();
  const nativeSessions = f.integration.nativeSessions;
  if (!supported) f.integration.nativeSessions = null;
  if (field === 'agent') f.request.chat.agentId = 'other-provider';
  else f.request.chat.nativeSession.ownerId = 'other-provider';
  const signal = new AbortController().signal;
  for (const method of ['resolve', 'describe', 'release']) {
    await expect(f.sessions[method]({ ...f.request, reason: 'deleted' }, signal)).rejects.toThrow('Native session owner mismatch');
  }
  expect(nativeSessions.resolveNativeSession).not.toHaveBeenCalled();
  expect(nativeSessions.describeSource).not.toHaveBeenCalled();
  expect(nativeSessions.release).not.toHaveBeenCalled();
  await expect(f.probe.lastActivity({ ...f.nativeSession, ownerId: 'other-provider' }, signal))
    .rejects.toThrow('Native session owner mismatch');
  expect(f.integration.nativeActivity.lastActivity).not.toHaveBeenCalled();
});

test('rejects foreign native results and malformed source descriptions without reading returned paths', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  f.integration.nativeSessions.resolveNativeSession = async () => ({ ...f.nativeSession, ownerId: 'other-provider' });
  await expect(f.sessions.resolve(f.request, signal)).rejects.toThrow('Native session owner mismatch');
  for (const source of [{ kind: 'url', value: 'synthetic' }, { kind: 'filesystem-path', value: '' }]) {
    f.integration.nativeSessions.describeSource = async () => source;
    await expect(f.sessions.describe(f.request, signal)).rejects.toThrow('INVALID_TRANSCRIPT_SOURCE_DESCRIPTION');
  }
  f.integration.nativeSessions.describeSource = async () => ({ kind: 'filesystem-path', value: '/nonexistent/native/source' });
  expect(await f.sessions.describe(f.request, signal)).toEqual({ kind: 'filesystem-path', value: '/nonexistent/native/source' });
});

test('null native capabilities retain absence without constructing a source or an activity timestamp', async () => {
  const f = fixture();
  f.integration.nativeSessions = null;
  f.integration.nativeActivity = null;
  const signal = new AbortController().signal;
  expect(await f.sessions.resolve(f.request, signal)).toBeNull();
  expect(await f.sessions.describe(f.request, signal)).toBeNull();
  await f.sessions.release({ ...f.request, reason: 'deleted' }, signal);
  expect(await f.probe.lastActivity(f.nativeSession, signal)).toEqual({ kind: 'unavailable' });
});
