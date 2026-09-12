import { expect, mock, test } from 'bun:test';
import { NodeProviderCapacity } from '../../execution-node/provider-capacity.js';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { AgentAuthStatus } from '../../../common/agent-execution.js';
import type { ProviderAuthService } from '../provider-auth.js';
import { RemoteProviderAuthService } from '../remote-provider-auth.js';
import { NodeProviderAuthHost } from '../../execution-node/provider-auth-host.js';
import { NodeWorkerServiceClient, NodeWorkerServiceServer } from '../../execution-node/worker/service-channel.js';
import { parseNodeWorkerServiceText, type NodeWorkerServiceResult } from '../../execution-node/worker/service-protocol.js';
import { NodeWorkerWriter } from '../../execution-node/worker/writer.js';
import { NODE_WORKER_WRITER_LIMITS } from '../../execution-node/worker/limits.js';

const status = (label: string): AgentAuthStatus => ({ authenticated: true, canReauth: true, label, source: 'cli' });
const sessionId = 'same-native-login';

function fixture() {
  const deferred = Promise.withResolvers<AgentAuthStatus>();
  const native = (label: string) => ({
    status: mock(async () => status(label)),
    loginStatus: mock(async () => ({ state: 'running', running: true, sessionId } as const)),
    launchLogin: mock(async () => ({ launched: true, alreadyRunning: false, sessionId })),
    completeLogin: mock(async (request: { readonly sessionId: string; readonly code: string }) => ({ submitted: true, sessionId: request.sessionId } as const)),
  } satisfies ProviderAuthService);
  const first = native('First profile'); const second = native('Second profile');
  first.status.mockImplementation(() => deferred.promise);
  const hosts = new Map([['first', new NodeProviderAuthHost(new NodeProviderCapacity(), 'first', first)], ['second', new NodeProviderAuthHost(new NodeProviderCapacity(), 'second', second)]]);
  const cleanups: (() => void)[] = [];
  let connectionId = 0;
  const connect = () => {
    const physical = new AbortController();
    const failed = mock((error: unknown) => { physical.abort(error); });
    const options = { session: { controllerBootId: 'controller-boot', nodeBootId: 'node-boot', logicalSessionId: 'session' },
      connectionId: ++connectionId, signal: physical.signal, validate() {}, failed };
    const writerOptions = { ...NODE_WORKER_WRITER_LIMITS, signal: physical.signal,
      failed(error: unknown) { if (!physical.signal.aborted) failed(error); } };
    let alter: (reply: NodeWorkerServiceResult) => NodeWorkerServiceResult | null = (reply) => reply;
    const requests = new NodeWorkerWriter({ async write(bytes) {
      const frame = parseNodeWorkerServiceText(Buffer.from(bytes.subarray(4)).toString());
      if (!frame) throw new Error('Invalid synthetic auth request');
      server.receive(frame);
    }, close() {} }, writerOptions);
    const replies = new NodeWorkerWriter({ async write(bytes) {
      const frame = parseNodeWorkerServiceText(Buffer.from(bytes.subarray(4)).toString());
      if (!frame || frame.type !== 'node-worker-service-result') throw new Error('Invalid synthetic auth reply');
      const result = alter(frame.result);
      if (result) client.receive({ ...frame, result });
      else physical.abort(new Error('Synthetic lost reply'));
    }, close() {} }, writerOptions);
    const client = new NodeWorkerServiceClient(requests, options);
    const server = new NodeWorkerServiceServer(replies, async (command, signal) => {
      if (command.method !== 'provider-auth') return { kind: 'rejected', code: 'VALIDATION_FAILED' };
      const host = hosts.get(command.instanceId);
      return host ? host.execute(command, signal) : { kind: 'rejected', code: 'VALIDATION_FAILED' };
    }, options);
    cleanups.push(() => { physical.abort(); client.close(); server.close(); requests.close(); replies.close(); });
    return { physical, failed, auth: (instanceId: string) => new RemoteProviderAuthService(client, instanceId),
      alterReply(fn: typeof alter) { alter = fn; } };
  };
  return { first, second, deferred, connect, close() { deferred.resolve(status('First profile')); for (const close of cleanups) close(); } };
}

test('interleaved auth and colliding login identities remain on their captured instances', async () => {
  const f = fixture(); const connection = f.connect();
  try {
    const first = connection.auth('first'); const second = connection.auth('second');
    const pending = first.status(new AbortController().signal);
    expect(await second.status(new AbortController().signal)).toEqual(status('Second profile'));
    f.deferred.resolve(status('First profile'));
    expect(await pending).toEqual(status('First profile'));
    expect(await first.launchLogin()).toMatchObject({ sessionId });
    expect(await second.launchLogin()).toMatchObject({ sessionId });
    const input = { sessionId, code: 'synthetic-first-code' };
    const completed = first.completeLogin(input); input.code = 'synthetic-later-change';
    expect(await completed).toEqual({ submitted: true, sessionId });
    expect(await second.completeLogin({ sessionId, code: 'synthetic-second-code' })).toEqual({ submitted: true, sessionId });
    expect(f.first.completeLogin).toHaveBeenCalledWith({ sessionId, code: 'synthetic-first-code' });
    expect(f.second.completeLogin).toHaveBeenCalledWith({ sessionId, code: 'synthetic-second-code' });
    expect(connection.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test.each(['launch', 'complete'])('a lost %s reply stays unknown and is not resubmitted on reconnection', async (operation) => {
  const f = fixture(); const connection = f.connect();
  try {
    connection.alterReply(() => null);
    const auth = connection.auth('second');
    const pending = operation === 'launch' ? auth.launchLogin() : auth.completeLogin({ sessionId, code: 'synthetic-code' });
    await expect(pending).rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN', retryable: false });
    expect(connection.physical.signal.aborted).toBe(true);
    const next = f.connect().auth('second');
    expect(await next.loginStatus({ sessionId }, new AbortController().signal)).toEqual({ state: 'running', running: true, sessionId });
    expect(f.second.launchLogin).toHaveBeenCalledTimes(operation === 'launch' ? 1 : 0);
    expect(f.second.completeLogin).toHaveBeenCalledTimes(operation === 'complete' ? 1 : 0);
  } finally { f.close(); }
});

test('a foreign completion reply fails the physical channel without claiming non-delivery', async () => {
  const f = fixture(); const connection = f.connect();
  try {
    connection.alterReply((reply) => reply.kind === 'provider-login-completed'
      ? { ...reply, result: { ...reply.result, sessionId: 'foreign-login' } } : reply);
    await expect(connection.auth('second').completeLogin({ sessionId, code: 'synthetic-code' }))
      .rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN' });
    expect(connection.physical.signal.aborted).toBe(true);
    expect(f.second.completeLogin).toHaveBeenCalledTimes(1);
    expect(connection.failed).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('a foreign login poll cannot activate another session and leaves the physical channel usable', async () => {
  const f = fixture(); const connection = f.connect();
  try {
    await expect(connection.auth('second').loginStatus({ sessionId: 'foreign-login' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    expect(connection.physical.signal.aborted).toBe(false);
    expect(await connection.auth('second').loginStatus({ sessionId }, new AbortController().signal))
      .toEqual({ state: 'running', running: true, sessionId });
    expect(connection.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('auth cancellation and native refusals keep their distinct outcomes', async () => {
  const f = fixture(); const connection = f.connect();
  try {
    const cancellation = new AbortController();
    const pending = connection.auth('first').status(cancellation.signal);
    const reason = new Error('Synthetic auth cancellation'); cancellation.abort(reason);
    await expect(pending).rejects.toBe(reason);
    for (const code of ['OPERATION_UNSUPPORTED', 'AUTH_LOGIN_SESSION_MISMATCH'] as const) {
      f.second.completeLogin.mockImplementationOnce(async () => { throw new AgentIntegrationError(code, 'Synthetic private error body', false); });
      await expect(connection.auth('second').completeLogin({ sessionId, code: 'synthetic-code' })).rejects.toMatchObject({ code, retryable: false });
    }
    expect(connection.physical.signal.aborted).toBe(false);
    await expect(connection.auth('foreign').status(new AbortController().signal)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
  } finally { f.close(); }
});
