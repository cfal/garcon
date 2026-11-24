import type { Locator, Page } from 'playwright';
import type { Page as PuppeteerPage } from 'puppeteer-core';

export async function clickInlineComposerButton(page: PuppeteerPage, selector: string): Promise<boolean> {
  await page.waitForSelector(selector);
  return page.$eval(selector, element => {
    const button = element as HTMLButtonElement;
    if (button.hidden) return false;
    button.click();
    return true;
  });
}

export async function openComposerSnippets(page: Page, composer: Locator) {
  const shortcut = composer.getByRole('button', { name: 'Snippets', exact: true });
  if (await shortcut.isVisible()) {
    await shortcut.click();
    return;
  }
  await composer.locator('[data-composer-overflow="prompt"]').click();
  await page.getByRole('menuitem', { name: /Snippets/ }).click();
}
