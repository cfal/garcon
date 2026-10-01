import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ExecutorConnection, ExecutorSnapshot } from '../../../common/executors.js';
import { ExecutorsChangedMessage } from '../../../common/ws-events.js';
import { ExecutorProcess } from '../../support/execution-backend.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const configured of [false, true]) {
  test(`executor onboarding uses ${configured ? 'configured public base' : 'request Host'} without persisting a placeholder`, async () => {
    await withIntegrationFixture('executor-public-url', async fixture => {
      const response = await fixture.client.fetch('/api/v1/executors', {
        method: 'POST', headers: { 'content-type': 'application/json', host: 'visible.test:8080',
          'x-forwarded-host': 'untrusted.test', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({ direction: 'executor-connects', label: 'Synthetic public worker', noTls: !configured }),
      });
      expect(response.status).toBe(200);
      const created = await response.json() as ExecutorConnection & { id: string };
      const endpoint = new URL(created.connectionUrl);
      expect(`${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`).toBe(configured
        ? `wss://public.test/garcon/executor/${created.id}` : `ws://visible.test:8080/executor/${created.id}`);
      expect(endpoint.hash).toMatch(/^#secret=[A-Za-z0-9_-]{43}$/u);
      expect(JSON.stringify(await fixture.client.get('/api/v1/executors'))).not.toContain(endpoint.hash.slice(8));
      await fixture.restartGarcon();
      const read = await fixture.client.fetch(`/api/v1/executors/${created.id}/connection`, { headers: { host: 'visible.test:8080' } });
      expect((await read.json()).connectionUrl).toBe(created.connectionUrl);
    }, { executionBackend: 'in-process', serverEnvironment: { GARCON_PUBLIC_URL: configured ? 'https://public.test/garcon' : '' } });
  }, 45_000);
}

async function startProxy(target: URL) {
  const publicPath = '/any-prefix?route=worker&tag=a&tag=b';
  const requests: string[] = [];
  const sockets = new Set<Duplex>();
  const proxy = createServer((_request, response) => { response.writeHead(404); response.end(); });
  proxy.on('upgrade', (request, socket, head) => {
    requests.push(request.url!);
    if (request.url !== publicPath) { socket.destroy(); return; }
    sockets.add(socket);
    const upstream = httpRequest({
      hostname: '127.0.0.1', port: target.port, path: target.pathname,
      headers: { ...request.headers, host: target.host },
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => { sockets.delete(socket); upstream.destroy(); });
    upstream.on('error', () => socket.destroy());
    upstream.on('response', (response) => { response.resume(); socket.destroy(); });
    upstream.on('upgrade', (response, origin, originHead) => {
      sockets.add(origin);
      origin.on('error', () => { origin.destroy(); socket.destroy(); });
      origin.on('close', () => { sockets.delete(origin); socket.destroy(); });
      socket.on('close', () => origin.destroy());
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
      }
      socket.write('\r\n');
      if (originHead.length) socket.write(originHead);
      if (head.length) origin.write(head);
      origin.pipe(socket); socket.pipe(origin);
    });
    upstream.end();
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '0.0.0.0', resolve);
  });
  return {
    url: `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}${publicPath}${target.hash}`,
    requests,
    publicPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    },
  };
}

for (const direction of ['executor-connects', 'controller-connects'] as const) {
  test(`arbitrary public URLs connect through a rewriting proxy (${direction})`, async () => {
    await withIntegrationFixture(`executor-proxy-url-${direction}`, async fixture => {
      const { client } = fixture;
      const root = join(fixture.dirs.root, 'proxied-worker');
      const directories = {
        root, config: join(root, 'config'), workspace: join(root, 'workspace'),
        project: join(root, 'project'), home: join(root, 'home'),
      };
      for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
      const workerOptions = { repoRoot: fileURLToPath(new URL('../../..', import.meta.url)), directories, environment: {} };
      let worker: ExecutorProcess | null = null;
      let proxy: Awaited<ReturnType<typeof startProxy>> | null = null;
      try {
        let executor: { id: string };
        if (direction === 'executor-connects') {
          const created = await client.post<ExecutorConnection & { id: string }>('/api/v1/executors', {
            label: 'Proxied worker', direction, noTls: true,
          });
          executor = created;
          const internal = new URL(created.connectionUrl);
          internal.host = new URL(fixture.garcon.baseUrl).host;
          proxy = await startProxy(internal);
          await client.patch(`/api/v1/executors/${executor.id}`, { connection: {
            direction, connectionUrl: proxy.url, noTls: true,
          } });
          worker = await ExecutorProcess.start({ ...workerOptions, connection: { kind: 'dial', url: proxy.url } });
        } else {
          worker = await ExecutorProcess.start({ ...workerOptions, connection: { kind: 'listen', port: 0 } });
          proxy = await startProxy(new URL(await worker.connectionUrl()));
          executor = await client.post<{ id: string }>('/api/v1/executors', {
            label: 'Proxied worker', direction, connectionUrl: proxy.url, noTls: true,
          });
        }
        const afterIndex = client.markEvents();
        const snapshot = await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors');
        if (!snapshot.executors.some(entry => entry.id === executor.id && entry.availability === 'ready')) {
          await client.waitForEvent(
            (message): message is ExecutorsChangedMessage => message instanceof ExecutorsChangedMessage
              && message.executors.some(entry => entry.id === executor.id && entry.availability === 'ready'),
            'Proxied executor ready', { afterIndex, timeoutMs: 20_000 },
          );
        }
        expect((await client.get<ExecutorConnection>(`/api/v1/executors/${executor.id}/connection`)).connectionUrl).toBe(proxy.url);
        const agent = fixture.directAgents.openAi;
        await client.put(`/api/v1/api-provider-assignments?executorId=${executor.id}&apiProviderId=${agent.provider.providerId}`, {});
        const chatId = fixture.newChatId();
        const started = await client.startDirectChat({
          executorId: executor.id, chatId, projectPath: directories.project, agent, content: 'Synthetic proxied input',
        });
        expect(await client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished' });
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
        expect(proxy.requests).toEqual([proxy.publicPath]);
      } finally {
        try { await worker?.stop(); }
        finally { await proxy?.close(); }
      }
    }, { executionBackend: 'in-process' });
  }, 45_000);
}
