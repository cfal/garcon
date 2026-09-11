import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiProviderCatalogEntry } from '../../../common/api-providers.js';
import { isRecord } from '../../../common/json.js';
import { userContents } from '../../support/chat-assertions.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { fakeOpenAiRequestHeaders } from '../../support/openai-test-contract.js';

for (const delivery of ['direct', 'queued'] as const) {
  test(`${delivery} admission binds endpoint credentials before a URL and key update`, async () => {
    const entered = new Deferred<string>();
    const release = new Deferred<void>();
    const gate = Bun.serve({
      hostname: '0.0.0.0', port: 0, idleTimeout: 0,
      async fetch(request) {
        const input: unknown = await request.json();
        if (!isRecord(input) || typeof input.turnId !== 'string') return new Response(null, { status: 400 });
        entered.resolve(input.turnId);
        await release.promise;
        return new Response(null, { status: 204 });
      },
    });
    try {
      await withIntegrationFixture(`admitted-credentials-${delivery}`, async (fixture) => {
        const requests: { path: string; authorization: string | null }[] = [];
        const endpoint = Bun.serve({
          hostname: '0.0.0.0', port: 0, idleTimeout: 0,
          async fetch(request) {
            requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization') });
            return fetch(`${fixture.fakeProviders.openAi.baseUrl}/v1/chat/completions`, {
              method: 'POST', headers: fakeOpenAiRequestHeaders(), body: await request.text(), signal: request.signal,
            });
          },
        });
        const first = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic initial input' });
        const admitted = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic admitted input' });
        const next = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic next input' });
        try {
          const agent = fixture.directAgents.openAi;
          const providerPath = `/api/v1/api-providers?id=${agent.provider.providerId}`;
          const baseUrl = `http://127.0.0.1:${endpoint.port}`;
          await fixture.client.put<ApiProviderCatalogEntry>(providerPath, {
            endpoint: { baseUrl: `${baseUrl}/original`, apiKey: 'synthetic-original-key' },
          });
          const chatId = fixture.newChatId();
          const started = await fixture.client.startDirectChat({
            chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic initial input',
          });
          await first.received;
          if (delivery === 'queued') await fixture.client.enqueueNew(chatId, 'synthetic admitted input');
          first.releaseText('synthetic initial result');
          await fixture.client.waitForTurnTerminal(chatId, started.turnId);
          if (delivery === 'direct') await fixture.client.runChat({
            chatId, command: 'synthetic admitted input', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          });
          const turnId = await withTimeout(entered.promise, 5_000, () => 'Admitted turn did not reach dispatch');
          expect(userContents((await fixture.client.getMessages(chatId)).messages))
            .toEqual(['synthetic initial input', 'synthetic admitted input']);
          expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
          expect(requests).toEqual([{ path: '/original/chat/completions', authorization: 'Bearer synthetic-original-key' }]);
          await fixture.client.put<ApiProviderCatalogEntry>(providerPath, {
            endpoint: { baseUrl: `${baseUrl}/updated`, apiKey: 'synthetic-updated-key' },
          });
          release.resolve();
          await withTimeout(admitted.received, 5_000, () => 'Admitted request did not reach its captured endpoint');
          expect(requests[1]).toEqual({ path: '/original/chat/completions', authorization: 'Bearer synthetic-original-key' });
          admitted.releaseText('synthetic admitted result');
          await fixture.client.waitForTurnTerminal(chatId, turnId);
          const following = await fixture.client.runChat({
            chatId, command: 'synthetic next input', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          });
          await next.received;
          expect(requests[2]).toEqual({ path: '/updated/chat/completions', authorization: 'Bearer synthetic-updated-key' });
          next.releaseText('synthetic next result');
          await fixture.client.waitForTurnTerminal(chatId, following.turnId);
          expect(requests).toHaveLength(3);
          const publicData = JSON.stringify([
            await fixture.client.getChatSnapshot(chatId),
            await fixture.client.getMessages(chatId),
            await fixture.client.getExecutionControl(chatId),
            await fixture.client.get('/api/v1/models'),
          ]);
          const registry = await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8');
          for (const secret of ['synthetic-original-key', 'synthetic-updated-key']) {
            expect(publicData).not.toContain(secret);
            expect(registry).not.toContain(secret);
          }
        } finally {
          release.resolve();
          for (const output of [first, admitted, next]) {
            output.allowAbort();
            output.releaseText('synthetic cleanup');
          }
          await endpoint.stop(true);
        }
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/execution-dispatch-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_EXECUTION_DISPATCH_GATE: `http://127.0.0.1:${gate.port}` },
      });
    } finally {
      release.resolve();
      await gate.stop(true);
    }
  }, 30_000);
}
