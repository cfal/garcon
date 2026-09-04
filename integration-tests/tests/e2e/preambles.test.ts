import { describe, expect, test } from 'bun:test';
import type { PreamblesSnapshot } from '../../../common/preambles.js';
import type { ShareChatResponse } from '../../../common/share-types.js';
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
  test('[TLV5-PREAMBLE.06-LIGHTPANDA-01] manages the catalog and renders an application notice', async () => {
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

      await clickPreambleRowAction(fixture, 'Global UI rules', 'Disable Global UI rules');
      await app.waitForText('Disabled');
      await clickPreambleRowAction(fixture, 'Global UI rules', 'Enable Global UI rules');
      await fixture.page.waitForFunction(
        () => ![...document.querySelectorAll<HTMLElement>('article')]
          .some((element) => element.textContent?.includes('Disabled')),
        { timeout: 20_000 },
      );

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
      await fixture.page.evaluate(() => {
        const label = [...document.querySelectorAll<HTMLLabelElement>('label')]
          .find((element) => element.textContent?.includes('Apply to nested paths'));
        const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (!checkbox) throw new Error('Missing nested-path checkbox.');
        checkbox.click();
      });
      await app.waitForButton('Save Preamble');
      await app.clickButton('Save Preamble');
      await app.waitForText('Project UI rules');

      const scopedCatalog = await fixture.integration.client.get<PreamblesSnapshot>(
        '/api/v1/preambles',
      );
      const scoped = scopedCatalog.preambles.find((preamble) => preamble.title === 'Project UI rules');
      expect(scoped?.enabled).toBe(true);
      expect(scoped?.scope).toEqual({
        type: 'project-paths',
        rules: [{ projectPath: fixture.integration.dirs.project, includeNested: true }],
      });

      await app.fill(
        'input[placeholder="Filter by title, text, or project path"]',
        fixture.integration.dirs.project,
      );
      await app.waitForText('Project UI rules');
      expect(await app.exactTextCount('Global UI rules')).toBe(0);
      expect(await fixture.page.$eval(
        'article button[aria-label="Move Project UI rules up"]',
        (element) => (element as HTMLButtonElement).disabled,
      )).toBeTrue();
      await app.clickButton('Clear preamble filter');
      await app.waitForText('Global UI rules');

      await clickPreambleRowAction(fixture, 'Project UI rules', 'Move Project UI rules up');
      await fixture.page.waitForFunction(
        () => [...document.querySelectorAll<HTMLElement>('article h3')]
          .map((element) => element.textContent?.trim())
          .join('|') === 'Project UI rules|Global UI rules',
        { timeout: 20_000 },
      );

      await clickPreambleRowAction(fixture, 'Global UI rules', 'Edit Global UI rules');
      await app.fill('#preamble-title', 'Global UI rules renamed');
      await app.clickButton('Save Preamble');
      await app.waitForText('Global UI rules renamed');

      await clickPreambleRowAction(fixture, 'Project UI rules', 'Remove Project UI rules');
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
      expect(catalog.preambles[0]?.enabled).toBe(true);

      await app.clickButton('Close');
      const held = fixture.integration.fakeProviders.openAi.holdNext({
        model: fixture.integration.directAgents.openAi.provider.model,
      });
      const providerRequest = await app.startOpenAiDirectChat('visible UI boundary prompt', {
        projectPath: fixture.integration.dirs.project,
        requestMatcher: { model: fixture.integration.directAgents.openAi.provider.model },
      });
      expect(providerRequest.lastUserText).toContain('SYNTHETIC_GLOBAL_UI_BODY');
      expect(providerRequest.lastUserText).toEndWith('visible UI boundary prompt');
      expect(held.releaseText('visible UI response')).toBeTrue();
      await app.waitForAssistantMessageContaining('visible UI response');
      await app.waitForChatProcessing(false);

      const chatId = await fixture.page.evaluate(() =>
        decodeURIComponent(globalThis.location.pathname.slice('/chat/'.length)),
      );
      const share = await fixture.integration.client.post<ShareChatResponse>(
        '/api/v1/chats/share',
        { chatId },
      );
      await fixture.page.goto(`${fixture.integration.garcon.baseUrl}${share.shareUrl}`, {
        waitUntil: [],
      });
      await app.waitForText('Preambles applied');
      await app.waitForText('Global UI rules renamed');
      expect(await fixture.page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>('main .chat-message')];
        const noticeIndex = rows.findIndex((element) =>
          element.textContent?.includes('Preambles applied'));
        const userIndex = rows.findIndex((element) =>
          element.textContent?.trim() === 'visible UI boundary prompt');
        return noticeIndex >= 0 && userIndex === noticeIndex + 1;
      })).toBeTrue();
      expect(await fixture.page.evaluate(() =>
        document.body.innerText.includes('SYNTHETIC_GLOBAL_UI_BODY'))).toBeFalse();
      fixture.assertNoBrowserErrors();
    });
  }, 60_000);
});
