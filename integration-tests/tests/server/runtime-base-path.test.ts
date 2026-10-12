import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadTextResponse } from '../../../common/file-contracts.js';
import type { StartChatCommandResponse } from '../../../common/chat-command-contracts.js';
import type { ShareChatResponse, ShareStatusResponse } from '../../../common/share-types.js';
import { discoverRuntime } from '../../../cli/discovery.js';
import { withCliFixture, runCli } from '../../support/cli-fixture.js';

for (const basePath of ['', '/garcon', '/tools/garcon']) {
  for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
    test(`runtime mount ${basePath || '/'}: HTTP, WebSocket, shares and CLI (${executionBackend})`, async () => {
      await withCliFixture(`runtime-mount-${basePath}-${executionBackend}`, async fixture => {
        const baseUrl = fixture.garcon.baseUrl;
        const origin = new URL(baseUrl).origin;
        const request = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
        expect(new URL(baseUrl).pathname).toBe(basePath || '/');
        if (basePath) {
          for (const method of ['GET', 'HEAD']) {
            const redirect = await request('?source=test', { method, redirect: 'manual' });
            expect(redirect.status).toBe(308);
            expect(redirect.headers.get('location')).toBe(`${basePath}/?source=test`);
          }
          for (const path of ['/', '/api/v1/auth/status', '/ws', `${basePath}-other/`, '/_app/version.json']) {
            expect((await fetch(origin + path)).status).toBe(404);
          }
        }
        expect((await request('/api/v1/chats')).status).toBe(401);
        expect((await request('/api/v1/auth/status')).status).toBe(200);
        const chatId = fixture.newChatId();
        await writeFile(join(fixture.executionDirs.project, 'mounted.txt'), 'Synthetic mounted content');
        const started = await fixture.client.fetch('/api/v1/chats/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fixture.client.directStartRequest({ chatId, content: 'Synthetic mounted turn',
            projectPath: fixture.executionDirs.project, agent: fixture.directAgents.openAi })),
        });
        expect(started.status).toBe(202);
        const turn: StartChatCommandResponse = await started.json();
        expect(started.headers.get('location')).toBe(`${basePath}/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${turn.turnId}`);
        await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
        const receipt = await fetch(new URL(started.headers.get('location')!, baseUrl), {
          headers: { Authorization: `Bearer ${fixture.garcon.authToken}` },
        });
        expect(receipt.status).toBe(200);
        const filePath = `/api/v1/files/text?${new URLSearchParams({ chatId, path: 'mounted.txt' })}`;
        const file = await fixture.client.get<ReadTextResponse>(filePath);
        expect(file.content).toBe('Synthetic mounted content');
        await fixture.client.put(filePath, { content: 'Synthetic saved content', expectedRevision: file.revision, conflictResolution: 'reject' });
        expect(await readFile(join(fixture.executionDirs.project, 'mounted.txt'), 'utf8')).toBe('Synthetic saved content');
        expect(await (await fixture.client.fetch(filePath.replace('/text?', '/content?'))).text()).toBe('Synthetic saved content');

        const share = await fixture.client.post<ShareChatResponse>('/api/v1/chats/share', { chatId });
        expect(share.shareUrl).toBe(`${basePath}/shared/${share.shareToken}`);
        expect(await fixture.client.get<ShareStatusResponse>(`/api/v1/chats/share/status?chatId=${chatId}`))
          .toMatchObject({ isShared: true, shareUrl: share.shareUrl });
        const shared = await fetch(origin + share.shareUrl, { headers: { Accept: 'text/html' } });
        const sharedHtml = await shared.text();
        expect(sharedHtml).toContain(`${basePath}/shared/llm/${share.shareToken}`);
        expect(sharedHtml).toContain(`${origin}${share.shareUrl}`);
        expect(shared.headers.get('link')).toContain(`${basePath}/shared/llm/`);
        expect(await (await request(`/shared/llm/${share.shareToken}`)).text()).toContain('Synthetic mounted turn');
        expect((await request(`/api/v1/shared?token=${share.shareToken}`)).status).toBe(200);

        const discovery = await discoverRuntime({ configDir: fixture.dirs.config, runtime: 'controller' });
        expect(new URL(discovery.baseUrl).pathname).toBe(basePath || '/');
        for (const runtime of (executionBackend === 'in-process' ? ['controller'] : ['controller', 'executor']) as ('controller' | 'executor')[]) {
          const result = await runCli(fixture, ['chats', '--json'], runtime);
          expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: '' });
          expect(result.stdout).toContain(chatId);
        }
        if (basePath === '/tools/garcon' && executionBackend === 'in-process') {
          await fixture.restartGarcon();
          const restarted = await discoverRuntime({ configDir: fixture.dirs.config, runtime: 'controller' });
          expect(new URL(restarted.baseUrl).pathname).toBe(basePath);
          expect((await runCli(fixture, ['chats', '--json'])).stdout).toContain(chatId);
        }
      }, { executionBackend, serverEnvironment: { GARCON_BASE_PATH: basePath } });
    }, 90_000);
  }
}
