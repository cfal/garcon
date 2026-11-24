import { expect, test } from 'bun:test';
import { effectiveExecutorId, type CreateExecutorRequest } from '../../../common/executors.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`executor selectors preserve the chat target after the last remote is removed (${executionBackend})`, async () => {
    await withE2eFixture(`executor-selector-visibility-${executionBackend}`, async fixture => {
      const { client, directAgents, executionDirs } = fixture.integration;
      const chatId = fixture.integration.newChatId();
      const started = await client.startDirectChat({
        chatId, agent: directAgents.openAi, projectPath: executionDirs.project,
        content: 'Synthetic executor visibility input',
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await fixture.page.waitForSelector('[data-composer] textarea');
      if (executionBackend === 'in-process') {
        expect(await fixture.page.$('[data-executor-picker]')).toBeNull();
        await app.clickButton('New Chat');
        await fixture.page.waitForFunction(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return dialog && !dialog.querySelector('[role="status"][aria-label="Loading chat defaults..."]');
        });
        expect(await fixture.page.$('[role="dialog"] [data-executor-picker]')).toBeNull();
        await app.clickDialogButton('Close');
      }
      const draft = 'Synthetic preserved executor visibility draft';
      await app.fill('[data-composer] textarea', draft);
      const editor = await fixture.page.$('[data-composer] textarea');
      if (!editor) throw new Error('Composer is missing');
      let remoteId = client.executorId;
      if (executionBackend === 'in-process') {
        const created = await client.post<{ id: string }>('/api/v1/executors', {
          label: 'Synthetic offline worker', direction: 'executor-connects', noTls: true,
        } satisfies CreateExecutorRequest);
        remoteId = created.id;
      } else {
        await client.patch(`/api/v1/executors/${remoteId}`, { enabled: false });
        await app.waitForText('Integration worker is unavailable.');
      }
      await fixture.page.waitForSelector('[data-slot="composer-bottom-bar"] [data-executor-picker]');
      await client.delete(`/api/v1/executors/${remoteId}`);
      const localChat = executionBackend === 'in-process';
      const picker = '[data-composer-toolbar] [data-executor-picker]';
      await fixture.page.waitForFunction((selector, id, local) => {
        const button = document.querySelector(selector);
        return local ? !button : button?.getAttribute('aria-label') === `Executor: Unavailable executor: ${id}`;
      }, {}, picker, remoteId, localChat);
      if (!localChat) {
        await fixture.page.$eval(picker, button => (button as HTMLElement).click());
        const selected = '[role="menuitemradio"][aria-checked="true"][aria-disabled="true"]';
        await fixture.page.waitForSelector(selected);
        expect(await fixture.page.$eval(selected, item => item.textContent)).toContain(remoteId);
        await fixture.page.keyboard.press('Escape');
      }
      for (const [width, height] of [[1_440, 900], [390, 844]] as const) {
        await app.setViewport(width, height);
        if (localChat) {
          expect(await fixture.page.$(picker)).toBeNull();
        } else {
          expect(await fixture.page.$eval(picker, button => button.getAttribute('aria-label')))
            .toBe(`Executor: Unavailable executor: ${remoteId}`);
        }
        expect(await editor.evaluate(element => document.querySelector('[data-composer] textarea') === element)).toBe(true);
        expect(await editor.evaluate(element => element.value)).toBe(draft);
      }
      expect(effectiveExecutorId((await client.getChatSnapshot(chatId)).chat.executorId)).toBe(client.executorId);
      fixture.assertNoBrowserErrors();
    }, { executionBackend });
  }, 90_000);
}
