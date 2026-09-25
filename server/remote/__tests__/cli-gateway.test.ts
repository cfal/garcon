import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ServerResponse } from 'node:http';
import { discoverRuntime } from '../../../cli/discovery.js';
import { GarconClient } from '../../../cli/garcon-client.js';
import { ControllerCliDispatcher } from '../../controller/executors/cli-dispatcher.js';
import { startCliGateway } from '../server/cli-gateway.js';
import { cliPair, CLI_EXECUTOR_ID } from './cli-fixture.js';
import { DomainError } from '../../common/domain-error.js';
import { parseJsonBody } from '../../common/http-body.js';
import type { RouteMap } from '../../controller/lib/http-route-types.js';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(routes: RouteMap = {}, workspaceName: string | null = 'workspace') {
  const root = await mkdtemp(join(homedir(), 'cli-gateway-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let allowed = true;
  let live: ReturnType<typeof cliPair> | null = null;
  const replace = (serverInstanceId: string) => {
    live?.close();
    live = cliPair(new ControllerCliDispatcher({ routes, serverInstanceId, workspaceName, isShuttingDown: () => false }),
      () => { if (!allowed) throw new DomainError('CLI_ACCESS_DENIED', 'Disabled', 403); });
    cleanups.push(() => live?.close());
  };
  replace('controller');
  const dataDir = join(root, 'executor');
  const gateway = await startCliGateway({ dataDir, currentRpc: () => live?.worker ?? null });
  cleanups.push(() => gateway.dispose());
  const discover = () => discoverRuntime({ configDir: root, runtime: 'executor' });
  const call = (path: string, init: RequestInit = {}) => fetch(`${gateway.descriptor.baseUrl}${path}`, {
    ...init, headers: { Authorization: `Bearer ${gateway.descriptor.localCapability}`, 'X-Garcon-Server-Instance': 'controller', ...init.headers },
  });
  return { root, dataDir, gateway, discover, call, replace, deny() { allowed = false; }, disconnect() { live?.close(); live = null; } };
}

test('private role descriptors prove a live endpoint and never expose the controller capability or directory', async () => {
  const f = await fixture({}, null);
  const connection = await f.discover();
  expect(connection).toMatchObject({ instanceId: 'controller', endpointInstanceId: f.gateway.descriptor.instanceId,
    defaultExecutorId: CLI_EXECUTOR_ID, workspaceName: null, workspaceDir: null });
  expect(f.gateway.descriptor.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(JSON.parse(await readFile(f.gateway.runtimeFile, 'utf8'))).not.toHaveProperty('workspaceDir');
  if (process.platform !== 'win32') {
    expect((await stat(f.gateway.runtimeFile)).mode & 0o777).toBe(0o600);
    expect((await stat(f.dataDir)).mode & 0o777).toBe(0o700);
  }
  const secondRoot = join(f.root, 'second');
  const second = await startCliGateway({ dataDir: join(secondRoot, 'executor'), currentRpc: () => null });
  try {
    expect(second.runtimeFile).not.toBe(f.gateway.runtimeFile);
    expect(second.descriptor.localCapability).not.toBe(f.gateway.descriptor.localCapability);
    await expect(f.discover()).resolves.toMatchObject({ instanceId: 'controller' });
    await expect(discoverRuntime({ configDir: secondRoot, runtime: 'executor' })).rejects.toThrow('context unavailable');
  } finally { await second.dispose(); }
  await expect(stat(second.runtimeFile)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(f.discover()).resolves.toMatchObject({ instanceId: 'controller' });
  await f.gateway.dispose();
  await expect(stat(f.gateway.runtimeFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('existing shared-readable directories retain their modes while runtime files stay private', async () => {
  const root = await mkdtemp(join(homedir(), 'cli-gateway-modes-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'executor');
  await mkdir(dataDir);
  if (process.platform !== 'win32') await chmod(dataDir, 0o775);
  const gateway = await startCliGateway({ dataDir, currentRpc: () => null });
  cleanups.push(() => gateway.dispose());
  expect(gateway.runtimeFile).toBe(join(dataDir, 'runtime.json'));
  if (process.platform !== 'win32') {
    expect((await stat(dataDir)).mode & 0o777).toBe(0o775);
    expect((await stat(gateway.runtimeFile)).mode & 0o777).toBe(0o600);
  }
});

test('old gateway cleanup cannot remove a replacement runtime file', async () => {
  const f = await fixture();
  const replacement = await startCliGateway({ dataDir: f.dataDir, currentRpc: () => null });
  cleanups.push(() => replacement.dispose());
  await f.gateway.dispose();
  expect(JSON.parse(await readFile(replacement.runtimeFile, 'utf8')).instanceId).toBe(replacement.descriptor.instanceId);
});

test('gateway authentication, grant, method allowlist, generation and JSON fences precede raw handler dispatch', async () => {
  let calls = 0;
  const f = await fixture({ '/api/v1/chats/run': { POST: async (req) => { calls++; return Response.json(await parseJsonBody(req), { status: 201 }); } } });
  const path = '/api/v1/chats/run';
  expect((await f.call(path, { method: 'POST', headers: { Authorization: 'Bearer invalid' } })).status).toBe(403);
  expect((await f.call(path, { method: 'POST', headers: { Origin: 'http://browser.invalid' } })).status).toBe(403);
  expect((await f.call('/api/v1/executors')).status).toBe(403);
  expect((await f.call(path, { method: 'POST', headers: { 'X-Garcon-Server-Instance': 'old' } })).status).toBe(409);
  expect((await f.call(path, { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
  expect((await f.call(path, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
  expect(calls).toBe(0);
  const response = await f.call(path, { method: 'POST', body: '{"command":"Synthetic"}', headers: { 'Content-Type': 'application/json' } });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ command: 'Synthetic' });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  f.deny();
  await expect(f.discover()).rejects.toThrow('HTTP 403');
  expect((await f.call(path, { method: 'POST' })).status).toBe(403);
  expect(calls).toBe(1);
});

test('controller restart behind a surviving gateway fences old invocations and allows fresh discovery', async () => {
  const f = await fixture({ '/api/v1/chats': { GET: () => Response.json([]) } });
  const client = new GarconClient(await f.discover());
  f.replace('replacement');
  expect(await client.verifyRuntime()).toBe(false);
  expect((await f.call('/api/v1/chats')).status).toBe(409);
  expect((await f.discover()).instanceId).toBe('replacement');
});

test('disconnect after dispatch returns uncertainty and never queues or replays a mutation', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture({ '/api/v1/chats/run': { POST: async () => {
    calls++; entered.resolve(); await release.promise; return Response.json({ ok: true });
  } } });
  const pending = f.call('/api/v1/chats/run', { method: 'POST' });
  await entered.promise;
  f.disconnect();
  expect(await (await pending).json()).toMatchObject({ errorCode: 'CLI_OUTCOME_UNKNOWN' });
  expect(await (await f.call('/api/v1/chats/run', { method: 'POST' })).json()).toMatchObject({ errorCode: 'CLI_CONTROLLER_UNAVAILABLE' });
  f.replace('controller');
  release.resolve();
  expect(calls).toBe(1);
  expect((await f.discover()).instanceId).toBe('controller');
});

test('encoded request limits are rejected before effects and raw exceptions stay opaque', async () => {
  let calls = 0;
  const f = await fixture({ '/api/v1/chats/run': { POST: () => { calls++; throw new Error('private filesystem secret'); } } });
  const oversized = await f.call('/api/v1/chats/run', { method: 'POST', body: JSON.stringify({ command: 'x'.repeat(1024 * 1024) }), headers: { 'Content-Type': 'application/json' } });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({ errorCode: 'CLI_REQUEST_TOO_LARGE' });
  expect(calls).toBe(0);
  const failure = await f.call('/api/v1/chats/run', { method: 'POST' });
  expect(failure.status).toBe(500);
  expect(await failure.json()).toMatchObject({ error: 'Internal server error' });
});

test('HTTP cancellation reaches raw handlers without releasing unsettled controller work', async () => {
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture({ '/api/v1/chats/fork': { POST: async (request) => {
    request.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    entered.resolve(); await release.promise; return Response.json({ ok: true });
  } } });
  const abort = new AbortController();
  const pending = f.call('/api/v1/chats/fork', { method: 'POST', signal: abort.signal });
  const rejected = Promise.allSettled([pending]);
  try {
    await entered.promise;
    abort.abort();
    expect(await rejected).toMatchObject([{ status: 'rejected' }]);
    await cancelled.promise;
  } finally { release.resolve(); }
});

test('slow HTTP readers consume the response budget until their sockets close', async () => {
  const f = await fixture({ '/api/v1/chats': { GET: () => Response.json({ data: 'x'.repeat(96 * 1024) }) } });
  const pending: Promise<ArrayBuffer>[] = [];
  const blocked: { response: ServerResponse; args: Parameters<ServerResponse['write']> }[] = [];
  let entered = Promise.withResolvers<void>();
  const originalWrite = ServerResponse.prototype.write;
  // Holds the drain boundary explicitly; loopback kernel buffers can absorb an entire reply.
  const write = spyOn(ServerResponse.prototype, 'write').mockImplementation(function (this: ServerResponse, ...args) {
    if (Buffer.isBuffer(args[0]) && args[0].byteLength > 32 * 1024) {
      blocked.push({ response: this, args });
      entered.resolve();
      return false;
    }
    return originalWrite.apply(this, args);
  });
  try {
    for (let i = 0; i < 16; i++) {
      entered = Promise.withResolvers<void>();
      pending.push(f.call('/api/v1/chats').then((response) => response.arrayBuffer()));
      await entered.promise;
    }
    const rejected = await f.call('/api/v1/chats');
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ errorCode: 'CLI_SERVICE_BUSY' });
    expect(rejected.headers.get('Retry-After')).toBe('1');
  } finally {
    write.mockRestore();
    for (const { response, args } of blocked) {
      originalWrite.apply(response, args);
      response.emit('drain');
    }
    await Promise.all(pending);
  }
  expect((await f.call('/api/v1/chats')).status).toBe(200);
}, 15_000);
