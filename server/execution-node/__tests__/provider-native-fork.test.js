import { expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { createJsonlNativeForking } from '../../../server-agents/common/src/forking/jsonl-forking.js';
import { createPathNativeSessionCodec } from '../../../server-agents/common/src/native-session/path-native-session.js';
import { createNativeSeedReceipt } from '../../../common/transcript-seed.js';
import { LocalProviderNativeForkService } from '../local-provider-native-fork.js';

function fixture() {
  const defaults = { ownerId: 'synthetic', schemaVersion: 1, values: { profile: 'secondary' } };
  /** @satisfies {Pick<import('@garcon/server-agent-interface').AgentIntegration, 'descriptor' | 'settings' | 'endpoints' | 'sessionConfiguration'>} */
  const integration = {
    descriptor: {
      id: 'synthetic', label: 'Synthetic', icon: null,
      supportedPermissionModes: ['default'], supportedThinkingModes: ['none', 'low'],
      supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: ['openai-compatible'], configuration: [],
    },
    settings: {
      describe: () => [], defaults: () => defaults,
      parse: mock((input) => ({ ...input, values: { ...input.values, parsedBy: 'secondary' } })),
      applyPatch: (input) => input, migrate: async (input) => input,
    },
    endpoints: { validate: mock(async () => {}) },
    sessionConfiguration: null,
  };
  /** @satisfies {import('@garcon/server-agent-interface').AgentEstablishedSession} */
  const session = {
    agentSessionId: 'synthetic-fork',
    nativeSession: { ownerId: 'synthetic', schemaVersion: 1, value: { id: 'synthetic-fork' } },
    nativeSeedReceipt: createNativeSeedReceipt({
      agentSessionId: 'synthetic-fork', placement: 'user-prefix', prefix: 'Synthetic carried context',
    }),
  };
  /** @satisfies {import('@garcon/server-agent-interface').AgentNativeFork} */
  const forking = {
    fork: mock(async () => ({ kind: 'materialized', session })),
    discard: mock(async () => {}),
  };
  /** @satisfies {import('../../execution-nodes/provider-native-fork.js').ProviderNativeForkRequest} */
  const request = {
    chatId: '1000000000000002',
    source: {
      chatId: '1000000000000001', agentId: 'synthetic', agentSessionId: 'synthetic-source',
      projectPath: '/synthetic/project', model: 'synthetic-model',
      nativeSession: { ownerId: 'synthetic', schemaVersion: 1, value: { id: 'synthetic-source' } },
      nativeSeedReceipt: null, carryOverRevision: 'synthetic-revision', settings: null,
    },
    configuration: {
      model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'low', settings: null,
      endpoint: {
        selection: {
          apiProviderId: 'synthetic-api', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic API',
          protocol: 'openai-compatible', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model',
          isLocal: false, capabilities: null, headers: { 'x-synthetic': 'original' },
        },
        credential: 'synthetic-secret',
      },
    },
    providerMeta: { point: { id: 'original' } },
  };
  return { integration, defaults, request, session, forking, controller: new AbortController(),
    service: new LocalProviderNativeForkService(integration, forking) };
}

test.each([false, true])('captures the request before validation and parses settings on its instance (saved: %s)', async (saved) => {
  const f = fixture();
  if (saved) {
    f.request.source.settings = structuredClone(f.defaults);
    f.request.configuration.settings = structuredClone(f.defaults);
  }
  const validation = Promise.withResolvers();
  f.integration.endpoints.validate = mock(() => validation.promise);
  const original = structuredClone(f.request);
  f.forking.fork = mock(async function (request) {
    expect(this).toBe(f.forking);
    expect(request.admission.signal).toBe(f.controller.signal);
    await request.admission.markStarted();
    expect(request).toMatchObject({
      chatId: original.chatId, projectPath: original.source.projectPath,
      model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'low',
      endpoint: original.configuration.endpoint,
      providerMeta: original.providerMeta,
      source: { ...original.source, settings: { ...f.defaults, values: { profile: 'secondary', parsedBy: 'secondary' } } },
      settings: { ...f.defaults, values: { profile: 'secondary', parsedBy: 'secondary' } },
    });
    expect(request).not.toHaveProperty('runId');
    expect(request).not.toHaveProperty('output');
    request.source.nativeSession.value.id = 'provider mutation';
    request.settings.values.profile = 'provider mutation';
    request.providerMeta.point.id = 'provider mutation';
    return { kind: 'materialized', session: f.session };
  });
  const pending = f.service.fork(f.request, f.controller.signal);
  f.request.chatId = '1000000000000003';
  f.request.source.projectPath = '/changed';
  f.request.source.nativeSession.value.id = 'caller mutation';
  f.request.configuration.endpoint.selection.headers['x-synthetic'] = 'caller mutation';
  f.request.providerMeta.point.id = 'caller mutation';
  if (saved) {
    f.request.source.settings.values.profile = 'caller mutation';
    f.request.configuration.settings.values.profile = 'caller mutation';
  }
  validation.resolve();
  expect(await pending).toEqual({ kind: 'materialized', session: f.session });
  expect(f.integration.endpoints.validate).toHaveBeenCalledWith(original.configuration.endpoint.selection);
  expect(f.integration.settings.parse).toHaveBeenCalledTimes(2);
  expect(f.defaults.values.profile).toBe('secondary');
  expect(f.request.source.nativeSession.value.id).toBe('caller mutation');
  expect(f.request.providerMeta.point.id).toBe('caller mutation');
});

test.each(['agentId', 'nativeSession'])('rejects a foreign source %s before validation or provider invocation', async (field) => {
  const f = fixture();
  if (field === 'agentId') f.request.source.agentId = 'foreign';
  else f.request.source.nativeSession.ownerId = 'foreign';
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toThrow('Native session owner mismatch');
  expect(f.integration.endpoints.validate).not.toHaveBeenCalled();
  expect(f.integration.settings.parse).not.toHaveBeenCalled();
  expect(f.forking.fork).not.toHaveBeenCalled();
});

test.each(['before', 'validation', 'source-parsing'])('cancellation during %s does not invoke the fork', async (phase) => {
  const f = fixture();
  const cancellation = new Error('Synthetic pre-fork cancellation');
  if (phase === 'before') f.controller.abort(cancellation);
  if (phase === 'validation') f.integration.endpoints.validate = async () => { f.controller.abort(cancellation); };
  if (phase === 'source-parsing') {
    let parses = 0;
    f.integration.settings.parse = (input) => {
      if (++parses === 2) f.controller.abort(cancellation);
      return input;
    };
  }
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toBe(cancellation);
  expect(f.forking.fork).not.toHaveBeenCalled();
  expect(f.forking.discard).not.toHaveBeenCalled();
});

test.each([false, true])('preserves a provider refusal or its winning cancellation (cancelled: %s)', async (cancelled) => {
  const f = fixture();
  const failure = new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', 'Synthetic native refusal', true, { nativeForkReason: 'not-settled' });
  const cancellation = new Error('Synthetic fork cancellation');
  f.forking.fork = async () => {
    if (cancelled) f.controller.abort(cancellation);
    throw failure;
  };
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toBe(cancelled ? cancellation : failure);
  expect(f.forking.discard).not.toHaveBeenCalled();
});

test.each([false, true])('checks cancellation on an unmaterialized result (cancelled: %s)', async (cancelled) => {
  const f = fixture();
  const cancellation = new Error('Synthetic unmaterialized cancellation');
  f.forking.fork = async () => {
    if (cancelled) f.controller.abort(cancellation);
    return { kind: 'unmaterialized' };
  };
  const pending = f.service.fork(f.request, f.controller.signal);
  if (cancelled) await expect(pending).rejects.toBe(cancellation);
  else await expect(pending).resolves.toEqual({ kind: 'unmaterialized' });
  expect(f.forking.discard).not.toHaveBeenCalled();
});

test.each([false, true])('returns a private materialized artifact even after cancellation (cancelled: %s)', async (cancelled) => {
  const f = fixture();
  f.forking.fork = async () => {
    if (cancelled) f.controller.abort(new Error('Synthetic materialization cancellation'));
    return { kind: 'materialized', session: f.session };
  };
  const expected = structuredClone(f.session);
  const result = await f.service.fork(f.request, f.controller.signal);
  expect(result).toEqual({ kind: 'materialized', session: expected });
  expect(result.session).not.toBe(f.session);
  f.session.nativeSession.value.id = 'provider mutation';
  f.session.nativeSeedReceipt.agentSessionId = 'provider mutation';
  expect(result.session).toEqual(expected);
  expect(f.forking.discard).not.toHaveBeenCalled();
});

test('discards a captured materialized artifact when its owner cannot cross the service boundary', async () => {
  const f = fixture();
  f.session.nativeSession.ownerId = 'foreign';
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toThrow();
  expect(f.forking.discard).toHaveBeenCalledOnce();
  expect(f.forking.discard.mock.calls[0][0]).toEqual(f.session);
  expect(f.forking.discard.mock.calls[0][0]).not.toBe(f.session);
  expect(f.forking.discard.mock.calls[0][1].aborted).toBe(false);
});

test.each([false, true])('reports unconfirmed cleanup when the artifact cannot be captured (cancelled: %s)', async (cancelled) => {
  const f = fixture();
  const cancellation = new Error('Synthetic cancellation after materialization');
  f.session.nativeSession.value.invalid = () => {};
  f.forking.fork = async () => {
    if (cancelled) f.controller.abort(cancellation);
    return { kind: 'materialized', session: f.session };
  };
  const failure = await f.service.fork(f.request, f.controller.signal).catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  if (cancelled) expect(failure.errors[0]).toBe(cancellation);
  else expect(failure.errors[0].name).toBe('DataCloneError');
  expect(failure.errors[1].message).toContain('cleanup is unconfirmed');
  expect(f.forking.discard).not.toHaveBeenCalled();
});

test('uses one captured native path for validation and actual JSONL cleanup', async () => {
  const f = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'garcon-fork-cleanup-'));
  const created = join(directory, 'created.jsonl');
  const unrelated = join(directory, 'unrelated.jsonl');
  const codec = createPathNativeSessionCodec('synthetic');
  let reads = 0;
  try {
    await writeFile(created, 'Synthetic created artifact');
    await writeFile(unrelated, 'Synthetic unrelated artifact');
    const session = { agentSessionId: 'synthetic-fork', get nativeSession() {
      return codec.encode({ path: ++reads === 1 ? created : unrelated, agentSessionId: 'synthetic-fork', modelEndpointId: null });
    } };
    f.forking.fork = async () => ({ kind: 'materialized', session });
    f.forking.discard = createJsonlNativeForking({
      nativeSessions: codec,
      nativeEvidence: {
        load: async () => { throw new Error('Unexpected native read'); },
        resolveNativeSession: async () => { throw new Error('Unexpected native resolution'); },
      },
    }).discard;
    await expect(f.service.fork(f.request, f.controller.signal)).rejects.toThrow('Invalid established session');
    expect(reads).toBe(1);
    await expect(readFile(created)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unrelated, 'utf8')).toBe('Synthetic unrelated artifact');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('captures source and destination defaults before asynchronous endpoint validation', async () => {
  const f = fixture();
  const validation = Promise.withResolvers();
  f.integration.endpoints.validate = () => validation.promise;
  const result = f.service.fork(f.request, f.controller.signal);
  f.defaults.values.profile = 'changed during preparation';
  validation.resolve();
  await result;
  const request = f.forking.fork.mock.calls[0][0];
  expect(request.settings.values.profile).toBe('secondary');
  expect(request.source.settings.values.profile).toBe('secondary');
});

const invalidSessions = [
  ['empty session ID', (session) => { session.agentSessionId = ''; }],
  ['blank session ID', (session) => { session.agentSessionId = ' '; }],
  ['missing native reference', (session) => { delete session.nativeSession; }],
  ['missing seed receipt', (session) => { delete session.nativeSeedReceipt; }],
  ['invalid native schema', (session) => { session.nativeSession.schemaVersion = 0; }],
  ['fractional native schema', (session) => { session.nativeSession.schemaVersion = 1.5; }],
  ['missing native value', (session) => { delete session.nativeSession.value; }],
  ['array native value', (session) => { session.nativeSession.value = []; }],
  ['date native value', (session) => { session.nativeSession.value.invalid = new Date(0); }],
  ['map native value', (session) => { session.nativeSession.value.invalid = new Map(); }],
  ['bigint native value', (session) => { session.nativeSession.value.invalid = 1n; }],
  ['nonfinite native value', (session) => { session.nativeSession.value.invalid = NaN; }],
  ['undefined native value', (session) => { session.nativeSession.value.invalid = undefined; }],
  ['sparse native value', (session) => { session.nativeSession.value.invalid = new Array(1); }],
  ['cyclic native value', (session) => { session.nativeSession.value.invalid = session.nativeSession.value; }],
  ['extra native field', (session) => { session.nativeSession.extra = 'unexpected'; }],
  ['invalid seed format', (session) => { session.nativeSeedReceipt.format = 'unknown'; }],
  ['invalid seed hash', (session) => { session.nativeSeedReceipt.sha256 = 'invalid'; }],
  ['invalid seed length', (session) => { session.nativeSeedReceipt.codeUnitLength = -1; }],
  ['foreign seed binding', (session) => { session.nativeSeedReceipt.agentSessionId = 'another-session'; }],
  ['extra seed field', (session) => { session.nativeSeedReceipt.extra = 'unexpected'; }],
  ['extra session field', (session) => { session.extra = 'unexpected'; }],
];

test.each(invalidSessions)('discards a cloneable artifact with %s exactly once', async (_label, invalidate) => {
  const f = fixture();
  invalidate(f.session);
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toThrow('Invalid established session');
  expect(f.forking.discard).toHaveBeenCalledTimes(1);
  expect(f.forking.discard.mock.calls[0][0]).toEqual(f.session);
  expect(f.forking.discard.mock.calls[0][0]).not.toBe(f.session);
  expect(f.forking.discard.mock.calls[0][1].aborted).toBe(false);
});

test.each(['unexpected', 'unmaterialized'])('discards an artifact returned under an invalid %s outcome', async (kind) => {
  const f = fixture();
  f.forking.fork = async () => ({ kind, session: f.session });
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toThrow('Invalid native fork outcome');
  expect(f.forking.discard).toHaveBeenCalledTimes(1);
  expect(f.forking.discard.mock.calls[0][0]).toEqual(f.session);
  expect(f.forking.discard.mock.calls[0][0]).not.toBe(f.session);
});

test.each(['hidden-session', 'symbol-field', 'custom-prototype'])('rejects an invalid %s outcome and discards its artifact', async (invalid) => {
  const f = fixture();
  const result = invalid === 'hidden-session'
    ? Object.defineProperty({ kind: 'unmaterialized' }, 'session', { value: f.session })
    : invalid === 'symbol-field'
      ? { kind: 'materialized', session: f.session, [Symbol('unexpected')]: true }
      : Object.assign(Object.create({ unexpected: true }), { kind: 'materialized', session: f.session });
  f.forking.fork = async () => result;
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toThrow('Invalid native fork outcome');
  expect(f.forking.discard).toHaveBeenCalledTimes(1);
  expect(f.forking.discard.mock.calls[0][0]).toEqual(f.session);
  expect(f.forking.discard.mock.calls[0][0]).not.toBe(f.session);
  expect(f.forking.discard.mock.calls[0][1].aborted).toBe(false);
});

test.each(['array', 'function'])('cleans up the artifact carried by a non-record %s outcome', async (carrier) => {
  const f = fixture();
  f.forking.fork = async () => Object.assign(carrier === 'array' ? [] : () => {}, {
    kind: 'materialized', session: f.session,
  });
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toThrow('Invalid native fork outcome');
  expect(f.forking.discard).toHaveBeenCalledOnce();
  expect(f.forking.discard.mock.calls[0][0]).toEqual(f.session);
  expect(f.forking.discard.mock.calls[0][0]).not.toBe(f.session);
  expect(f.forking.discard.mock.calls[0][1].aborted).toBe(false);
});

test('captures the artifact once before validation and cleanup', async () => {
  const f = fixture();
  delete f.session.nativeSeedReceipt;
  let reads = 0;
  f.forking.fork = async () => ({ kind: 'materialized', get session() {
    reads += 1;
    return reads === 1 ? f.session : { ...f.session, agentSessionId: 'another-artifact' };
  } });
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toThrow('Invalid established session');
  expect(reads).toBe(1);
  expect(f.forking.discard).toHaveBeenCalledTimes(1);
  expect(f.forking.discard.mock.calls[0][0]).toEqual(f.session);
  expect(f.forking.discard.mock.calls[0][0]).not.toBe(f.session);
});

test('rejects an inherited outcome discriminator while cleaning up the supplied artifact', async () => {
  const f = fixture();
  f.forking.fork = async () => Object.assign(Object.create({ kind: 'materialized' }), { session: f.session, extra: true });
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toThrow('Invalid native fork outcome');
  expect(f.forking.discard).toHaveBeenCalledTimes(1);
  expect(f.forking.discard.mock.calls[0][0]).toEqual(f.session);
  expect(f.forking.discard.mock.calls[0][0]).not.toBe(f.session);
});

test.each([null, {}, { kind: 'unexpected' }, { kind: 'materialized' }])('rejects a malformed outcome without a cleanup artifact: %j', async (result) => {
  const f = fixture();
  f.forking.fork = async () => result;
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toThrow('Invalid native fork outcome');
  expect(f.forking.discard).not.toHaveBeenCalled();
});

test('preserves valid nullable native reference and receipt fields', async () => {
  const f = fixture();
  f.session.nativeSession = null;
  f.session.nativeSeedReceipt = null;
  await expect(f.service.fork(f.request, f.controller.signal)).resolves.toEqual({ kind: 'materialized', session: f.session });
  expect(f.forking.discard).not.toHaveBeenCalled();
});

test.each([
  ['owner', false], ['owner', true], ['shape', false], ['shape', true],
])('retains %s validation and cleanup failures with cancellation precedence (cancelled: %s)', async (invalid, cancelled) => {
  const f = fixture();
  if (invalid === 'owner') f.session.nativeSession.ownerId = 'foreign';
  else delete f.session.nativeSeedReceipt;
  const cancellation = new Error('Synthetic cancellation during cleanup');
  const cleanupFailure = new Error('Synthetic fork cleanup failure');
  f.forking.discard = mock(async (_session, signal) => {
    expect(signal.aborted).toBe(false);
    if (cancelled) f.controller.abort(cancellation);
    throw cleanupFailure;
  });
  let failure;
  try { await f.service.fork(f.request, f.controller.signal); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  if (cancelled) expect(failure.errors[0]).toBe(cancellation);
  else expect(failure.errors[0].message).toBe(invalid === 'owner' ? 'Native session owner mismatch' : 'Invalid established session');
  expect(failure.errors[1]).toBe(cleanupFailure);
  expect(failure.message).toBe(failure.errors[0].message);
  expect(f.forking.discard).toHaveBeenCalledOnce();
});

test('preserves cancellation during successful invalid-artifact cleanup', async () => {
  const f = fixture();
  f.session.nativeSession.ownerId = 'foreign';
  const cancellation = new Error('Synthetic cancellation during cleanup');
  f.forking.discard = mock(async () => { f.controller.abort(cancellation); });
  await expect(f.service.fork(f.request, f.controller.signal)).rejects.toBe(cancellation);
  expect(f.forking.discard).toHaveBeenCalledOnce();
});

test('discard uses a private exact artifact and the facet receiver', async () => {
  const f = fixture();
  const expected = structuredClone(f.session);
  f.forking.discard = mock(async function (session, signal) {
    expect(this).toBe(f.forking);
    expect(session).toEqual(expected);
    expect(session).not.toBe(f.session);
    expect(signal).toBe(f.controller.signal);
    session.nativeSession.value.id = 'provider mutation';
  });
  await f.service.discard({ session: f.session }, f.controller.signal);
  expect(f.session).toEqual(expected);
});

test.each(['cancelled', 'foreign'])('discard rejects a %s request without invoking the provider', async (invalid) => {
  const f = fixture();
  const cancellation = new Error('Synthetic discard cancellation');
  if (invalid === 'cancelled') f.controller.abort(cancellation);
  else f.session.nativeSession.ownerId = 'foreign';
  const pending = f.service.discard({ session: f.session }, f.controller.signal);
  if (invalid === 'cancelled') await expect(pending).rejects.toBe(cancellation);
  else await expect(pending).rejects.toThrow('Native session owner mismatch');
  expect(f.forking.discard).not.toHaveBeenCalled();
});

test.each(invalidSessions)('discard rejects an invalid %s without invoking the provider', async (_label, invalidate) => {
  const f = fixture();
  invalidate(f.session);
  await expect(f.service.discard({ session: f.session }, f.controller.signal)).rejects.toThrow('Invalid established session');
  expect(f.forking.discard).not.toHaveBeenCalled();
});

test('discard reports cancellation delivered by successful provider cleanup', async () => {
  const f = fixture();
  const cancellation = new Error('Synthetic discard completion cancellation');
  f.forking.discard = async () => { f.controller.abort(cancellation); };
  await expect(f.service.discard({ session: f.session }, f.controller.signal)).rejects.toBe(cancellation);
});
