import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseExecutorConnection, type CreateExecutorRequest } from '../../../../common/executors.js';
import { DomainError } from '../../../common/domain-error.js';
import { ExecutorManager } from '../../executors/manager.js';
import type { HttpRouteContext } from '../../lib/http-route-types.js';
import { createExecutorRoutes } from '../executors.js';
import { executorPublicUrl } from '../../executors/public-url.js';
import { executorConnectionUrl } from '../../../remote/transport/connection-url.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const delegated = {
  principal: { mode: 'executor', key: 'synthetic-origin', executorId: '11111111-1111-4111-8111-111111111111', expiresAtMs: null },
} satisfies HttpRouteContext;

async function fixture() {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'executor-url-route-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const manager = await ExecutorManager.create({
    id: 'local', workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null,
  });
  cleanups.push(() => manager.dispose());
  return { manager, routes(publicUrl: string | null = null, context?: HttpRouteContext) {
    const handlers = createExecutorRoutes(manager, publicUrl);
    return {
      create(body: CreateExecutorRequest, origin = 'http://controller.invalid') {
        const url = new URL('/api/v1/executors', origin);
        const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return handlers['/api/v1/executors']!.POST!(request, url, undefined, context);
      },
      connection(id: string, origin = 'http://controller.invalid') {
        const url = new URL(`/api/v1/executors/${id}/connection`, origin);
        return handlers['/api/v1/executors/:executorId/connection']!.GET!(new Request(url), url, undefined, context);
      },
    };
  } };
}

test('direct onboarding suggests the request Host without saving it', async () => {
  const { manager, routes } = await fixture();
  const response = await routes().create({ label: 'Inherited', direction: 'executor-connects' }, 'https://browser.test');
  expect(response.status).toBe(200);
  const created = await response.json();
  expect(created.connectionUrl).toStartWith(`wss://browser.test/executor/${created.id}#secret=`);
  const reveal = await routes().connection(created.id, 'https://another-browser.test');
  expect((await reveal.json()).connectionUrl).toStartWith(`wss://another-browser.test/executor/${created.id}#secret=`);
  await manager.config.initialize();
  expect(manager.config.require(created.id).connection).toEqual({ kind: 'executor-connects', advertisedUrl: null });
});

test('inherited connection URLs enforce the complete URL limit before saving and on reveal', async () => {
  const { manager, routes } = await fixture();
  const base = 'https://controller.test/';
  const example = executorConnectionUrl(executorPublicUrl(base, '11111111-1111-4111-8111-111111111111'), Buffer.alloc(32).toString('base64url'));
  const maximumBase = `${base}${'a'.repeat(4096 - example.length - 1)}/`;
  const oversizedBase = `${maximumBase.slice(0, -1)}a/`;

  for (const context of [undefined, delegated]) {
    const rejected = await routes(oversizedBase, context).create({ label: 'Too long', direction: 'executor-connects' });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ errorCode: 'VALIDATION_FAILED', error: expect.stringContaining('4096') });
    await manager.config.initialize();
    expect(manager.config.list()).toEqual([]);
  }

  const accepted = await routes(maximumBase, delegated).create({ label: 'At limit', direction: 'executor-connects' });
  expect(accepted.status).toBe(200);
  const created = await accepted.json();
  expect(created.connectionUrl).toHaveLength(4096);
  expect(parseExecutorConnection(created)).not.toBeNull();
  await manager.config.initialize();
  expect(manager.config.require(created.id).connection).toEqual({ kind: 'executor-connects', advertisedUrl: null });

  const reveal = await routes(oversizedBase, delegated).connection(created.id);
  expect(reveal.status).toBe(400);
  expect(reveal.headers.get('cache-control')).toBe('no-store');
  expect(await reveal.json()).toMatchObject({ errorCode: 'VALIDATION_FAILED', error: expect.stringContaining('4096') });
  const restored = await routes(maximumBase, delegated).connection(created.id);
  expect(await restored.json()).toMatchObject({ connectionUrl: created.connectionUrl });
});

test('forwarded onboarding rejects missing public configuration before saving', async () => {
  const { manager, routes } = await fixture();
  const response = await routes(null, delegated).create({ label: 'Missing address', direction: 'executor-connects' }, 'https://forged-host.test');
  expect(response.status).toBe(400);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ errorCode: 'VALIDATION_FAILED', error: expect.stringContaining('GARCON_PUBLIC_URL') });
  expect(manager.config.list()).toEqual([]);
});

test('forwarded reveal rejects inherited addresses rather than returning a synthetic Host', async () => {
  const { manager, routes } = await fixture();
  const created = await manager.create({ label: 'Inherited', direction: 'executor-connects' });
  const response = await routes(null, delegated).connection(created.id);
  expect(response.status).toBe(400);
  const body = await response.text();
  expect(body).toContain('GARCON_PUBLIC_URL');
  expect(body).not.toContain('controller.invalid');
  expect(body).not.toContain(created.secret);
});

test('forwarded creation and reveal inherit public configuration without persisting a copy', async () => {
  const { manager, routes } = await fixture();
  const response = await routes('https://public.test/garcon', delegated).create({ label: 'Inherited', direction: 'executor-connects' });
  expect(response.status).toBe(200);
  const created = await response.json();
  expect(created.connectionUrl).toStartWith(`wss://public.test/garcon/executor/${created.id}#secret=`);
  const reveal = await routes('https://replacement.test/path', delegated).connection(created.id);
  expect(reveal.status).toBe(200);
  expect((await reveal.json()).connectionUrl).toBe(`wss://replacement.test/path/executor/${created.id}#secret=${manager.config.require(created.id).secret}`);
  await manager.config.initialize();
  expect(manager.config.require(created.id).connection).toEqual({ kind: 'executor-connects', advertisedUrl: null });
});

test('forwarded explicit overrides expand once and take precedence over the public base', async () => {
  const { manager, routes } = await fixture();
  const response = await routes(null, delegated).create({ label: 'Explicit', direction: 'executor-connects',
    advertisedUrl: 'wss://proxy.test/worker/{executorId}?route=synthetic' });
  expect(response.status).toBe(200);
  const created = await response.json();
  const address = `wss://proxy.test/worker/${created.id}?route=synthetic`;
  const reveal = await routes('https://unused.test', delegated).connection(created.id);
  expect((await reveal.json()).connectionUrl).toBe(created.connectionUrl);
  expect(created.connectionUrl).toStartWith(`${address}#secret=`);
  expect(manager.config.require(created.id).connection).toEqual({ kind: 'executor-connects', advertisedUrl: address });
});

test('public URL resolution preserves the CLI admission fence before creation', async () => {
  const { manager, routes } = await fixture();
  const response = await routes('https://public.test', { ...delegated, assertCurrent() {
    throw new DomainError('CLI_ACCESS_DENIED', 'Synthetic revoked grant', 403);
  } }).create({ label: 'Revoked', direction: 'executor-connects' });
  expect(response.status).toBe(403);
  expect(manager.config.list()).toEqual([]);
});
