import type { Page } from 'puppeteer-core';

export async function openModelSelector(page: Page, scope = '[role="dialog"]'): Promise<void> {
  const selector = `${scope} button[data-slot="model-selector-trigger"]:not(:disabled)`;
  await page.waitForSelector(selector);
  const folded = await page.$eval(selector, (element) => {
    const button = element as HTMLButtonElement;
    if (button.hidden) return true;
    button.click();
    return false;
  });
  if (folded) {
    const menu = `${scope} :is([data-composer-overflow="settings"], [data-slot="model-selector-overflow"]):not([hidden])`;
    await page.$eval(menu, (button) => (button as HTMLButtonElement).click());
    const model = '[role="menuitem"][data-composer-control="model"]';
    await page.waitForSelector(model);
    await page.$eval(model, (item) => (item as HTMLElement).click());
  }
}

export async function selectExecutor(page: Page, trigger: string, label: string): Promise<void> {
  await page.waitForSelector(trigger);
  await page.$eval(trigger, (element) => (element as HTMLButtonElement).click());
  await page.waitForFunction((name) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    .some((item) => item.textContent?.trim() === name && item.getAttribute('aria-disabled') !== 'true'), {}, label);
  await page.evaluate((name) => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((entry) => entry.textContent?.trim() === name);
    if (!item) throw new Error(`Missing executor: ${name}`);
    item.click();
  }, label);
}
