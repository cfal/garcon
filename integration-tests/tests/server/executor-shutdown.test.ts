import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { createServer, connect, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExecutors } from '../../../common/executors.js';
import { ExecutorProcess } from '../../support/execution-backend.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { webSocketProtocolsForAuth } from '../../../common/ws-auth.js';

test('shutdown rejects browser work while the remote abort reply is held', async () => {
  await withIntegrationFixture('executor-shutdown', async fixture => {
    const root = join(fixture.dirs.root, 'shutdown-worker');
    const directories = {
      root, config: join(root, 'config'), workspace: join(root, 'workspace'),
      project: join(root, 'project'), home: join(root, 'home'),
    };
    for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
    const worker = await ExecutorProcess.start({
      repoRoot: fileURLToPath(new URL('../../..', import.meta.url)), directories, environment: {},
      connection: { kind: 'listen', port: 0 },
    });
    const sockets = new Set<Socket>();
    const replies = new Set<Socket>();
    const target = new URL(await worker.connectionUrl());
    const workerPort = Number(target.port);
    const proxy = createServer(client => {
      const upstream = connect(workerPort, '127.0.0.1');
      sockets.add(client); sockets.add(upstream); replies.add(upstream);
      client.pipe(upstream); upstream.pipe(client);
      const close = () => { client.destroy(); upstream.destroy(); };
      client.on('error', close); upstream.on('error', close);
      client.on('close', close); upstream.on('close', close);
    });
    let stopping: Promise<void> | null = null;
    let browser: WebSocket | null = null;
    try {
      await new Promise<void>(resolve => proxy.listen(0, '0.0.0.0', resolve));
      target.hostname = '127.0.0.1';
      target.port = String((proxy.address() as AddressInfo).port);
      const executor = await fixture.client.post<{ id: string }>('/api/v1/executors', {
        label: 'Shutdown worker', direction: 'controller-connects', connectionUrl: target.href,
        allowInsecureDevelopment: true,
      });
      const deadline = Date.now() + 20_000;
      while (true) {
        const snapshot = await fixture.client.get<{ executors: unknown }>('/api/v1/executors');
        if (parseExecutors(snapshot.executors)?.some(entry => entry.id === executor.id && entry.availability === 'ready')) break;
        if (Date.now() >= deadline) throw new Error('Shutdown worker did not become ready');
        await Bun.sleep(20);
      }
      const agent = fixture.directAgents.openAi;
      await fixture.client.put(`/api/v1/api-provider-assignments?executorId=${executor.id}&apiProviderId=${agent.provider.providerId}`, {});
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic shutdown input' });
      await fixture.client.startDirectChat({
        executorId: executor.id, chatId: fixture.newChatId(), projectPath: directories.project, agent,
        content: 'Synthetic shutdown input',
      });
      await held.received;
      await fixture.client.close();
      browser = new WebSocket(fixture.garcon.baseUrl.replace('http:', 'ws:') + '/ws', webSocketProtocolsForAuth(fixture.garcon.authToken));
      await new Promise<void>((resolve, reject) => {
        browser!.onopen = () => resolve();
        browser!.onerror = () => reject(new Error('Browser socket did not open'));
      });
      const closed = new Promise<CloseEvent>(resolve => { browser!.onclose = resolve; });
      const aborted = held.expectAbort();
      // The request still reaches the worker; only its confirmation is held.
      for (const socket of replies) socket.pause();
      stopping = fixture.garcon.stop();
      await aborted;
      expect((await closed).code).toBe(1001);
      for (const [path, method] of [['/api/v1/chats/start', 'POST'], ['/ws', 'GET']] as const) {
        const response = await fixture.client.fetch(path, {
          method,
          headers: method === 'POST' ? { 'Content-Type': 'application/json' } : { Upgrade: 'websocket', Connection: 'Upgrade' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ errorCode: 'SERVER_SHUTTING_DOWN' });
      }
      for (const socket of replies) socket.resume();
      await stopping;
    } finally {
      for (const socket of replies) socket.resume();
      try { await stopping; }
      finally {
        browser?.close();
        try { await worker.stop(); }
        finally {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>(resolve => proxy.close(() => resolve()));
        }
      }
    }
  }, { executionBackend: 'in-process' });
}, 30_000);
