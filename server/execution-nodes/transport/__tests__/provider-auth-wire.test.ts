import { expect, test } from 'bun:test';
import { captureNodeProviderAuthReply, MAX_NODE_AUTH_BYTES, MAX_NODE_LOGIN_CODE_LENGTH, parseNodeProviderAuthCommand,
  parseNodeProviderAuthReply, type NodeProviderAuthCommand, type NodeProviderAuthReply } from '../provider-auth-wire.js';

const instanceId = 'synthetic-instance';
const deviceAuth = { url: 'https://auth.synthetic.invalid/login', code: 'SYNTHETIC-CODE', needsCode: true };
const commands: readonly NodeProviderAuthCommand[] = [
  { method: 'provider-auth', instanceId, operation: 'status' },
  { method: 'provider-auth', instanceId, operation: 'launch-login' },
  { method: 'provider-auth', instanceId, operation: 'login-status', sessionId: null },
  { method: 'provider-auth', instanceId, operation: 'login-status', sessionId: 'synthetic-login' },
  { method: 'provider-auth', instanceId, operation: 'complete-login', sessionId: 'synthetic-login', code: 'synthetic-code' },
];
const replies: readonly NodeProviderAuthReply[] = [
  { kind: 'provider-auth-status', instanceId, status: null },
  { kind: 'provider-auth-status', instanceId, status: { authenticated: true, canReauth: true, label: 'Synthetic profile', source: 'cli', detail: 'Synthetic status' } },
  { kind: 'provider-login-status', instanceId, status: { state: 'idle', running: false } },
  { kind: 'provider-login-status', instanceId, status: { state: 'running', running: true, sessionId: 'synthetic-login', deviceAuth } },
  { kind: 'provider-login-status', instanceId, status: { state: 'succeeded', running: false, sessionId: 'synthetic-login' } },
  { kind: 'provider-login-status', instanceId, status: { state: 'failed', running: false, sessionId: 'synthetic-login', error: 'Synthetic login failure' } },
  { kind: 'provider-login-launched', instanceId, result: { launched: true, alreadyRunning: false, sessionId: 'synthetic-login', deviceAuth } },
  { kind: 'provider-login-completed', instanceId, result: { submitted: true, sessionId: 'synthetic-login' } },
  { kind: 'provider-auth-rejected', instanceId, code: 'OPERATION_UNSUPPORTED' },
  { kind: 'provider-auth-rejected', instanceId, code: 'AUTH_LOGIN_SESSION_MISMATCH' },
];

test('auth requests and all login outcomes retain closed typed contracts', () => {
  for (const command of commands) {
    expect(parseNodeProviderAuthCommand(command)).toEqual(command);
    expect(parseNodeProviderAuthCommand({ ...command, extra: true })).toBeNull();
  }
  for (const reply of replies) {
    expect(parseNodeProviderAuthReply(reply)).toEqual(reply);
    expect(parseNodeProviderAuthReply({ ...reply, extra: true })).toBeNull();
    expect(parseNodeProviderAuthReply({ ...reply, instanceId: '' })).toBeNull();
  }
});

test('login inputs reject unsupported methods, session omissions, framing and size overflow', () => {
  const complete = commands[4]!;
  expect(MAX_NODE_AUTH_BYTES).toBe(32 * 1024);
  expect(MAX_NODE_LOGIN_CODE_LENGTH).toBe(8192);
  expect(parseNodeProviderAuthCommand({ ...complete, code: 'c'.repeat(MAX_NODE_LOGIN_CODE_LENGTH) })).not.toBeNull();
  for (const invalid of [{ ...complete, code: '' }, { ...complete, code: ' ' }, { ...complete, code: 'c'.repeat(MAX_NODE_LOGIN_CODE_LENGTH + 1) },
    { ...complete, code: 'code\nsecond' }, { ...complete, code: 'code\rsecond' }, { ...complete, code: 'code\0' }, { ...complete, sessionId: null },
    { method: 'provider-auth', instanceId, operation: 'login-status' }, { ...commands[0], sessionId: 'unexpected' },
    { ...commands[0], operation: 'delete-login' }, { ...commands[0], instanceId: '' },
  ]) expect(parseNodeProviderAuthCommand(invalid)).toBeNull();
});

test('auth replies reject malformed native states, URLs, executable values and inherited fields', () => {
  const launch = replies[6]!;
  const status = { authenticated: true, canReauth: false, label: 'Synthetic', source: 'cli' };
  for (const invalid of [
    ...['javascript:alert(1)', 'http://auth.synthetic.invalid', 'https://user:password@auth.synthetic.invalid'].map((url) => ({
      ...launch, result: { launched: true, alreadyRunning: false, sessionId: 'synthetic-login', deviceAuth: { url } },
    })),
    { ...replies[1], status: { ...status, source: ['cli'] } }, { ...replies[1], status: { ...status, authenticated: 1 } },
    { ...replies[1], status: { ...status, detail: '界'.repeat(4097) } },
    { ...replies[1], status: Object.assign(Object.create({ secret: true }), status) },
    { ...replies[3], status: { state: 'running', running: false, sessionId: 'synthetic-login' } },
    { ...replies[4], status: { state: 'succeeded', running: false } },
    { ...replies[7], result: { submitted: false, sessionId: 'synthetic-login' } },
    { ...replies[8], code: 'PROVIDER_FAILURE' }, { ...launch, toJSON() { return launch; } },
  ]) expect(parseNodeProviderAuthReply(invalid)).toBeNull();
  const cyclic: Record<string, unknown> = { ...launch }; cyclic.self = cyclic;
  expect(parseNodeProviderAuthReply(cyclic)).toBeNull();
});

test('native optional undefined fields normalize without sharing mutable login objects', () => {
  const source = { kind: 'provider-login-launched', instanceId, result: { launched: true, alreadyRunning: false,
    sessionId: 'synthetic-login', deviceAuth: { url: deviceAuth.url, code: undefined, needsCode: undefined } } } satisfies NodeProviderAuthReply;
  const captured = captureNodeProviderAuthReply(source);
  source.result.deviceAuth.url = 'https://changed.synthetic.invalid';
  expect(captured).toEqual({ kind: source.kind, instanceId, result: { launched: true, alreadyRunning: false, sessionId: 'synthetic-login', deviceAuth: { url: deviceAuth.url } } });
  expect(captureNodeProviderAuthReply({ kind: 'provider-login-status', instanceId, status: { state: 'running', running: true, sessionId: 'synthetic-login', deviceAuth: undefined } }))
    .toEqual({ kind: 'provider-login-status', instanceId, status: { state: 'running', running: true, sessionId: 'synthetic-login' } });
});

test('auth parsing and local capture reject accessors and proxies without reading them', () => {
  let reads = 0;
  const reply = { kind: 'provider-auth-status', instanceId,
    get status() { reads++; return { authenticated: true, canReauth: false, label: 'Synthetic', source: 'cli' as const }; },
  } satisfies NodeProviderAuthReply;
  expect(parseNodeProviderAuthReply(reply)).toBeNull();
  expect(captureNodeProviderAuthReply(reply)).toBeNull();
  expect(parseNodeProviderAuthCommand({ method: 'provider-auth', instanceId,
    get operation() { reads++; return 'status'; } })).toBeNull();
  expect(parseNodeProviderAuthReply(new Proxy(reply, { get() { reads++; return undefined; } }))).toBeNull();
  expect(reads).toBe(0);
});

test('capture bounds native status diagnostics while retaining authentication and strict wire limits', () => {
  const reply = { kind: 'provider-auth-status', instanceId, status: { authenticated: true, canReauth: false,
    source: 'cli', label: 'L'.repeat(2048), detail: '界'.repeat(20_000) } } satisfies NodeProviderAuthReply;
  expect(parseNodeProviderAuthReply(reply)).toBeNull();
  expect(captureNodeProviderAuthReply(reply)).toEqual({ ...reply, status: { ...reply.status, label: 'L'.repeat(1024), detail: '界'.repeat(4096) } });
  expect(reply.status.detail).toHaveLength(20_000);
});

test('undefined own fields are omitted recursively on every reply arm without weakening wire parsing', () => {
  for (const reply of replies) {
    const native = { ...reply, futureOptional: undefined };
    if ('status' in native && native.status) native.status = Object.assign({}, native.status, { futureOptional: undefined });
    if ('result' in native) native.result = Object.assign({}, native.result, { futureOptional: undefined });
    expect(parseNodeProviderAuthReply(native)).toBeNull();
    expect(captureNodeProviderAuthReply(native)).toEqual(reply);
    const invalid = { ...native, futureOptional: 'invalid' };
    expect(captureNodeProviderAuthReply(invalid)).toBeNull();
  }
});
