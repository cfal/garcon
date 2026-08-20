import { describe, expect, test } from 'bun:test';
import type { CDPSession, Locator, Page } from 'playwright';
import type { SnippetsMutationResponse, SnippetsSnapshot } from '../../../common/snippets.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

interface ViewportScenario {
  name: string;
  width: number;
  height: number;
  touch: boolean;
}

const scenarios: ViewportScenario[] = [
  { name: 'desktop', width: 1_440, height: 900, touch: false },
  { name: 'mobile portrait', width: 390, height: 844, touch: true },
  { name: 'mobile keyboard', width: 390, height: 390, touch: true },
  { name: 'mobile landscape', width: 844, height: 390, touch: true },
  { name: 'narrow mobile', width: 320, height: 568, touch: true },
];

async function setViewport(page: Page, cdp: CDPSession, scenario: ViewportScenario): Promise<void> {
  if (scenario.touch) {
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1,
    });
  }
  await page.setViewportSize({ width: scenario.width, height: scenario.height });
  expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(!scenario.touch);
}

async function openNewChat(page: Page, projectPath: string): Promise<Locator> {
  await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
  const composer = page.getByPlaceholder('How can I help you today?');
  const dialog = page.locator('[role="dialog"]').filter({ has: composer });
  await dialog.waitFor();
  await dialog.getByRole('textbox', { name: 'Project Path' }).fill(projectPath);
  const pathOverlay = page.locator('button.fixed.inset-0[aria-label="Close"]');
  if (await pathOverlay.isVisible()) {
    await pathOverlay.click({ position: { x: 4, y: 4 } });
  }
  return dialog;
}

async function openSnippetPalette(page: Page, newChat: Locator): Promise<Locator> {
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('button.fixed.inset-0[aria-label="Close"]')?.click();
  });
  await page.locator('button.fixed.inset-0[aria-label="Close"]').waitFor({ state: 'detached' });
  await newChat
    .getByRole('button', { name: 'Add to prompt' })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await page.getByRole('menuitem', { name: /Snippets/ }).click();
  const palette = page.getByRole('dialog', { name: 'Insert Snippet' });
  await palette.waitFor();
  return palette;
}

async function dialogLayout(dialog: Locator, fieldName: string) {
  return dialog.evaluate((element, accessibleFieldName) => {
    const root = element as HTMLElement;
    const header = root.querySelector<HTMLElement>('[data-slot="dialog-header"]');
    const footer = root.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
    const body = root.querySelector<HTMLElement>('.overflow-y-auto');
    const field = [...root.querySelectorAll<HTMLElement>('input, textarea')].find(
      (candidate) =>
        candidate.getAttribute('aria-label') === accessibleFieldName ||
        ((candidate instanceof HTMLTextAreaElement || candidate instanceof HTMLInputElement) &&
          candidate.labels?.[0]?.textContent?.trim() === accessibleFieldName),
    );
    if (!header || !footer || !body || !field) throw new Error('Missing dialog layout element.');
    const rect = root.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return {
      rect: {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
      headerBottom: headerRect.bottom,
      bodyTop: bodyRect.top,
      bodyBottom: bodyRect.bottom,
      footerTop: footerRect.top,
      footerBottom: footerRect.bottom,
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      dialogOverflow: getComputedStyle(root).overflow,
      fieldFontSize: getComputedStyle(field).fontSize,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  }, fieldName);
}

function expectContainedLayout(
  layout: Awaited<ReturnType<typeof dialogLayout>>,
  scenario: ViewportScenario,
): void {
  expect(layout.rect.top).toBeGreaterThanOrEqual(-1);
  expect(layout.rect.left).toBeGreaterThanOrEqual(-1);
  expect(layout.rect.right).toBeLessThanOrEqual(scenario.width + 1);
  expect(layout.rect.bottom).toBeLessThanOrEqual(scenario.height + 1);
  expect(layout.headerBottom).toBeLessThanOrEqual(layout.bodyTop + 1);
  expect(layout.bodyBottom).toBeLessThanOrEqual(layout.footerTop + 1);
  expect(layout.footerBottom).toBeLessThanOrEqual(layout.rect.bottom + 1);
  expect(layout.bodyOverflowY).toBe('auto');
  expect(layout.dialogOverflow).toBe('hidden');
  expect(layout.documentOverflow).toBeLessThanOrEqual(1);
}

describe('snippet default argument layouts', () => {
  test('keeps management and review dialogs usable across desktop and mobile', async () => {
    await withChromiumFixture('snippet-default-arguments-layout', async (fixture, markPhase) => {
      const savedDefault = Array.from(
        { length: 8 },
        (_, index) => `default line ${String(index + 1)}`,
      ).join('\n');
      const snapshot = await fixture.integration.client.get<SnippetsSnapshot>('/api/v1/snippets');
      await fixture.integration.client.post<SnippetsMutationResponse>('/api/v1/snippets', {
        expectedRevision: snapshot.revision,
        snippet: {
          shortName: 'review',
          template: 'Review {{arguments}} in {{project_path}}',
          defaultArguments: savedDefault,
        },
      });

      const cdp = await fixture.context.newCDPSession(fixture.page);
      for (const scenario of scenarios) {
        markPhase(`checking ${scenario.name} snippet dialogs`);
        await setViewport(fixture.page, cdp, scenario);
        const response = await fixture.page.goto(fixture.integration.garcon.baseUrl);
        if (!response?.ok())
          throw new Error(`SPA navigation failed with ${String(response?.status())}.`);
        await fixture.page.getByRole('button', { name: 'New Chat', exact: true }).first().waitFor();
        await fixture.page.waitForFunction(
          (height) =>
            document.documentElement.style.getPropertyValue('--app-height') ===
            `${String(height)}px`,
          scenario.height,
        );
        const newChat = await openNewChat(fixture.page, fixture.integration.dirs.project);

        const palette = await openSnippetPalette(fixture.page, newChat);
        await palette.getByRole('button', { name: 'Edit snippets' }).click();
        const manager = fixture.page.getByRole('dialog', { name: 'Snippets' });
        await manager.waitFor();
        const rowLayout = await manager
          .locator('article')
          .filter({ hasText: 'review' })
          .evaluate((element) => {
            const row = element as HTMLElement;
            const actions = [...row.querySelectorAll<HTMLButtonElement>('button')].map((button) => {
              const rect = button.getBoundingClientRect();
              return { width: rect.width, height: rect.height };
            });
            const summary = [...row.querySelectorAll<HTMLElement>('p')].find((paragraph) =>
              paragraph.textContent?.startsWith('Default:'),
            );
            return {
              overflow: row.scrollWidth - row.clientWidth,
              summaryLines: summary
                ? Math.round(
                    summary.getBoundingClientRect().height /
                      Number.parseFloat(getComputedStyle(summary).lineHeight),
                  )
                : 0,
              actions,
            };
          });
        expect(rowLayout.overflow).toBeLessThanOrEqual(1);
        expect(rowLayout.summaryLines).toBe(1);
        expect(rowLayout.actions).toEqual([
          { width: 32, height: 32 },
          { width: 32, height: 32 },
        ]);
        const add = manager.getByRole('button', { name: 'Add snippet' });
        await expect(add.isEnabled()).resolves.toBe(true);
        await add.click();

        const form = fixture.page.getByRole('dialog', { name: 'Add Snippet' });
        await form.waitFor();
        await form.getByRole('textbox', { name: 'Short name' }).fill('layout_test');
        await form
          .getByRole('textbox', { name: 'Snippet text' })
          .fill(Array.from({ length: 20 }, () => 'Review {{arguments}}').join('\n'));
        await form
          .getByRole('textbox', { name: 'Default arguments (optional)' })
          .fill(Array.from({ length: 12 }, () => 'staged changes').join('\n'));
        const formLayout = await dialogLayout(form, 'Default arguments (optional)');
        expectContainedLayout(formLayout, scenario);
        expect(formLayout.fieldFontSize).toBe(scenario.touch ? '16px' : '14px');
        if (scenario.touch) {
          expect(formLayout.rect.width).toBeGreaterThanOrEqual(scenario.width - 1);
          expect(formLayout.rect.height).toBeGreaterThanOrEqual(scenario.height - 1);
        } else {
          expect(formLayout.rect.width).toBeLessThanOrEqual(672);
          expect(formLayout.rect.height).toBeLessThanOrEqual(672);
        }
        if (scenario.name === 'mobile landscape') {
          expect(formLayout.bodyScrollHeight).toBeGreaterThan(formLayout.bodyClientHeight);
        }
        await form.getByRole('button', { name: 'Cancel' }).click();
        await manager.getByRole('button', { name: 'Close' }).click();

        const reopenedPalette = await openSnippetPalette(fixture.page, newChat);
        await reopenedPalette.getByRole('option', { name: /^review/ }).click();
        const argumentsDialog = fixture.page.getByRole('dialog', {
          name: 'Arguments for /snippet review',
        });
        await argumentsDialog.waitFor();
        await fixture.page.waitForFunction((expected) => {
          const field = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find(
            (element) => element.labels?.[0]?.textContent?.trim() === 'Arguments',
          );
          return (
            field?.value === expected &&
            document.activeElement === field &&
            field.selectionStart === expected.length &&
            field.selectionEnd === expected.length
          );
        }, savedDefault);
        const argumentsLayout = await dialogLayout(argumentsDialog, 'Arguments');
        expectContainedLayout(argumentsLayout, scenario);
        expect(argumentsLayout.fieldFontSize).toBe(scenario.touch ? '16px' : '14px');
        expect(argumentsLayout.rect.width).toBeLessThanOrEqual(
          Math.min(512, scenario.width - (scenario.touch ? 8 : 0)) + 1,
        );
        await argumentsDialog.getByRole('button', { name: 'Cancel' }).click();
      }
      fixture.assertNoBrowserErrors();
    });
  });
});
