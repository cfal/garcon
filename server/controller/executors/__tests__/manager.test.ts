import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { connectNoiseWebSocket, createNoiseServer, type NoiseServerOptions } from '@cfal/noise-ws';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExecutorManager } from '../manager.js';
import { WebSocketLink, EXECUTOR_NOISE_CONTEXT } from '../../../remote/transport/websocket-link.js';
import { ExecutorRpc, type GuardRpcReply } from '../../../remote/transport/rpc.js';
import { serveExecutionRuntime } from '../../../remote/server/executor-rpc-server.js';
import { ProducerRelay } from '../../../remote/server/producer-relay.js';
import { integrationFixture } from '../../../remote/__tests__/integration-fixture.js';
import { executorConnectionUrl } from '../../../remote/transport/connection-url.js';
import { DomainError } from '../../../common/domain-error.js';
import { createServerSocketHandlers, type WsConnectionData } from '../../ws/server-sockets.js';
import { PrimarySocketDelivery } from '../../ws/primary-delivery.js';
import { WebSocketAdmissionController } from '../../../common/websocket-capacity.js';
import { ControllerCliDispatcher, type CliDispatchAccess } from '../cli-dispatcher.js';
import { connectWithOwnRole, connectWithWrongKey, sendMalformedRecord } from '../../../remote/__tests__/failing-peers.js';
import { tcpLinkProxy } from '../../../remote/__tests__/tcp-link-proxy.js';
import type { Logger } from '../../../common/log.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(logger?: Logger) {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'executor-manager-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const manager = await ExecutorManager.create({
    id: 'local', workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null,
  }, logger);
  cleanups.push(() => manager.dispose());
  return { root, manager };
}

test('grant-only updates do not require idle or replace the connector', async () => {
  const { manager } = await fixture();
  const executor = await manager.create({ direction: 'executor-connects', label: 'Worker' });
  const original = manager.inboundLink(executor.id);
  const assertIdle = mock(() => { throw new Error('busy'); });
  manager.setGuards({ assertIdle, assertRemovable: () => {} });
  await manager.update(executor.id, { allowControllerCli: true });
  expect(manager.inboundLink(executor.id)).toBe(original);
  expect(manager.list().find((value) => value.id === executor.id)?.allowControllerCli).toBe(true);
  await manager.update(executor.id, { allowExecutorManagement: true });
  expect(manager.inboundLink(executor.id)).toBe(original);
  expect(manager.list().find((value) => value.id === executor.id)?.allowExecutorManagement).toBe(true);
  expect(assertIdle).not.toHaveBeenCalled();
});

test('management admission is checked after waiting for a preceding configuration mutation', async () => {
  const { manager } = await fixture();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const original = manager.config.create.bind(manager.config);
  const held = spyOn(manager.config, 'create').mockImplementationOnce(async (request) => {
    entered.resolve(); await gate.promise; return original(request);
  });
  const first = manager.create({ label: 'First', direction: 'executor-connects' });
  await entered.promise;
  let allowed = true;
  const pending = manager.create({ label: 'Denied', direction: 'executor-connects' }, { assertCurrent: () => {
    if (!allowed) throw new DomainError('CLI_ACCESS_DENIED', 'Revoked', 403);
  } });
  const outcome = pending.catch((error: unknown) => error);
  allowed = false;
  gate.resolve();
  try { await first; expect(await outcome).toMatchObject({ code: 'CLI_ACCESS_DENIED' }); expect(manager.config.list().map((entry) => entry.label)).toEqual(['First']); }
  finally { gate.resolve(); held.mockRestore(); }
});

function waitReady(manager: ExecutorManager, id: string): Promise<void> {
  if (manager.isReady(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const off = manager.onAvailabilityChanged((executorId, value) => {
      if (executorId === id && value === 'ready') { off(); resolve(); }
    });
  });
}

function worker(secret: string, projectPath: string, configure: (fixture: ReturnType<typeof integrationFixture>) => void = () => {}) {
  const link = new WebSocketLink({ role: 'worker', secret, noTls: true, redialDelaysMs: [20] });
  cleanups.push(() => link.dispose());
  link.onSession((transport) => {
    const provider = integrationFixture(projectPath, transport.executorId);
    configure(provider);
    const serving = serveExecutionRuntime(provider.executor, new ExecutorRpc(transport), new ProducerRelay());
    cleanups.push(() => serving.dispose());
  });
  return link;
}

test('reverse CLI dispatch checks initialization, executor grant, revocation lease and quiescence on the live link', async () => {
  const { manager, root } = await fixture();
  const config = await manager.create({ label: 'CLI worker', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  const link = new WebSocketLink({ role: 'worker', secret: config.secret, noTls: true });
  cleanups.push(() => link.dispose());
  const connected = Promise.withResolvers<ExecutorRpc>();
  link.onSession((transport) => {
    const rpc = new ExecutorRpc(transport);
    const serving = serveExecutionRuntime(integrationFixture(root, transport.executorId).executor, rpc, new ProducerRelay());
    cleanups.push(() => serving.dispose());
    connected.resolve(rpc);
  });
  link.dial(url(config.id));
  const rpc = await connected.promise;
  await waitReady(manager, config.id);
  await expect(rpc.call('', 'controllerCli.describe', null)).rejects.toMatchObject({ code: 'CLI_ACCESS_DENIED' });
  await manager.update(config.id, { allowControllerCli: true });
  await expect(rpc.call('', 'controllerCli.describe', null)).rejects.toMatchObject({ code: 'CLI_CONTROLLER_UNAVAILABLE' });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  manager.setCliDispatcher(new ControllerCliDispatcher({ serverInstanceId: 'controller', workspaceName: 'workspace',
    isShuttingDown: () => false, routes: { '/api/v1/chats/run': { POST: async () => {
      calls++; entered.resolve(); await release.promise; return Response.json({ confirmed: true });
    } } } }));
  const request = { expectedServerInstanceId: 'controller', http: { operation: 'POST /api/v1/chats/run' as const, query: [], body: {} } };
  try {
    expect(await rpc.call('', 'controllerCli.describe', null)).toMatchObject({ defaultExecutorId: config.id });
    await expect(rpc.call('forged-provider', 'controllerCli.request', request)).rejects.toMatchObject({ code: 'CLI_ACCESS_DENIED' });
    const pending = rpc.call('', 'controllerCli.request', request);
    const result = Promise.allSettled([pending]);
    await entered.promise;
    await manager.update(config.id, { allowControllerCli: false });
    await manager.update(config.id, { allowControllerCli: true });
    release.resolve();
    expect(await result).toMatchObject([{ status: 'rejected', reason: { code: 'CLI_OUTCOME_UNKNOWN' } }]);
    expect(await rpc.call('', 'controllerCli.describe', null)).toMatchObject({ defaultExecutorId: config.id });
    expect(calls).toBe(1);
    expect(link.current).toBe(rpc.transport);
    manager.quiesce();
    await expect(rpc.call('', 'controllerCli.describe', null)).rejects.toMatchObject({ code: 'CLI_CONTROLLER_UNAVAILABLE' });
  } finally { release.resolve(); }
});

test.each(['context', 'read', 'mutation'] as const)('quiescence after handler settlement fences Noise RPC publication: %s', async (operation) => {
  const { manager, root } = await fixture();
  const config = await manager.create({ label: 'CLI worker', direction: 'executor-connects', allowControllerCli: true });
  const { url } = sharedListener(manager);
  const link = new WebSocketLink({ role: 'worker', secret: config.secret, noTls: true });
  cleanups.push(() => link.dispose());
  const connected = Promise.withResolvers<ExecutorRpc>();
  link.onSession((transport) => {
    const rpc = new ExecutorRpc(transport);
    const serving = serveExecutionRuntime(integrationFixture(root, transport.executorId).executor, rpc, new ProducerRelay());
    cleanups.push(() => serving.dispose());
    connected.resolve(rpc);
  });
  link.dial(url(config.id));
  const rpc = await connected.promise;
  await waitReady(manager, config.id);
  class QuiescingDispatcher extends ControllerCliDispatcher {
    override describe(access: CliDispatchAccess, guardReply: GuardRpcReply) {
      const context = super.describe(access, guardReply);
      manager.quiesce();
      return context;
    }
    override async request(value: unknown, access: CliDispatchAccess, guardReply: GuardRpcReply) {
      const reply = await super.request(value, access, guardReply);
      manager.quiesce();
      return reply;
    }
  }
  manager.setCliDispatcher(new QuiescingDispatcher({ serverInstanceId: 'controller', workspaceName: null, isShuttingDown: () => false,
    routes: { '/api/v1/chats': { GET: () => Response.json({ privateData: true }) },
      '/api/v1/chats/run': { POST: () => Response.json({ committed: true }) } } }));
  const pending = operation === 'context' ? rpc.call('', 'controllerCli.describe', null)
    : rpc.call('', 'controllerCli.request', { expectedServerInstanceId: 'controller', http: {
      operation: operation === 'mutation' ? 'POST /api/v1/chats/run' : 'GET /api/v1/chats',
      query: [], body: operation === 'mutation' ? {} : null,
    } });
  await expect(pending).rejects.toMatchObject({ code: operation === 'mutation' ? 'CLI_OUTCOME_UNKNOWN' : 'CLI_CONTROLLER_UNAVAILABLE' });
});

function sharedListener(manager: ExecutorManager, limits?: NoiseServerOptions) {
  const primary = {
    open: mock(() => {}), message: mock(async () => {}), close: mock(() => {}), drain: mock(() => {}),
  } satisfies Parameters<typeof createServerSocketHandlers>[0]['primary'];
  const noise = createNoiseServer(limits);
  const server = Bun.serve<WsConnectionData>({
    hostname: '0.0.0.0', port: 0,
    fetch(request, server) {
      const link = manager.inboundLink(new URL(request.url).pathname.split('/')[2]!);
      if (!link) return new Response(null, { status: 404 });
      return link.upgrade(request, server, noise);
    },
    websocket: createServerSocketHandlers({
      primary, admission: new WebSocketAdmissionController(1),
      config: { wsIdleTimeoutSeconds: 60, wsBackpressureLimit: 1024, wsMaxPayloadLength: 1024 },
      logger: { error: () => {} }, execution: noise.websocket,
      delivery: new PrimarySocketDelivery(1024),
    }),
  });
  cleanups.push(async () => { noise.close(); server.stop(true); });
  return { noise, primary, url: (id: string) => `ws://127.0.0.1:${server.port}/executor/${id}` };
}

async function pendingSocket(url: string) {
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => opened.resolve());
  socket.addEventListener('close', () => closed.resolve());
  socket.addEventListener('error', () => opened.reject(new Error('Unexpected socket rejection')));
  cleanups.push(async () => { socket.close(); await closed.promise; });
  await opened.promise;
  return { socket, closed: closed.promise };
}

test('offline configuration never blocks Local or fabricates remote inventory', async () => {
  const { manager, root } = await fixture();
  const configured = await manager.create({ label: 'Offline', direction: 'executor-connects' });
  expect(manager.isReady('local')).toBe(true);
  expect(manager.isReady(configured.id)).toBe(false);
  expect(manager.knownIntegration({ executorId: configured.id, agentId: 'test' })).toBeNull();
  expect(manager.list()[1]).toMatchObject({ id: configured.id, availability: 'offline', projectBasePath: null });
  expect(JSON.stringify(manager.list())).not.toContain(configured.secret);
  expect((await manager.inspectProject(root)).kind).toBe('available');
  await expect(manager.inspectProject(root, configured.id)).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
  await expect(manager.inspectProject(root, crypto.randomUUID())).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
});

test('connector replacement retains provider checks but accepts a new project base', async () => {
  const { manager, root } = await fixture();
  const narrow = join(root, 'narrow');
  await mkdir(narrow);
  const config = await manager.create({ label: 'Changing root', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  const first = worker(config.secret, narrow);
  first.dial(url(config.id));
  await waitReady(manager, config.id);
  const previous = manager.list().find((item) => item.id === config.id)!;
  await manager.update(config.id, { enabled: false });
  await first.dispose();
  await manager.update(config.id, { enabled: true });
  const replacement = worker(config.secret, root);
  replacement.dial(url(config.id));
  await waitReady(manager, config.id);
  const accepted = manager.list().find((item) => item.id === config.id)!;
  expect(accepted).toMatchObject({ projectBasePath: root, availability: 'ready', lastError: null });
  expect(accepted.instanceId).not.toBe(previous.instanceId);
  await manager.update(config.id, { enabled: false });
  await replacement.dispose();
  await manager.update(config.id, { enabled: true });
  const rejected = Promise.withResolvers<void>();
  const off = manager.onChanged(() => {
    if (manager.list().find((item) => item.id === config.id)?.lastError) rejected.resolve();
  });
  const incompatible = worker(config.secret, narrow, (provider) => { provider.integration.descriptor.label = 'Incompatible'; });
  incompatible.dial(url(config.id));
  await rejected.promise;
  off();
  // Setup closes the session after reporting why, and the closure keeps that report.
  expect(manager.list().find((item) => item.id === config.id)?.lastError?.message).not.toContain('Executor connection lost');
  expect(manager.list().find((item) => item.id === config.id)).toMatchObject({
    projectBasePath: root, instanceId: accepted.instanceId, availability: 'offline',
    lastError: { message: expect.stringContaining('provider inventory changed') },
  });
  expect(manager.isReady('local')).toBe(true);
});

test('manager readiness waits for replacement metadata publication', async () => {
  const { manager, root } = await fixture();
  const config = await manager.create({ label: 'Metadata', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  const first = worker(config.secret, root);
  first.dial(url(config.id));
  await waitReady(manager, config.id);
  const executor = manager.requireExecutor(config.id);
  const original = executor.getInfo.bind(executor);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pending = spyOn(executor, 'getInfo').mockImplementation(async () => {
    const info = await original();
    entered.resolve();
    await release.promise;
    return info;
  });
  try {
    await first.dispose();
    const replacement = worker(config.secret, '/');
    replacement.dial(url(config.id));
    await entered.promise;
    expect(executor.availability).toBe('ready');
    expect(manager.isReady(config.id)).toBe(false);
    expect(manager.list().find((item) => item.id === config.id)?.projectBasePath).toBe(root);
    const ready = waitReady(manager, config.id);
    release.resolve();
    await ready;
    expect(manager.list().find((item) => item.id === config.id)?.projectBasePath).toBe('/');
  } finally { release.resolve(); pending.mockRestore(); }
});

test('a reconnecting executor holds calls instead of reporting itself unavailable', async () => {
  const { manager, root } = await fixture();
  const config = await manager.create({ label: 'Reconnecting', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  const link = new WebSocketLink({ role: 'worker', secret: config.secret, noTls: true, redialDelaysMs: [20] });
  cleanups.push(() => link.dispose());
  const relay = new ProducerRelay();
  let provider: ReturnType<typeof integrationFixture> | null = null;
  link.onSession((transport) => {
    // One worker process keeps its instance across sessions.
    provider ??= integrationFixture(root, transport.executorId);
    const serving = serveExecutionRuntime(provider.executor, new ExecutorRpc(transport), relay);
    cleanups.push(() => serving.dispose());
  });
  link.dial(url(config.id));
  await waitReady(manager, config.id);
  const executor = manager.requireExecutor(config.id);
  const reconnecting = new Promise<void>((resolve) => {
    const off = manager.onAvailabilityChanged((executorId, value) => {
      if (executorId === config.id && value === 'reconnecting') { off(); resolve(); }
    });
  });
  link.disconnect();
  await reconnecting;

  expect(manager.isReady(config.id)).toBe(false);
  expect(manager.requireExecutor(config.id)).toBe(executor);
  expect(manager.integrationsFor(config.id).get('test')).not.toBeNull();
  expect((await manager.inspectProject(root, config.id)).kind).toBe('available');
  expect(manager.isReady(config.id)).toBe(true);
});

test('two inbound workers share one listener and keep distinct integration/resource scopes', async () => {
  const { manager, root } = await fixture();
  const first = await manager.create({ label: 'First', direction: 'executor-connects' });
  const second = await manager.create({ label: 'Second', direction: 'executor-connects' });
  const { primary, url } = sharedListener(manager);
  const ready = [waitReady(manager, first.id), waitReady(manager, second.id)];
  const workerA = worker(first.secret, root);
  const workerB = worker(second.secret, root);
  workerA.dial(url(first.id));
  workerB.dial(url(second.id));
  await Promise.all(ready);
  const integrationA = manager.requireIntegration({ executorId: first.id, agentId: 'test' });
  const integrationB = manager.requireIntegration({ executorId: second.id, agentId: 'test' });
  expect(integrationA).not.toBe(integrationB);
  expect(integrationA.producers.scope.executorId).toBe(first.id);
  expect(integrationB.producers.scope.executorId).toBe(second.id);
  const scope = integrationA.producers.scope;
  await manager.update(first.id, { label: 'Renamed' });
  expect(manager.requireIntegration({ executorId: first.id, agentId: 'test' }).producers.scope).toEqual(scope);
  await manager.update(first.id, { enabled: false });
  expect(manager.isReady(first.id)).toBe(false);
  expect(manager.isReady(second.id)).toBe(true);
  expect(manager.isReady('local')).toBe(true);
  expect(manager.inboundLink(first.id)).toBeNull();
  expect(primary.open).not.toHaveBeenCalled();
  expect(primary.message).not.toHaveBeenCalled();
  expect(primary.close).not.toHaveBeenCalled();
});

test('shared Noise admission includes pending handshakes and releases them on disable, delete and quiesce', async () => {
  const { manager } = await fixture();
  const first = await manager.create({ label: 'First', direction: 'executor-connects' });
  const second = await manager.create({ label: 'Second', direction: 'executor-connects' });
  const { noise, url } = sharedListener(manager, { maxConnections: 4, maxPendingHandshakes: 2 });
  const a = await pendingSocket(url(first.id));
  const b = await pendingSocket(url(second.id));
  expect(noise.size).toBe(2);
  expect((await fetch(url(second.id).replace('ws:', 'http:'))).status).toBe(503);
  await manager.update(first.id, { enabled: false });
  await a.closed;
  expect(noise.size).toBe(1);
  expect((await fetch(url(first.id).replace('ws:', 'http:'))).status).toBe(404);
  const c = await pendingSocket(url(second.id));
  await manager.remove(second.id);
  await Promise.all([b.closed, c.closed]);
  expect(noise.size).toBe(0);
  await manager.update(first.id, { enabled: true });
  const d = await pendingSocket(url(first.id));
  manager.quiesce();
  await d.closed;
  expect(noise.size).toBe(0);
  expect(manager.inboundLink(first.id)).toBeNull();
});

test('key rotation closes established and pending old-key sockets without affecting the replacement', async () => {
  const { manager, root } = await fixture();
  const executor = await manager.create({ label: 'Rotating', direction: 'executor-connects' });
  const { noise, url } = sharedListener(manager);
  const oldLink = manager.inboundLink(executor.id)!;
  const original = worker(executor.secret, root);
  const ready = waitReady(manager, executor.id);
  original.dial(url(executor.id));
  await ready;
  const scope = manager.requireIntegration({ executorId: executor.id, agentId: 'test' }).producers.scope;
  const pending = await pendingSocket(url(executor.id));
  expect(noise.size).toBe(2);
  const replacementSecret = Buffer.alloc(32, 19).toString('base64url');
  await manager.update(executor.id, { connection: {
    direction: 'executor-connects', connectionUrl: executorConnectionUrl(url(executor.id), replacementSecret), noTls: true,
  } });
  await pending.closed;
  await original.dispose();
  expect(noise.size).toBe(0);
  expect(oldLink.acceptsSocket).toBe(false);
  const stale = connectNoiseWebSocket(url(executor.id), {
    psk: Buffer.from(executor.secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT, onMessage() {},
  });
  await stale.closed;
  expect(manager.isReady(executor.id)).toBe(false);
  const replacement = worker(replacementSecret, root);
  const replaced = waitReady(manager, executor.id);
  replacement.dial(url(executor.id));
  await replaced;
  expect(manager.requireIntegration({ executorId: executor.id, agentId: 'test' }).producers.scope).not.toEqual(scope);
  expect(noise.size).toBe(1);
});

test('logs failed executor connections at powers of two per kind but shows every one', async () => {
  const warnings: unknown[][] = [];
  const { manager, root } = await fixture({ debug() {}, info() {}, warn: (...args) => { warnings.push(args); }, error() {} });
  const config = await manager.create({ label: 'Probed', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  const failures = () => warnings.filter(([message]) => message === 'Executor link failed').map(([, fields]) => fields);
  const wrongKey = 'Executor encrypted connection failed (AUTHENTICATION_FAILED)';
  const malformed = 'Executor encrypted connection failed (PROTOCOL_ERROR)';
  for (let attempt = 0; attempt < 2; attempt++) {
    await connectWithWrongKey(url(config.id));
    await sendMalformedRecord(url(config.id));
  }
  await connectWithWrongKey(url(config.id));

  const logged = (message: string, count: number) => ({ executorId: config.id, message, count });
  expect(failures()).toEqual([logged(wrongKey, 1), logged(malformed, 1), logged(wrongKey, 2), logged(malformed, 2)]);
  // The third wrong key was not logged, but it is the latest failure.
  expect(manager.list().find((item) => item.id === config.id)?.lastError).toEqual({ code: 'EXECUTOR_UNAVAILABLE', message: wrongKey });

  const ready = waitReady(manager, config.id);
  worker(config.secret, root).dial(url(config.id));
  await ready;
  await connectWithWrongKey(url(config.id));
  expect(failures().slice(4)).toEqual([logged(wrongKey, 1)]);
});

test('logs each closed executor session with its cause and reason', async () => {
  const closures: unknown[] = [];
  const closed = Promise.withResolvers<void>();
  const { manager, root } = await fixture({
    debug() {}, info() {}, error() {},
    warn: (message, fields) => {
      if (message !== 'Executor link closed') return;
      closures.push(fields);
      closed.resolve();
    },
  });
  const config = await manager.create({ label: 'Retiring', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  const ready = waitReady(manager, config.id);
  worker(config.secret, root).dial(url(config.id));
  await ready;
  manager.inboundLink(config.id)!.current!.close(new Error('Synthetic session retirement'));
  await closed.promise;

  expect(closures).toEqual([{ executorId: config.id, cause: 'session-retired', count: 1, reason: 'Synthetic session retirement' }]);
});

test('logs failed connections alongside a ready executor without showing them as its error', async () => {
  const warnings: unknown[][] = [];
  const { manager, root } = await fixture({ debug() {}, info() {}, warn: (...args) => { warnings.push(args); }, error() {} });
  const config = await manager.create({ label: 'Connected', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  const ready = waitReady(manager, config.id);
  worker(config.secret, root).dial(url(config.id));
  await ready;
  let changes = 0;
  manager.onChanged(() => { changes++; });
  await connectWithWrongKey(url(config.id));
  await sendMalformedRecord(url(config.id));

  expect(warnings.filter(([message]) => message === 'Executor link failed')).toHaveLength(2);
  expect(manager.list().find((item) => item.id === config.id)).toMatchObject({ availability: 'ready', lastError: null });
  expect(changes).toBe(0);
});

test('keeps a connection failure off an executor whose disruptive update fails to persist', async () => {
  const { manager, root } = await fixture();
  const config = await manager.create({ label: 'Retained', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  const ready = waitReady(manager, config.id);
  worker(config.secret, root).dial(url(config.id));
  await ready;
  // Admitted before the update stops the link from accepting sockets.
  const pending = await pendingSocket(url(config.id));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = spyOn(manager.config, 'update').mockImplementation(async (id, _request, assertUpdateAllowed) => {
    const previous = manager.config.require(id);
    assertUpdateAllowed?.(previous, { ...previous, enabled: false });
    entered.resolve();
    await release.promise;
    throw new Error('Synthetic write failure');
  });
  try {
    const mutation = manager.update(config.id, { enabled: false }).catch((error: unknown) => error);
    await entered.promise;
    pending.socket.send(new Uint8Array(8));
    await pending.closed;
    release.resolve();
    expect(await mutation).toBeInstanceOf(Error);

    expect(manager.list().find((item) => item.id === config.id)).toMatchObject({ availability: 'ready', lastError: null });
  } finally {
    release.resolve();
    write.mockRestore();
  }
});

test('shows a link failure with its reason', async () => {
  const { manager } = await fixture();
  const config = await manager.create({ label: 'Mistaken', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  await connectWithOwnRole(url(config.id), config.secret);

  expect(manager.list().find((item) => item.id === config.id)?.lastError).toEqual({
    code: 'EXECUTOR_UNAVAILABLE', message: 'Executor authentication failed: Executor handshake mismatch',
  });
});

test('shows why a ready executor lost its own session', async () => {
  const { manager, root } = await fixture();
  const config = await manager.create({ label: 'Tunneled', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  const path = await tcpLinkProxy(new URL(url(config.id)));
  cleanups.push(() => path.close());
  const ready = waitReady(manager, config.id);
  worker(config.secret, root).dial(path.url);
  await ready;
  const reconnecting = new Promise<void>((resolve) => {
    const off = manager.onAvailabilityChanged((executorId, value) => {
      if (executorId === config.id && value === 'reconnecting') { off(); resolve(); }
    });
  });
  // A tunnel drop: no WebSocket close and no encrypted close record, and no redial gets through.
  path.refuseConnections();
  path.disconnect();
  await reconnecting;

  expect(manager.list().find((item) => item.id === config.id)).toMatchObject({
    availability: 'reconnecting',
    lastError: { code: 'EXECUTOR_UNAVAILABLE', message: 'Executor connection lost: Encrypted connection failed (TRANSPORT_CLOSED)' },
  });
});

test('publishes an executor error only when it changes', async () => {
  const { manager } = await fixture();
  const config = await manager.create({ label: 'Probed', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  let changes = 0;
  manager.onChanged(() => { changes++; });
  await connectWithWrongKey(url(config.id));
  // Past the notice interval, a repeat of the same failure would publish at once.
  await Bun.sleep(1_100);
  await connectWithWrongKey(url(config.id));

  expect(changes).toBe(1);
  expect(manager.list().find((item) => item.id === config.id)?.lastError).toEqual({
    code: 'EXECUTOR_UNAVAILABLE', message: 'Executor encrypted connection failed (AUTHENTICATION_FAILED)',
  });
});

test('publishes alternating link failures at most once a second, each time with the latest', async () => {
  const { manager } = await fixture();
  const config = await manager.create({ label: 'Probed', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  const published: { readonly at: number; readonly message: string | undefined }[] = [];
  const lastError = () => manager.list().find((item) => item.id === config.id)?.lastError;
  manager.onChanged(() => { published.push({ at: performance.now(), message: lastError()?.message }); });
  for (let attempt = 0; attempt < 3; attempt++) {
    await connectWithWrongKey(url(config.id));
    await sendMalformedRecord(url(config.id));
  }
  const malformed = 'Executor encrypted connection failed (PROTOCOL_ERROR)';
  const deadline = performance.now() + 4_000;
  while (published.at(-1)?.message !== malformed && performance.now() < deadline) await Bun.sleep(20);

  expect(published.at(-1)).toEqual({ at: expect.any(Number), message: malformed });
  for (let index = 1; index < published.length; index++) {
    expect(published[index]!.at - published[index - 1]!.at).toBeGreaterThanOrEqual(990);
  }
  expect(published.length).toBeLessThan(6);
});

test('admits a worker while sockets that never finish their handshakes fill its executor slots', async () => {
  const { manager, root } = await fixture();
  const config = await manager.create({ label: 'Crowded', direction: 'executor-connects' });
  const { url } = sharedListener(manager);
  for (let index = 0; index < 4; index++) await pendingSocket(url(config.id));
  const ready = waitReady(manager, config.id);
  worker(config.secret, root).dial(url(config.id));

  // The silent sockets would otherwise hold the slots until their five-second handshake deadline.
  await Promise.race([ready, Bun.sleep(2_000).then(() => { throw new Error('The worker was not admitted'); })]);
});

test('the aggregate Noise connection limit covers authenticated peers across executors', async () => {
  const { manager } = await fixture();
  const a = await manager.create({ label: 'A', direction: 'executor-connects' });
  const b = await manager.create({ label: 'B', direction: 'executor-connects' });
  const { noise, url } = sharedListener(manager, { maxConnections: 2, maxPendingHandshakes: 2 });
  const sockets = [];
  for (const executor of [a, b]) {
    const socket = connectNoiseWebSocket(url(executor.id), {
      psk: Buffer.from(executor.secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT, onMessage() {},
    });
    cleanups.push(async () => { socket.close(); await socket.closed; });
    await socket.ready;
    sockets.push(socket);
  }
  expect(noise.size).toBe(2);
  expect((await fetch(url(a.id).replace('ws:', 'http:'))).status).toBe(503);
  await manager.remove(b.id);
  await sockets[1]!.closed;
  expect(noise.size).toBe(1);
  expect((await fetch(url(a.id).replace('ws:', 'http:'))).status).toBe(400);
  expect(noise.size).toBe(1);
});

test('outbound executor initializes independently and mutation guards retain configuration', async () => {
  const { manager, root } = await fixture();
  const secret = Buffer.alloc(32, 5).toString('base64url');
  const remote = worker(secret, root);
  const connectionUrl = executorConnectionUrl(remote.listen(), secret);
  const configured = await manager.create({ direction: 'controller-connects', label: 'Outbound', connectionUrl, noTls: true });
  await waitReady(manager, configured.id);
  expect((await manager.inspectProject(root, configured.id)).kind).toBe('available');
  manager.setGuards({
    assertIdle() { throw new DomainError('EXECUTOR_IN_USE', 'Stop running work first', 409); },
    assertRemovable() {},
  });
  await expect(manager.update(configured.id, { enabled: false })).rejects.toMatchObject({ status: 409 });
  expect(manager.isReady(configured.id)).toBe(true);
  await manager.update(configured.id, { label: 'Safe rename' });
  manager.setGuards({ assertIdle() {}, assertRemovable() { throw new DomainError('EXECUTOR_IN_USE', 'Pending ownership change', 409); } });
  await expect(manager.remove(configured.id)).rejects.toMatchObject({ status: 409 });
  expect(manager.config.require(configured.id).label).toBe('Safe rename');
});

test('retained connections publish ready after a disruptive update fails to persist', async () => {
  const { manager, root } = await fixture();
  const secret = Buffer.alloc(32, 6).toString('base64url');
  const remote = worker(secret, root);
  const configured = await manager.create({
    direction: 'controller-connects', label: 'Retained',
    connectionUrl: executorConnectionUrl(remote.listen(), secret), noTls: true,
  });
  await waitReady(manager, configured.id);
  const integration = manager.requireIntegration({ executorId: configured.id, agentId: 'test' });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = spyOn(manager.config, 'update').mockImplementation(async (id, _request, assertUpdateAllowed) => {
    const previous = manager.config.require(id);
    assertUpdateAllowed?.(previous, { ...previous, enabled: false });
    entered.resolve();
    await release.promise;
    throw new Error('Synthetic write failure');
  });
  try {
    const mutation = manager.update(configured.id, { enabled: false }).catch((error: unknown) => error);
    await entered.promise;
    expect(manager.isReady(configured.id)).toBe(false);
    const ready = waitReady(manager, configured.id);
    release.resolve();
    const result = await mutation;
    expect(result).toBeInstanceOf(Error);
    await ready;
    expect(manager.isReady(configured.id)).toBe(true);
    expect(manager.requireIntegration({ executorId: configured.id, agentId: 'test' })).toBe(integration);
  } finally {
    release.resolve();
    write.mockRestore();
  }
});

test('advertised URL and unchanged connector edits stay available while busy', async () => {
  const { manager, root } = await fixture();
  const config = await manager.create({ direction: 'executor-connects', label: 'Busy worker' });
  const { url } = sharedListener(manager);
  worker(config.secret, root).dial(url(config.id));
  await waitReady(manager, config.id);
  const original = manager.inboundLink(config.id);
  const assertIdle = mock(() => { throw new DomainError('EXECUTOR_IN_USE', 'Busy', 409); });
  manager.setGuards({ assertIdle, assertRemovable() {} });
  const observations: boolean[] = [];
  const update = manager.config.update.bind(manager.config);
  const write = spyOn(manager.config, 'update').mockImplementation((id, request, assertUpdateAllowed) => (
    update(id, request, (previous, next) => {
      assertUpdateAllowed?.(previous, next);
      observations.push(manager.isReady(id));
    })
  ));
  try {
    const connection = {
      direction: 'executor-connects' as const,
      connectionUrl: executorConnectionUrl(`wss://controller.example/executor/${config.id}`, config.secret),
      noTls: false,
    };
    await manager.update(config.id, { connection });
    await manager.update(config.id, { connection, enabled: true });
    expect(observations).toEqual([true, true]);
    expect(manager.inboundLink(config.id)).toBe(original);
    expect(manager.isReady(config.id)).toBe(true);
    expect(manager.config.require(config.id).connection).toEqual({
      kind: 'executor-connects', advertisedUrl: `wss://controller.example/executor/${config.id}`,
    });
    expect(assertIdle).not.toHaveBeenCalled();
    await expect(manager.update(config.id, { connection: { ...connection, noTls: true } }))
      .rejects.toMatchObject({ code: 'EXECUTOR_IN_USE' });
    expect(manager.isReady(config.id)).toBe(true);
  } finally { write.mockRestore(); }
});
