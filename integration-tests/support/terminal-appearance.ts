import type { Page } from 'playwright';
import { expect as browserExpect } from 'playwright/test';

export async function setTerminalAppearance(page: Page, terminalAppearance: boolean): Promise<void> {
  await page.evaluate((terminalAppearance) => {
    const key = 'pref_local_settings';
    localStorage.setItem(key, JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? '{}'),
      terminalAppearance,
    }));
    window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
  }, terminalAppearance);
  await browserExpect(page.locator('html')).toHaveAttribute(
    'data-theme-appearance',
    terminalAppearance ? 'terminal' : 'standard',
  );
}
