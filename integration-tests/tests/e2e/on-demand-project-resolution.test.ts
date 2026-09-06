import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda on-demand project resolution', () => {
  test('keeps chat history and drafts quiet until a project surface is presented', async () => {
    await withE2eFixture('on-demand-project-resolution', async (fixture) => {
      const projectPath = join(fixture.integration.dirs.project, 'missing-project');
      await mkdir(projectPath);
      const chatId = fixture.integration.newChatId();
      const started = await fixture.integration.client.startDirectChat({
        chatId,
        content: 'browser unavailable project seed',
        projectPath,
        agent: fixture.integration.directAgents.openAi,
      });
      await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
      await rm(projectPath, { recursive: true });

      const resolutionRequests: string[] = [];
      fixture.page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/v1/projects/resolve') {
          resolutionRequests.push(request.url());
        }
      });
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(390, 844);
      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await fixture.page.waitForFunction(
        () => document.body.textContent?.includes('browser unavailable project seed') === true,
        { timeout: 20_000 },
      );
      await app.fill('textarea[placeholder="Reply..."]', 'draft remains editable');
      await fixture.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      expect(resolutionRequests).toEqual([]);

      await app.clickButton('Files');
      await fixture.page.waitForFunction(
        () => document.body.textContent?.includes('Project folder unavailable') === true,
        { timeout: 20_000 },
      );
      expect(resolutionRequests).toHaveLength(1);
      expect(await fixture.page.$eval(
        'textarea[placeholder="Reply..."]',
        (element) => (element as HTMLTextAreaElement).value,
      )).toBe('draft remains editable');

      await mkdir(projectPath);
      await app.clickButton('Retry');
      await fixture.page.waitForFunction(
        (expectedPath) => document
          .querySelector('[data-file-tree-breadcrumbs] [aria-current="location"]')
          ?.getAttribute('title') === expectedPath,
        { timeout: 20_000 },
        projectPath,
      );
      expect(resolutionRequests).toHaveLength(2);
      fixture.assertNoBrowserErrors();
    });
  }, 30_000);
});
