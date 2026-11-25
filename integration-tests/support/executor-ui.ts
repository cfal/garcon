import type { Page } from 'puppeteer-core';
import { clickInlineComposerButton } from './composer-actions.js';
import { performLightpandaAction } from './lightpanda-action.js';

export async function openModelSelector(page: Page, scope = '[role="dialog"]'): Promise<void> {
  const trigger = `${scope} button[data-slot="model-selector-trigger"]:not(:disabled)`;

  async function clickModelControl() {
    // A lost inline reply must reach the expansion check, not dispatch another click.
    if (await clickInlineComposerButton(page, trigger)) return;

    const overflowTrigger = `${scope} :is([data-composer-overflow="settings"], [data-slot="model-selector-overflow"]):not([hidden])`;
    const modelItem = '[role="menuitem"][data-composer-control="model"]';
    await performLightpandaAction(
      () => page.$eval(overflowTrigger, (button) => (button as HTMLButtonElement).click()),
      () => page.waitForSelector(modelItem),
    );
    await page.$eval(modelItem, (item) => (item as HTMLElement).click());
  }

  await performLightpandaAction(clickModelControl, () => page.waitForSelector(`${trigger}[aria-expanded="true"]`));
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
