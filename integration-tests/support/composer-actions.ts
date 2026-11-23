import type { Locator, Page } from 'playwright';

export async function openComposerSnippets(page: Page, composer: Locator) {
  const shortcut = composer.getByRole('button', { name: 'Snippets', exact: true });
  if (await shortcut.isVisible()) {
    await shortcut.click();
    return;
  }
  await composer.locator('[data-composer-overflow="prompt"]').click();
  await page.getByRole('menuitem', { name: /Snippets/ }).click();
}
