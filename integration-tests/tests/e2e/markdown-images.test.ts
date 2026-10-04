import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('Markdown images use authenticated file reads on the owning remote executor', async () => {
  await withE2eFixture('markdown-remote-images', async (fixture) => {
    const { client, executionDirs, directAgents, garcon } = fixture.integration;
    const path = join(executionDirs.project, 'capture.png');
    await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'));
    const chatId = fixture.integration.newChatId();
    const started = await client.startDirectChat({
      chatId, content: `![Relative capture](capture.png)\n\n![Absolute capture](${path})`,
      projectPath: executionDirs.project, agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    const fileRequests: Array<{ url: string; authorization?: string }> = [];
    const rawRequests: string[] = [];
    fixture.page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/files/content') fileRequests.push({ url: request.url(), authorization: request.headers().authorization });
      if (url.pathname.endsWith('/capture.png')) rawRequests.push(request.url());
    });
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.openChat(chatId);
    const selector = '[data-chat-message-type="assistant-message"] .markdown-image img';
    await fixture.page.waitForFunction((selector) => {
      const images = [...document.querySelectorAll<HTMLImageElement>(selector)];
      return images.length === 2 && images.every((image) => image.src.startsWith('blob:'));
    }, {}, selector);
    expect(fileRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of fileRequests) {
      const query = new URL(request.url).searchParams;
      expect(query.get('executorId')).toBe(client.executorId);
      expect(query.get('projectPath')).toBe(executionDirs.project);
      expect(query.get('path')).toBe('capture.png');
      expect(request.authorization).toBe(`Bearer ${garcon.authToken}`);
    }
    expect(rawRequests).toEqual([]);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 60_000);
