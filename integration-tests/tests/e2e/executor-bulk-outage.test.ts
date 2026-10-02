import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { waitForBulk } from '../../support/executor-bulk-fixture.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('bulk outage preserves file drafts and executor selection while Stop and Git summary work', async () => {
  let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
  try {
    await withE2eFixture('executor-bulk-outage', async fixture => {
      const integration = fixture.integration;
      const { client, executionDirs, directAgents, fakeProviders } = integration;
      await waitForBulk(integration);
      const project = executionDirs.project;
      await initializeFixtureRepository(project);
      await writeFile(join(project, 'draft.txt'), 'Synthetic saved content');
      await writeFile(join(project, 'unloaded.txt'), 'Synthetic second file');
      const chatId = integration.newChatId();
      const seeded = await client.startDirectChat({ chatId, projectPath: project, content: 'Synthetic draft fixture', agent: directAgents.openAi });
      await client.waitForTurnTerminal(chatId, seeded.turnId);
      const app = new SpaDriver(fixture.page, integration);
      await app.setViewport(1_440, 900);
      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      const filesWindow = await app.workspaceWindowIdForSurface('singleton:files');
      const row = (name: string) => `[data-file-tree-row] [title="${join(project, name)}"]`;
      await fixture.page.waitForSelector(row('draft.txt'));
      await fixture.page.$eval(row('draft.txt'), header => (header.closest('[data-file-tree-row]') as HTMLElement).click());
      const filePanel = '[data-workspace-surface-id^="file:"][aria-hidden="false"]';
      await app.waitForText('Synthetic saved content');
      const surface = await fixture.page.$eval(filePanel, element => element.getAttribute('data-workspace-surface-id')!);
      await fixture.page.$eval(`${filePanel} .cm-content`, element => {
        (element as HTMLElement).focus();
        const paste = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(paste, 'clipboardData', { value: {
          files: [], getData: (type: string) => type === 'text/plain' ? 'Synthetic unsaved draft\n' : '',
        } });
        element.dispatchEvent(paste);
      });
      const held = fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic active turn during bulk outage' });
      const started = await client.runDirectChat({ chatId, content: 'Synthetic active turn during bulk outage', agent: directAgents.openAi });
      await held.received;
      await app.waitForText('Processing');
      const primary = proxy!.capture(1);
      proxy!.refuseConnections();
      proxy!.capture(2).disconnect();
      await waitForBulk(integration, 'reconnecting');
      await app.waitForTextAbsent('Reconnecting to executor');
      await app.clickButton('Stop');
      await held.expectAbort();
      expect(await client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ outcome: 'interrupted' });
      expect(await client.post('/api/v1/git/quick-summary', { executorId: client.executorId, project })).toMatchObject({ status: 'ready' });

      await app.selectWorkspaceWindowSurface('Files', filesWindow);
      const failedLoad = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/files/text'
        && new URL(response.url()).searchParams.get('path') === 'unloaded.txt', { timeout: 30_000 });
      await fixture.page.$eval(row('unloaded.txt'), header => (header.closest('[data-file-tree-row]') as HTMLElement).click());
      expect((await failedLoad).status()).toBe(503);
      const picker = '[data-workspace-surface-id="singleton:files"] [data-executor-picker]';
      expect(await fixture.page.$eval(picker, element => element.getAttribute('aria-label'))).toBe('Executor: Integration worker');
      await app.selectWorkspaceWindowSurfaceById(surface);
      expect(await fixture.page.$eval(`[data-workspace-surface-id="${surface}"] .cm-content`, element => element.textContent)).toContain('Synthetic unsaved draft');
      expect(primary.connected).toBe(true);
      proxy!.acceptConnections();
      await waitForBulk(integration);
      fixture.assertNoBrowserErrors();
    }, {
      executionBackend: 'remote-controller-dials', projectRoots: 'separate',
      interceptExecutorConnection: async url => { proxy = await tcpLinkProxy(url); return proxy.url; },
    });
  } finally { await proxy?.close(); }
}, 90_000);
