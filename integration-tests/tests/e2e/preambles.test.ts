import { describe, expect, test } from 'bun:test';
import type { PreamblesSnapshot } from '../../../common/preambles.js';
import {
  type E2eFixture,
  withE2eFixture,
} from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

async function clickPreambleRowAction(
  fixture: E2eFixture,
  title: string,
  action: string,
): Promise<void> {
  await fixture.page.waitForFunction(({ title, action }) => {
    const row = [...document.querySelectorAll<HTMLElement>('article')]
      .find((element) => element.textContent?.includes(title));
    const button = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((element) => element.getAttribute('aria-label') === action);
    return Boolean(button && !button.disabled);
  }, { timeout: 20_000 }, { title, action });
  await fixture.page.evaluate(({ title, action }) => {
    const row = [...document.querySelectorAll<HTMLElement>('article')]
      .find((element) => element.textContent?.includes(title));
    const button = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((element) => element.getAttribute('aria-label') === action);
    if (!button) throw new Error(`Missing ${action} action for ${title}.`);
    button.click();
  }, { title, action });
}

describe('Lightpanda preambles', () => {
  test('manages the catalog and renders an application notice', async () => {
    await withE2eFixture('preambles', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();

      await app.clickButton('More actions');
      await app.waitForMenuItemEnabled('Preambles');
      await app.clickMenuItem('Preambles');
      await app.waitForButton('Add preamble');

      await app.clickButton('Add preamble');
      await app.fill('#preamble-title', 'Global UI rules');
      await app.fill(
        'textarea[placeholder="Write instructions to prepend to matching new chats..."]',
        'SYNTHETIC_GLOBAL_UI_BODY',
      );
      await app.waitForButton('Save Preamble');
      await app.clickButton('Save Preamble');
      await app.waitForText('Global UI rules');

      await app.clickButton('Add preamble');
      await app.fill('#preamble-title', 'Project UI rules');
      await app.fill(
        'textarea[placeholder="Write instructions to prepend to matching new chats..."]',
        'SYNTHETIC_PROJECT_UI_BODY',
      );
      await fixture.page.$$eval(
        'input[type="radio"][name="preamble-scope"]',
        (elements) => (elements[1] as HTMLInputElement | undefined)?.click(),
      );
      await app.clickButton('Add project path');
      await app.fill('input[aria-label="Project path"]', fixture.integration.dirs.project);
      await fixture.page.$eval(
        'input[type="checkbox"]',
        (element) => (element as HTMLInputElement).click(),
      );
      await app.waitForButton('Save Preamble');
      await app.clickButton('Save Preamble');
      await app.waitForText('Project UI rules');

      await app.fill(
        'input[placeholder="Filter by title, text, or project path"]',
        fixture.integration.dirs.project,
      );
      await app.waitForText('Project UI rules');
      expect(await app.exactTextCount('Global UI rules')).toBe(0);
      expect(await fixture.page.$eval(
        'article button[aria-label="Move preamble up"]',
        (element) => (element as HTMLButtonElement).disabled,
      )).toBeTrue();
      await app.clickButton('Clear preamble filter');
      await app.waitForText('Global UI rules');

      await clickPreambleRowAction(fixture, 'Project UI rules', 'Move preamble up');
      await fixture.page.waitForFunction(
        () => [...document.querySelectorAll<HTMLElement>('article h3')]
          .map((element) => element.textContent?.trim())
          .join('|') === 'Project UI rules|Global UI rules',
        { timeout: 20_000 },
      );

      await clickPreambleRowAction(fixture, 'Global UI rules', 'Edit preamble');
      await app.fill('#preamble-title', 'Global UI rules renamed');
      await app.clickButton('Save Preamble');
      await app.waitForText('Global UI rules renamed');

      await clickPreambleRowAction(fixture, 'Project UI rules', 'Remove preamble');
      await app.waitForButton('Remove preamble');
      await app.clickButton('Remove preamble', { last: true });
      await fixture.page.waitForFunction(
        () => ![...document.querySelectorAll<HTMLElement>('article')]
          .some((element) => element.textContent?.includes('Project UI rules')),
        { timeout: 20_000 },
      );

      const catalog = await fixture.integration.client.get<PreamblesSnapshot>('/api/v1/preambles');
      expect(catalog.preambles.map((preamble) => preamble.title)).toEqual([
        'Global UI rules renamed',
      ]);

      await app.clickButton('Close');
      const chatId = fixture.integration.newChatId();
      const held = fixture.integration.fakeProviders.openAi.holdNext({
        model: fixture.integration.directAgents.openAi.provider.model,
      });
      const started = await fixture.integration.client.startDirectChat({
        chatId,
        content: 'visible UI boundary prompt',
        projectPath: fixture.integration.dirs.project,
        agent: fixture.integration.directAgents.openAi,
      });
      await held.received;
      expect(held.releaseText('visible UI response')).toBeTrue();
      await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);

      await app.openChat(chatId);
      await app.waitForText('Preambles applied');
      await app.waitForText('Global UI rules renamed');
      expect(await app.exactTextCount('SYNTHETIC_GLOBAL_UI_BODY')).toBe(0);
      fixture.assertNoBrowserErrors();
    });
  }, 60_000);
});
