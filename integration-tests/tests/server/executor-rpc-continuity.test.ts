import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadTextResponse, SaveTextResponse } from '../../../common/file-contracts.js';
import type { ExecutorsChangedMessage } from '../../../common/ws-events.js';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

// Matches the browser's request timeout, which the interactive budget answers within.
const BROWSER_REQUEST_TIMEOUT_MS = 30_000;

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`a file save sent into a silent link is saved once the executor reconnects (${executionBackend})`, async () => {
    let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
    try {
      await withIntegrationFixture(`rpc-continuity-save-${executionBackend}`, async (fixture) => {
        const { client } = fixture;
        const projectPath = fixture.executionDirs.project;
        const file = join(projectPath, 'file.txt');
        await writeFile(file, 'original');
        const route = `/api/v1/files/text?${new URLSearchParams({ executorId: client.executorId, projectPath, path: 'file.txt' })}`;
        const before = await client.get<ReadTextResponse>(route);
        const cursor = client.markEvents();

        // The worker never receives the save while the link is silent.
        proxy!.blackhole();
        const saving = client.put<SaveTextResponse>(route, {
          content: 'Synthetic content saved across a blip', expectedRevision: before.revision, conflictResolution: 'reject',
        });
        await Bun.sleep(300);
        expect(await readFile(file, 'utf8')).toBe('original');
        proxy!.restore();
        proxy!.disconnect();

        const saved = await saving;
        expect(saved.revision).not.toBe(before.revision);
        expect(await readFile(file, 'utf8')).toBe('Synthetic content saved across a blip');
        expect(client.eventsSince(cursor).some((event) => event.type === 'executors-changed'
          && event.executors.some((executor) => executor.id === client.executorId && executor.availability === 'reconnecting'))).toBe(true);
        expect(proxy!.connections).toBe(2);
      }, {
        executionBackend,
        projectRoots: 'separate',
        interceptExecutorConnection: async (url) => { proxy = await tcpLinkProxy(url); return proxy.url; },
      });
    } finally { await proxy?.close(); }
  }, 60_000);

  // A new chat's start holds its chat's lock through dispatch. Into a link that
  // went silent, its executor checks give up within the interactive budget, before
  // the chat is created.
  test(`a new chat start into a silent link fails in time without creating the chat (${executionBackend})`, async () => {
    let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
    try {
      await withIntegrationFixture(`rpc-continuity-silent-start-${executionBackend}`, async (fixture) => {
        const { client } = fixture;
        const browser = await fixture.connectObserver('browser', { requestTimeoutMs: BROWSER_REQUEST_TIMEOUT_MS });
        const chatId = fixture.newChatId();
        proxy!.blackhole();
        const requested = performance.now();
        const failure = await browser.startDirectChat({
          chatId, content: 'Synthetic start into a silent link', projectPath: fixture.executionDirs.project,
          agent: fixture.directAgents.openAi,
        }).then(() => null, (error: unknown) => error);

        expect(failure).toMatchObject({ status: 503 });
        expect(performance.now() - requested).toBeLessThan(29_000);
        expect((await client.listChats()).sessions.some((chat) => chat.id === chatId)).toBe(false);
        proxy!.restore();
        proxy!.disconnect();
      }, {
        executionBackend,
        interceptExecutorConnection: async (url) => { proxy = await tcpLinkProxy(url); return proxy.url; },
      });
    } finally { await proxy?.close(); }
  }, 60_000);

  // Browsers give each request 30 seconds. A settings change holding the chat's
  // lock stops waiting for a reconnecting executor first, so the Stop queued
  // behind it still gets its answer in time.
  test(`a settings change stops waiting for a reconnecting executor in time for a Stop queued behind it (${executionBackend})`, async () => {
    let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
    try {
      await withIntegrationFixture(`rpc-continuity-settings-${executionBackend}`, async (fixture) => {
        const { client, fakeProviders } = fixture;
        const chatId = fixture.newChatId();
        const held = fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic running turn' });
        const started = await client.startDirectChat({
          chatId, content: 'Synthetic running turn', projectPath: fixture.executionDirs.project, agent: fixture.directAgents.openAi,
        });
        await held.received;
        const cursor = client.markEvents();
        proxy!.blackhole();
        proxy!.disconnect();
        await client.waitForEvent(
          (event): event is ExecutorsChangedMessage => event.type === 'executors-changed'
            && event.executors.some(executor => executor.id === client.executorId && executor.availability === 'reconnecting'),
          'executor reconnecting', { afterIndex: cursor, timeoutMs: 20_000 },
        );

        const browser = await fixture.connectObserver('browser', { requestTimeoutMs: BROWSER_REQUEST_TIMEOUT_MS });
        const requested = performance.now();
        const patching = browser.patch('/api/v1/chats/execution-settings', { chatId, agentSettingsPatch: {} })
          .then(() => null, (error: unknown) => error);
        // Lets the settings change take the chat's lock first.
        await Bun.sleep(500);
        const stopping = browser.stopChat({ chatId, clientRequestId: crypto.randomUUID() });

        expect(await patching).toMatchObject({
          status: 503, body: expect.objectContaining({ error: 'The executor did not reconnect in time.' }),
        });
        const stopped = await stopping;
        expect(performance.now() - requested).toBeLessThan(29_000);
        expect(stopped.outcome).toBe('interrupt-requested');

        // The Stop reaches the native turn once the executor reconnects, which can
        // wait for the dialer's next attempt.
        const reconnectCursor = client.markEvents();
        proxy!.restore();
        proxy!.disconnect();
        await client.waitForEvent(
          (event): event is ExecutorsChangedMessage => event.type === 'executors-changed'
            && event.executors.some(executor => executor.id === client.executorId && executor.availability === 'ready'),
          'executor ready again', { afterIndex: reconnectCursor, timeoutMs: 30_000 },
        );
        await held.expectAbort();
        expect(await client.waitForTurnTerminal(chatId, started.turnId, { afterIndex: cursor, timeoutMs: 20_000 }))
          .toMatchObject({ type: 'agent-run-finished', outcome: 'interrupted' });
      }, {
        executionBackend,
        interceptExecutorConnection: async (url) => { proxy = await tcpLinkProxy(url); return proxy.url; },
      });
    } finally { await proxy?.close(); }
  }, 60_000);
}
