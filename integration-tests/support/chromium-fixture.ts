import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createIntegrationFixture, type IntegrationFixture } from './integration-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB_BUILD_INDEX = join(REPO_ROOT, 'web', 'build', 'index.html');
const ARTIFACT_ROOT = join(REPO_ROOT, 'integration-tests', 'artifacts', 'chromium');

export interface ChromiumFixture {
  integration: IntegrationFixture;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  browserErrors: string[];
  assertNoBrowserErrors(): void;
}

export async function createChromiumFixture(): Promise<ChromiumFixture> {
  await access(WEB_BUILD_INDEX);
  const integration = await createIntegrationFixture();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless: true });
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
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(`console.error: ${message.text()}`);
    });
    return {
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
  details?: (fixture: ChromiumFixture) => Promise<unknown>,
): Promise<string> {
  const safeName = testName
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const prefix = join(ARTIFACT_ROOT, `${safeName || 'chromium'}-${Date.now()}`);
  await mkdir(dirname(prefix), { recursive: true });
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
  const errors: unknown[] = [];
  for (const dispose of [
    () => fixture.context.close(),
    () => fixture.browser.close(),
    () => fixture.integration.dispose(),
  ]) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Chromium fixture cleanup failed.');
}

export async function withChromiumFixture<T>(
  testName: string,
  run: (fixture: ChromiumFixture) => Promise<T>,
  diagnostics?: (fixture: ChromiumFixture) => Promise<unknown>,
): Promise<T> {
  const fixture = await createChromiumFixture();
  let failure: unknown;
  try {
    return await run(fixture);
  } catch (error) {
    failure = error;
    const artifact = await writeDiagnostics(testName, fixture, error, diagnostics).catch(
      () => null,
    );
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
