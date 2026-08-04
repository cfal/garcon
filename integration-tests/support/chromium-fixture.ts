import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  createIntegrationFixture,
  type IntegrationFixture,
  type IntegrationFixtureOptions,
} from './integration-fixture.js';
import { withTimeout } from './deferred.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB_BUILD_INDEX = join(REPO_ROOT, 'web', 'build', 'index.html');
const ARTIFACT_ROOT = join(REPO_ROOT, 'integration-tests', 'artifacts', 'chromium');
const FIXTURE_SETUP_TIMEOUT_MS = 25_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const DIAGNOSTIC_TIMEOUT_MS = 8_000;
const BROWSER_DISPOSE_TIMEOUT_MS = 10_000;
const INTEGRATION_DISPOSE_TIMEOUT_MS = 30_000;

type MarkPhase = (phase: string) => void;

export interface ChromiumFixture {
  integration: IntegrationFixture;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  browserErrors: string[];
  assertNoBrowserErrors(): void;
}

const fixturesOwningBrowsers = new WeakSet<ChromiumFixture>();

export async function launchChromiumBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export async function closeChromiumBrowser(browser: Browser): Promise<void> {
  await withTimeout(
    browser.close(),
    BROWSER_DISPOSE_TIMEOUT_MS,
    () => 'Timed out closing the shared Chromium browser.',
  );
}

export async function createChromiumFixture(
  integrationOptions: IntegrationFixtureOptions = {},
  sharedBrowser?: Browser,
): Promise<ChromiumFixture> {
  await access(WEB_BUILD_INDEX);
  const integration = await createIntegrationFixture(integrationOptions);
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = sharedBrowser ?? (await launchChromiumBrowser());
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript(() => {
      const key = 'pref_local_settings';
      try {
        const stored = JSON.parse(globalThis.localStorage.getItem(key) ?? '{}');
        const snapshot =
          stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
        globalThis.localStorage.setItem(
          key,
          JSON.stringify({ ...snapshot, allowDirectChats: true }),
        );
      } catch {
        globalThis.localStorage.setItem(key, JSON.stringify({ allowDirectChats: true }));
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
    const fixture: ChromiumFixture = {
      integration,
      browser,
      context,
      page,
      browserErrors,
      assertNoBrowserErrors() {
        if (browserErrors.length > 0) {
          throw new Error(`Unexpected browser errors:\n${browserErrors.join('\n')}`);
        }
      },
    };
    if (sharedBrowser === undefined) fixturesOwningBrowsers.add(fixture);
    return fixture;
  } catch (error) {
    await context?.close().catch(() => undefined);
    if (sharedBrowser === undefined) await browser?.close().catch(() => undefined);
    await integration.dispose().catch(() => undefined);
    throw error;
  }
}

async function writeDiagnostics(
  testName: string,
  fixture: ChromiumFixture,
  error: unknown,
  details?: (fixture: ChromiumFixture) => Promise<unknown>,
): Promise<string> {
  const safeName = testName
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const prefix = join(ARTIFACT_ROOT, `${safeName || 'chromium'}-${Date.now()}`);
  await mkdir(dirname(prefix), { recursive: true });
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
        details: await details?.(fixture).catch(() => null),
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
      if (fixturesOwningBrowsers.delete(fixture)) {
        try {
          await withTimeout(
            fixture.browser.close(),
            BROWSER_DISPOSE_TIMEOUT_MS / 2,
            () => 'Timed out closing the Chromium browser.',
          );
        } catch (error) {
          errors.push(error);
        }
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

export async function withChromiumFixture<T>(
  testName: string,
  run: (fixture: ChromiumFixture, markPhase: MarkPhase) => Promise<T>,
  diagnostics?: (fixture: ChromiumFixture) => Promise<unknown>,
  integrationOptions: IntegrationFixtureOptions = {},
  sharedBrowser?: Browser,
): Promise<T> {
  const fixture = await withTimeout(
    createChromiumFixture(integrationOptions, sharedBrowser),
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
      writeDiagnostics(testName, fixture, error, diagnostics),
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
