import { describe, expect, test } from 'bun:test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  createIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB_BUILD_INDEX = join(REPO_ROOT, 'web', 'build', 'index.html');
const ARTIFACT_ROOT = join(REPO_ROOT, 'integration-tests', 'artifacts', 'chromium');
const PANEL_SELECTOR =
  '[role="tabpanel"][data-workspace-surface-id="singleton:git-history"][aria-hidden="false"]';
const DETAILS_SELECTOR = `${PANEL_SELECTOR} [data-git-diff-document]`;
const SEGMENTED_SELECTOR = `${DETAILS_SELECTOR} [data-git-history-segmented-navigation]`;
const FILES_PANE_SELECTOR = `${DETAILS_SELECTOR} [data-git-history-files-pane]`;
const DIFF_PANE_SELECTOR = `${DETAILS_SELECTOR} [data-git-history-diff-pane]`;

// Desktop viewport whose workspace main pane lands inside the 560-839px band the
// removed compact tier once covered: viewport minus chat list and divider.
const BAND_VIEWPORT = { width: 1_000, height: 900 };
const WIDE_VIEWPORT = { width: 1_440, height: 900 };

interface ChromiumFixture {
  integration: IntegrationFixture;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  browserErrors: string[];
}

async function runGit(projectPath: string, args: string[]): Promise<void> {
  const process = Bun.spawn(['git', ...args], {
    cwd: projectPath,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
}

async function createHistoryFixture(projectPath: string): Promise<void> {
  await runGit(projectPath, ['init', '-b', 'main']);
  await runGit(projectPath, ['config', 'user.email', 'test@example.com']);
  await runGit(projectPath, ['config', 'user.name', 'E2E Test']);
  await writeFile(join(projectPath, 'review.txt'), 'first revision\n', 'utf8');
  await runGit(projectPath, ['add', 'review.txt']);
  await runGit(projectPath, ['commit', '-m', 'first revision']);
  await writeFile(join(projectPath, 'review.txt'), 'second revision\n', 'utf8');
  await runGit(projectPath, ['commit', '-am', 'second revision']);
}

async function createChromiumFixture(): Promise<ChromiumFixture> {
  await access(WEB_BUILD_INDEX);
  const integration = await createIntegrationFixture();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: WIDE_VIEWPORT });
    await context.addInitScript(() => {
      const localSettingsKey = 'pref_local_settings';
      try {
        const stored = JSON.parse(globalThis.localStorage.getItem(localSettingsKey) ?? '{}');
        const snapshot =
          stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
        globalThis.localStorage.setItem(
          localSettingsKey,
          JSON.stringify({ ...snapshot, allowDirectChats: true }),
        );
      } catch {
        globalThis.localStorage.setItem(
          localSettingsKey,
          JSON.stringify({ allowDirectChats: true }),
        );
      }
    });
    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(`console.error: ${message.text()}`);
    });
    return { integration, browser, context, page, browserErrors };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await integration.dispose().catch(() => undefined);
    throw error;
  }
}

async function writeDiagnostics(
  testName: string,
  fixture: ChromiumFixture,
  error: unknown,
): Promise<string> {
  const safeName = testName.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const prefix = join(ARTIFACT_ROOT, `${safeName || 'chromium'}-${Date.now()}`);
  await mkdir(join(ARTIFACT_ROOT), { recursive: true });
  await fixture.page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => undefined);
  await writeFile(`${prefix}.html`, await fixture.page.content().catch(() => '')).catch(
    () => undefined,
  );
  await writeFile(
    `${prefix}.json`,
    JSON.stringify(
      {
        testName,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
        url: fixture.page.url(),
        browserErrors: fixture.browserErrors,
        integration: fixture.integration.diagnostics(),
      },
      null,
      2,
    ),
  );
  return `${prefix}.json`;
}

async function disposeChromiumFixture(fixture: ChromiumFixture): Promise<void> {
  const errors: unknown[] = [];
  try {
    await fixture.context.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await fixture.browser.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await fixture.integration.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Chromium fixture cleanup failed.');
}

async function withChromiumFixture<T>(
  testName: string,
  run: (fixture: ChromiumFixture) => Promise<T>,
): Promise<T> {
  const fixture = await createChromiumFixture();
  let failure: unknown;
  try {
    return await run(fixture);
  } catch (error) {
    failure = error;
    const artifact = await writeDiagnostics(testName, fixture, error).catch(() => null);
    if (artifact && error instanceof Error) {
      error.message = `${error.message}\nChromium diagnostics: ${artifact}`;
    }
    throw error;
  } finally {
    try {
      await disposeChromiumFixture(fixture);
    } catch (disposeError) {
      if (failure === undefined) throw disposeError;
      console.error(disposeError);
    }
  }
}

async function waitForLayout(page: Page, layout: 'narrow' | 'wide'): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelector('[data-git-diff-document]')
      ?.getAttribute('data-git-history-layout') === expected,
    layout,
    { timeout: 20_000 },
  );
}

describe('Chromium Git History breakpoint presentation', () => {
  test('segments commit details in the 560-839px band and keeps the tree toggle in wide', async () => {
    await withChromiumFixture('git-history-breakpoints', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await createHistoryFixture(project);

      const chatId = fixture.integration.newChatId();
      const started = await fixture.integration.client.startDirectChat({
        chatId,
        content: 'history-breakpoints-seed',
        projectPath: project,
        agent: fixture.integration.directAgents.openAi,
      });
      await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);

      const response = await fixture.page.goto(
        `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
        { waitUntil: 'domcontentloaded' },
      );
      if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
      await fixture.page.locator('[data-floating-workspace-toolbar]').waitFor({
        state: 'visible',
        timeout: 20_000,
      });

      await fixture.page
        .locator(
          '[data-floating-workspace-toolbar] [data-workspace-taskbar-end]'
            + ' [data-slot="dropdown-menu-trigger"]',
        )
        .click();
      await fixture.page.getByRole('menuitem', { name: 'Open Git History' }).click();
      await fixture.page.locator(PANEL_SELECTOR).waitFor({ state: 'visible', timeout: 20_000 });
      await fixture.page.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent?.includes('second revision')
          === true,
        PANEL_SELECTOR,
        { timeout: 20_000 },
      );
      await fixture.page
        .locator('button[data-git-history-commit-row][aria-label*="second revision"]')
        .click();
      await fixture.page
        .getByRole('button', { name: 'Back to commit history' })
        .waitFor({ state: 'visible', timeout: 20_000 });

      await waitForLayout(fixture.page, 'wide');
      expect(await fixture.page.locator(SEGMENTED_SELECTOR).count()).toBe(0);
      expect(await fixture.page.locator(`${DETAILS_SELECTOR} [data-git-file-tree-toggle]`).count())
        .toBe(1);
      expect(await fixture.page.locator(`${DETAILS_SELECTOR} [data-git-tree-resizer]`).count())
        .toBe(1);

      await fixture.page.setViewportSize(BAND_VIEWPORT);
      await waitForLayout(fixture.page, 'narrow');
      const containerWidth = await fixture.page
        .locator(DETAILS_SELECTOR)
        .evaluate((element: Element) => element.getBoundingClientRect().width);
      expect(containerWidth).toBeGreaterThanOrEqual(560);
      expect(containerWidth).toBeLessThan(840);
      expect(await fixture.page.locator(SEGMENTED_SELECTOR).count()).toBe(1);
      expect(await fixture.page.locator(`${DETAILS_SELECTOR} [data-git-file-tree-toggle]`).count())
        .toBe(0);
      expect(await fixture.page.locator(`${DETAILS_SELECTOR} [data-git-tree-resizer]`).count())
        .toBe(0);
      await fixture.page.waitForSelector(`${FILES_PANE_SELECTOR}[aria-hidden="false"]`, {
        timeout: 20_000,
      });

      await fixture.page
        .locator(`${FILES_PANE_SELECTOR} [data-git-file-list-row]`, { hasText: 'review.txt' })
        .click();
      await fixture.page.waitForSelector(`${DIFF_PANE_SELECTOR}[aria-hidden="false"]`, {
        timeout: 20_000,
      });
      await fixture.page.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent?.includes('first revision')
          === true,
        DIFF_PANE_SELECTOR,
        { timeout: 20_000 },
      );
      await fixture.page
        .locator(`${SEGMENTED_SELECTOR} button`, { hasText: 'Files' })
        .click();
      await fixture.page.waitForSelector(`${FILES_PANE_SELECTOR}[aria-hidden="false"]`, {
        timeout: 20_000,
      });

      // The hidden-tree preference survives repeated breakpoint crossings.
      await fixture.page.setViewportSize(WIDE_VIEWPORT);
      await waitForLayout(fixture.page, 'wide');
      await fixture.page.getByRole('button', { name: 'Hide file tree' }).click();
      await fixture.page.waitForSelector(`${FILES_PANE_SELECTOR}[aria-hidden="true"]`, {
        state: 'attached',
        timeout: 20_000,
      });
      await fixture.page.setViewportSize(BAND_VIEWPORT);
      await waitForLayout(fixture.page, 'narrow');
      await fixture.page.setViewportSize(WIDE_VIEWPORT);
      await waitForLayout(fixture.page, 'wide');
      await fixture.page.waitForSelector(`${FILES_PANE_SELECTOR}[aria-hidden="true"]`, {
        state: 'attached',
        timeout: 20_000,
      });
      await fixture.page.getByRole('button', { name: 'Show file tree' }).click();
      await fixture.page.waitForSelector(`${FILES_PANE_SELECTOR}[aria-hidden="false"]`, {
        timeout: 20_000,
      });
      expect(await fixture.page.locator(`${DETAILS_SELECTOR} [data-git-tree-resizer]`).count())
        .toBe(1);
      expect(fixture.browserErrors).toEqual([]);
    });
  });
});
