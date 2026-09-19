import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExecutionNodeManager } from '../manager.js';
import { WebSocketLink } from '../websocket-link.js';
import { AgentRpc } from '../rpc.js';
import { serveAgentNode } from '../agent-worker.js';
import { integrationFixture } from './integration-fixture.js';
import { nodeConnectionUrl } from '../connection-url.js';
import { DomainError } from '../../lib/domain-error.js';
import { createServerSocketHandlers, type WsConnectionData } from '../../ws/server-sockets.js';
import { WebSocketAdmissionController } from '../../lib/websocket-capacity.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'node-manager-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const manager = await ExecutionNodeManager.create({
    id: 'local', workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null,
  });
  cleanups.push(() => manager.dispose());
  return { root, manager };
}

function waitReady(manager: ExecutionNodeManager, id: string): Promise<void> {
  if (manager.isReady(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const off = manager.onAvailabilityChanged((nodeId, value) => {
      if (nodeId === id && value === 'ready') { off(); resolve(); }
    });
  });
}

function worker(secret: string, projectPath: string) {
  const link = new WebSocketLink({ role: 'worker', secret, allowInsecureDevelopment: true, reconnectDelayMs: 20 });
  cleanups.push(() => link.dispose());
  link.onSession((transport) => {
    const provider = integrationFixture(projectPath, transport.nodeId);
    const serving = serveAgentNode(provider.node, new AgentRpc(transport));
    cleanups.push(() => serving.dispose());
  });
  return link;
}

test('offline configuration never blocks Local or fabricates remote inventory', async () => {
  const { manager, root } = await fixture();
  const configured = await manager.create({ label: 'Offline', direction: 'node-connects' });
  expect(manager.isReady('local')).toBe(true);
  expect(manager.isReady(configured.id)).toBe(false);
  expect(manager.knownIntegration({ nodeId: configured.id, agentId: 'test' })).toBeNull();
  expect(manager.list()[1]).toMatchObject({ id: configured.id, availability: 'offline', projectBasePath: null });
  expect(JSON.stringify(manager.list())).not.toContain(configured.secret);
  expect((await manager.inspectProject(root)).kind).toBe('available');
  await expect(manager.inspectProject(root, configured.id)).rejects.toMatchObject({ code: 'EXECUTION_NODE_UNAVAILABLE' });
  await expect(manager.inspectProject(root, crypto.randomUUID())).rejects.toMatchObject({ code: 'EXECUTION_NODE_UNAVAILABLE' });
});

test('two inbound workers share one listener and keep distinct integration/resource scopes', async () => {
  const { manager, root } = await fixture();
  const first = await manager.create({ label: 'First', direction: 'node-connects' });
  const second = await manager.create({ label: 'Second', direction: 'node-connects' });
  const primary = {
    open: mock(() => {}), message: mock(async () => {}), close: mock(() => {}), drain: mock(() => {}),
  } satisfies Parameters<typeof createServerSocketHandlers>[0]['primary'];
  const server = Bun.serve<WsConnectionData>({
    hostname: '0.0.0.0', port: 0,
    fetch(request, server) {
      const link = manager.inboundLink(new URL(request.url).pathname.split('/')[2]!);
      if (!link) return new Response(null, { status: 404 });
      if (server.upgrade(request, { data: { kind: 'execution-node', link, handlers: null } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: createServerSocketHandlers({
      primary, admission: new WebSocketAdmissionController(1),
      config: { wsIdleTimeoutSeconds: 60, wsBackpressureLimit: 1024, wsMaxPayloadLength: 1024 },
      logger: { error: () => {} },
    }),
  });
  cleanups.push(async () => { await server.stop(true); });
  const ready = [waitReady(manager, first.id), waitReady(manager, second.id)];
  const workerA = worker(first.secret, root);
  const workerB = worker(second.secret, root);
  workerA.dial(`ws://127.0.0.1:${server.port}/execution-node/${first.id}`);
  workerB.dial(`ws://127.0.0.1:${server.port}/execution-node/${second.id}`);
  await Promise.all(ready);
  const integrationA = manager.requireIntegration({ nodeId: first.id, agentId: 'test' });
  const integrationB = manager.requireIntegration({ nodeId: second.id, agentId: 'test' });
  expect(integrationA).not.toBe(integrationB);
  expect(integrationA.producers.scope.nodeId).toBe(first.id);
  expect(integrationB.producers.scope.nodeId).toBe(second.id);
  const scope = integrationA.producers.scope;
  await manager.update(first.id, { label: 'Renamed' });
  expect(manager.requireIntegration({ nodeId: first.id, agentId: 'test' }).producers.scope).toEqual(scope);
  await manager.update(first.id, { enabled: false });
  expect(manager.isReady(first.id)).toBe(false);
  expect(manager.isReady(second.id)).toBe(true);
  expect(manager.isReady('local')).toBe(true);
  expect(manager.inboundLink(first.id)).toBeNull();
  expect(primary.open).not.toHaveBeenCalled();
  expect(primary.message).not.toHaveBeenCalled();
  expect(primary.close).not.toHaveBeenCalled();
});

test('outbound node initializes independently and mutation guards retain configuration', async () => {
  const { manager, root } = await fixture();
  const secret = Buffer.alloc(32, 5).toString('base64url');
  const remote = worker(secret, root);
  const connectionUrl = nodeConnectionUrl(remote.listen(), secret);
  const configured = await manager.create({ direction: 'controller-connects', label: 'Outbound', connectionUrl, allowInsecureDevelopment: true });
  await waitReady(manager, configured.id);
  expect((await manager.inspectProject(root, configured.id)).kind).toBe('available');
  manager.setGuards({
    assertIdle() { throw new DomainError('EXECUTION_NODE_IN_USE', 'Stop running work first', 409); },
    assertUnreferenced() {},
  });
  await expect(manager.update(configured.id, { enabled: false })).rejects.toMatchObject({ status: 409 });
  expect(manager.isReady(configured.id)).toBe(true);
  await manager.update(configured.id, { label: 'Safe rename' });
  manager.setGuards({ assertIdle() {}, assertUnreferenced() { throw new DomainError('EXECUTION_NODE_IN_USE', 'Referenced by chats', 409); } });
  await expect(manager.remove(configured.id)).rejects.toMatchObject({ status: 409 });
  expect(manager.config.require(configured.id).label).toBe('Safe rename');
});

test.each([false, true])('retained connections publish ready after a mutation fence (write fails: %s)', async (failWrite) => {
  const { manager, root } = await fixture();
  const secret = Buffer.alloc(32, 6).toString('base64url');
  const remote = worker(secret, root);
  const configured = await manager.create({
    direction: 'controller-connects', label: 'Retained',
    connectionUrl: nodeConnectionUrl(remote.listen(), secret), allowInsecureDevelopment: true,
  });
  await waitReady(manager, configured.id);
  const integration = manager.requireIntegration({ nodeId: configured.id, agentId: 'test' });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const update = manager.config.update.bind(manager.config);
  const write = spyOn(manager.config, 'update').mockImplementation(async (id, request) => {
    entered.resolve();
    await release.promise;
    if (failWrite) throw new Error('Synthetic write failure');
    return update(id, request);
  });
  try {
    const mutation = manager.update(configured.id, { enabled: true }).catch((error: unknown) => error);
    await entered.promise;
    expect(manager.isReady(configured.id)).toBe(false);
    const ready = waitReady(manager, configured.id);
    release.resolve();
    const result = await mutation;
    if (failWrite) expect(result).toBeInstanceOf(Error);
    await ready;
    expect(manager.isReady(configured.id)).toBe(true);
    expect(manager.requireIntegration({ nodeId: configured.id, agentId: 'test' })).toBe(integration);
  } finally {
    release.resolve();
    write.mockRestore();
  }
});
