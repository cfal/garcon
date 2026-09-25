import type { Page } from 'puppeteer-core';

export async function openDialogModelSelector(page: Page): Promise<void> {
  const selector = '[role="dialog"] [data-slot="model-selector-trigger-secondary"]';
  await page.waitForFunction((query) => {
    const button = document.querySelector(query)?.closest('button');
    return button && !button.disabled;
  }, {}, selector);
  await page.$eval(selector, (element) => element.closest('button')!.click());
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
