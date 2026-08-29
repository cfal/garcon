import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  createIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';
import { withTimeout } from '../../support/deferred.js';
import { requireCurrentWebBuild } from '../../support/web-build-gate.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ARTIFACT_ROOT = join(REPO_ROOT, 'integration-tests', 'artifacts', 'chromium');
const PANEL_SELECTOR =
  '[role="tabpanel"][data-workspace-surface-id="singleton:git-history"][aria-hidden="false"]';
const COMPARE_PANEL_SELECTOR =
  '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"][aria-hidden="false"]';
const DETAILS_SELECTOR = `${PANEL_SELECTOR} [data-git-diff-document]`;
const SEGMENTED_SELECTOR = `${DETAILS_SELECTOR} [data-git-history-segmented-navigation]`;
const FILES_PANE_SELECTOR = `${DETAILS_SELECTOR} [data-git-history-files-pane]`;
const DIFF_PANE_SELECTOR = `${DETAILS_SELECTOR} [data-git-history-diff-pane]`;

// Desktop viewport whose workspace window lands inside the 560-839px band the
// removed compact tier once covered: viewport minus chat list and divider.
const BAND_VIEWPORT = { width: 1_000, height: 900 };
const WIDE_VIEWPORT = { width: 1_440, height: 900 };
const GIT_COMMAND_TIMEOUT_MS = 10_000;
const FIXTURE_SETUP_TIMEOUT_MS = 25_000;
const SCENARIO_TIMEOUT_MS = 50_000;
const DIAGNOSTIC_TIMEOUT_MS = 8_000;
const BROWSER_DISPOSE_TIMEOUT_MS = 10_000;
const INTEGRATION_DISPOSE_TIMEOUT_MS = 30_000;

interface ChromiumFixture {
  integration: IntegrationFixture;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  browserErrors: string[];
}

type MarkPhase = (phase: string) => void;

async function runGit(projectPath: string, args: string[]): Promise<void> {
  const process = Bun.spawn(['git', ...args], {
    cwd: projectPath,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let result: [string, string, number];
  try {
    result = await withTimeout(
      Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]),
      GIT_COMMAND_TIMEOUT_MS,
      () => `Timed out running git ${args[0] ?? '<unknown>'}.`,
    );
  } catch (error) {
    process.kill('SIGKILL');
    await withTimeout(process.exited, 1_000, () => 'Timed out terminating git.').catch(
      () => undefined,
    );
    throw error;
  }
  const [, stderr, exitCode] = result;
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
  // Gates on a current web build before any server or browser starts.
  await requireCurrentWebBuild();
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
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(20_000);
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
  const safeName = testName
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const prefix = join(ARTIFACT_ROOT, `${safeName || 'chromium'}-${Date.now()}`);
  await mkdir(join(ARTIFACT_ROOT), { recursive: true });
  await fixture.page
    .screenshot({ path: `${prefix}.png`, fullPage: true, timeout: 3_000 })
    .catch(() => undefined);
  const html = await withTimeout(
    fixture.page.content(),
    3_000,
    () => 'Timed out capturing Chromium page content.',
  ).catch(() => '');
  await writeFile(`${prefix}.html`, html).catch(() => undefined);
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
  const results = await Promise.allSettled([
    (async () => {
      const errors: unknown[] = [];
      try {
        await withTimeout(
          fixture.context.close(),
          BROWSER_DISPOSE_TIMEOUT_MS / 2,
          () => 'Timed out closing the Chromium context.',
        );
      } catch (error) {
        errors.push(error);
      }
      try {
        await withTimeout(
          fixture.browser.close(),
          BROWSER_DISPOSE_TIMEOUT_MS / 2,
          () => 'Timed out closing the Chromium browser.',
        );
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Chromium browser cleanup failed.');
      }
    })(),
    withTimeout(
      fixture.integration.dispose(),
      INTEGRATION_DISPOSE_TIMEOUT_MS,
      () => 'Timed out closing the Garcon integration fixture.',
    ),
  ]);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length > 0) throw new AggregateError(errors, 'Chromium fixture cleanup failed.');
}

async function withChromiumFixture<T>(
  testName: string,
  run: (fixture: ChromiumFixture, markPhase: MarkPhase) => Promise<T>,
): Promise<T> {
  const fixture = await withTimeout(
    createChromiumFixture(),
    FIXTURE_SETUP_TIMEOUT_MS,
    () => `Chromium fixture setup timed out for ${testName}.`,
  );
  let failure: unknown;
  let phase = 'starting scenario';
  try {
    return await withTimeout(
      run(fixture, (nextPhase) => {
        phase = nextPhase;
      }),
      SCENARIO_TIMEOUT_MS,
      () => `Chromium scenario ${testName} timed out while ${phase}.`,
    );
  } catch (error) {
    failure = error;
    const artifact = await withTimeout(
      writeDiagnostics(testName, fixture, error),
      DIAGNOSTIC_TIMEOUT_MS,
      () => `Chromium diagnostics timed out for ${testName}.`,
    ).catch(() => null);
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
    (expected) =>
      document
        .querySelector('[data-git-diff-document]')
        ?.getAttribute('data-git-history-layout') === expected,
    layout,
    { timeout: 20_000 },
  );
}

async function openChatWorkspace(
  fixture: ChromiumFixture,
  projectPath: string,
  seed: string,
): Promise<void> {
  const chatId = fixture.integration.newChatId();
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content: seed,
    projectPath,
    agent: fixture.integration.directAgents.openAi,
  });
  await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);

  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
  await fixture.page.locator('[data-workspace-window-titlebar]').waitFor({
    state: 'visible',
    timeout: 20_000,
  });
}

async function openWorkspaceSurface(page: Page, label: string): Promise<void> {
  await page
    .locator('[data-workspace-window-current="true"] [data-workspace-window-menu-trigger]')
    .click();
  await page.getByRole('menuitem', { name: label }).click();
}

async function verifyHistoryBreakpoints(
  fixture: ChromiumFixture,
  markPhase: MarkPhase,
): Promise<void> {
  markPhase('opening Git History');
  await openWorkspaceSurface(fixture.page, 'Open Git History');
  await fixture.page.locator(PANEL_SELECTOR).waitFor({ state: 'visible' });
  await fixture.page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.textContent?.includes('second revision') === true,
    PANEL_SELECTOR,
  );
  await fixture.page
    .locator('button[data-git-history-commit-row][aria-label*="second revision"]')
    .click();
  await fixture.page
    .getByRole('button', { name: 'Back to commit history' })
    .waitFor({ state: 'visible' });

  markPhase('checking the wide History layout');
  await waitForLayout(fixture.page, 'wide');
  expect(await fixture.page.locator(SEGMENTED_SELECTOR).count()).toBe(0);
  expect(
    await fixture.page.locator(`${DETAILS_SELECTOR} [data-git-file-tree-toggle]`).count(),
  ).toBe(1);
  expect(await fixture.page.locator(`${DETAILS_SELECTOR} [data-git-tree-resizer]`).count()).toBe(1);

  markPhase('checking the narrow History layout');
  await fixture.page.setViewportSize(BAND_VIEWPORT);
  await waitForLayout(fixture.page, 'narrow');
  const containerWidth = await fixture.page
    .locator(DETAILS_SELECTOR)
    .evaluate((element: Element) => element.getBoundingClientRect().width);
  expect(containerWidth).toBeGreaterThanOrEqual(560);
  expect(containerWidth).toBeLessThan(840);
  expect(await fixture.page.locator(SEGMENTED_SELECTOR).count()).toBe(1);
  expect(
    await fixture.page.locator(`${DETAILS_SELECTOR} [data-git-file-tree-toggle]`).count(),
  ).toBe(0);
  expect(await fixture.page.locator(`${DETAILS_SELECTOR} [data-git-tree-resizer]`).count()).toBe(0);
  await fixture.page.waitForSelector(`${FILES_PANE_SELECTOR}[aria-hidden="false"]`);

  await fixture.page
    .locator(`${FILES_PANE_SELECTOR} [data-git-file-list-row]`, {
      hasText: 'review.txt',
    })
    .click();
  await fixture.page.waitForSelector(`${DIFF_PANE_SELECTOR}[aria-hidden="false"]`);
  await fixture.page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.textContent?.includes('first revision') === true,
    DIFF_PANE_SELECTOR,
  );
  await fixture.page.locator(`${SEGMENTED_SELECTOR} button`, { hasText: 'Files' }).click();
  await fixture.page.waitForSelector(`${FILES_PANE_SELECTOR}[aria-hidden="false"]`);

  markPhase('restoring the History tree preference');
  await fixture.page.setViewportSize(WIDE_VIEWPORT);
  await waitForLayout(fixture.page, 'wide');
  await fixture.page.getByRole('button', { name: 'Hide file tree' }).click();
  await fixture.page.waitForSelector(`${FILES_PANE_SELECTOR}[aria-hidden="true"]`, {
    state: 'attached',
  });
  await fixture.page.setViewportSize(BAND_VIEWPORT);
  await waitForLayout(fixture.page, 'narrow');
  await fixture.page.setViewportSize(WIDE_VIEWPORT);
  await waitForLayout(fixture.page, 'wide');
  await fixture.page.waitForSelector(`${FILES_PANE_SELECTOR}[aria-hidden="true"]`, {
    state: 'attached',
  });
  await fixture.page.getByRole('button', { name: 'Show file tree' }).click();
  await fixture.page.waitForSelector(`${FILES_PANE_SELECTOR}[aria-hidden="false"]`);
  expect(await fixture.page.locator(`${DETAILS_SELECTOR} [data-git-tree-resizer]`).count()).toBe(1);
  expect(fixture.browserErrors).toEqual([]);
}

async function verifyCompareResponsiveActions(
  fixture: ChromiumFixture,
  markPhase: MarkPhase,
): Promise<void> {
  markPhase('opening Git Compare');
  await openWorkspaceSurface(fixture.page, 'Open Git Compare');
  await fixture.page.locator(COMPARE_PANEL_SELECTOR).waitFor({ state: 'visible' });
  await fixture.page.locator(`${COMPARE_PANEL_SELECTOR} [data-git-diff-document]`).waitFor({
    state: 'visible',
  });

  markPhase('collapsing the Compare actions');
  const actionRoot = fixture.page.locator(
    `${COMPARE_PANEL_SELECTOR} [data-responsive-surface-actions]`,
  );
  await actionRoot.evaluate((element: HTMLElement) => {
    element.style.flex = '0 0 32px';
    element.style.width = '32px';
  });
  await fixture.page.waitForFunction((selector) => {
    const root = document.querySelector(selector);
    return root?.querySelectorAll('[data-surface-action-id]').length === 0;
  }, `${COMPARE_PANEL_SELECTOR} [data-responsive-surface-actions]`);

  const visibleButtons = await actionRoot.locator('button').evaluateAll((buttons) =>
    buttons
      .filter((button) => {
        const style = getComputedStyle(button);
        return style.visibility !== 'hidden' && button.getBoundingClientRect().width > 0;
      })
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      }),
  );
  expect(visibleButtons).toHaveLength(1);
  expect(visibleButtons[0]?.width).toBe(32);
  expect(await actionRoot.locator('[data-responsive-surface-menu-trigger]').count()).toBe(1);
  expect(
    await fixture.page
      .locator(COMPARE_PANEL_SELECTOR)
      .getByRole('button', { name: 'Diff settings' })
      .count(),
  ).toBe(0);

  markPhase('checking the Compare action menu');
  await actionRoot.locator('[data-responsive-surface-menu-trigger]').click();
  const menu = fixture.page.locator('[data-slot="dropdown-menu-content"]');
  await menu.getByText('Diff settings', { exact: true }).waitFor({ state: 'visible' });
  const order = await menu.evaluate((element) => {
    const settings = Array.from(element.querySelectorAll('*')).find(
      (candidate) => candidate.textContent?.trim() === 'Diff settings',
    );
    const separator = element.querySelector('[data-slot="dropdown-menu-separator"]');
    const refresh = Array.from(element.querySelectorAll('[role="menuitem"]')).find(
      (candidate) => candidate.textContent?.trim() === 'Refresh',
    );
    if (!settings || !separator || !refresh) return null;
    return {
      settingsBeforeSeparator: Boolean(
        settings.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      separatorBeforeRefresh: Boolean(
        separator.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    };
  });
  expect(order).toEqual({
    settingsBeforeSeparator: true,
    separatorBeforeRefresh: true,
  });
  expect(fixture.browserErrors).toEqual([]);
}

describe('Chromium Git responsive presentation', () => {
  test('keeps History and Compare controls responsive', async () => {
    // A shared fixture prevents redundant Chromium and Garcon process churn for one repository.
    await withChromiumFixture('git-responsive-presentation', async (fixture, markPhase) => {
      const project = fixture.integration.dirs.project;
      markPhase('creating Git history');
      await createHistoryFixture(project);
      markPhase('opening the chat workspace');
      await openChatWorkspace(fixture, project, 'git-responsive-presentation-seed');
      await verifyHistoryBreakpoints(fixture, markPhase);

      markPhase('creating the Compare working tree change');
      await writeFile(join(project, 'review.txt'), 'working tree revision\n', 'utf8');
      await verifyCompareResponsiveActions(fixture, markPhase);
    });
  });
});
