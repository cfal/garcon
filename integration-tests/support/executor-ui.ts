import type { Page } from 'puppeteer-core';
import { clickInlineComposerButton } from './composer-actions.js';
import { performLightpandaAction } from './lightpanda-action.js';

export async function openModelSelector(page: Page, scope = '[role="dialog"]'): Promise<void> {
  const selector = `${scope} button[data-slot="model-selector-trigger"]:not(:disabled)`;
  const menu = `${scope} :is([data-composer-overflow="settings"], [data-slot="model-selector-overflow"]):not([hidden])`;
  const model = '[role="menuitem"][data-composer-control="model"]';
  await performLightpandaAction(async () => {
    if (await clickInlineComposerButton(page, selector)) return;
    await performLightpandaAction(
      () => page.$eval(menu, (button) => (button as HTMLButtonElement).click()),
      () => page.waitForSelector(model),
    );
    await page.$eval(model, (item) => (item as HTMLElement).click());
  }, () => page.waitForSelector(`${selector}[aria-expanded="true"]`));
}

export async function selectModelOption(page: Page, label: string): Promise<void> {
  const option = await page.waitForFunction(name =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="listbox"] button[role="option"]')]
      .find(button => !button.disabled && button.textContent?.trim() === name)!, {}, label);
  try {
    await option.evaluate(button => button.click());
  } finally {
    await option.dispose();
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
