import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connect,
  type Browser,
  type BrowserContext,
  type Page,
} from 'puppeteer-core';
import { createIntegrationFixture, type IntegrationFixture } from './integration-fixture.js';
import { LightpandaProcess } from './lightpanda-process.js';
import { withTimeout } from './deferred.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB_BUILD_INDEX = join(REPO_ROOT, 'web', 'build', 'index.html');
const ARTIFACT_ROOT = join(REPO_ROOT, 'integration-tests', 'artifacts', 'e2e');

export class E2eFixture {
  readonly integration: IntegrationFixture;
  readonly lightpanda: LightpandaProcess;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly #browserErrors: string[] = [];
  #disposed = false;

  private constructor(input: {
    integration: IntegrationFixture;
    lightpanda: LightpandaProcess;
    browser: Browser;
    context: BrowserContext;
    page: Page;
  }) {
    this.integration = input.integration;
    this.lightpanda = input.lightpanda;
    this.browser = input.browser;
    this.context = input.context;
    this.page = input.page;
    this.page.on('pageerror', (error) => this.#browserErrors.push(
      `pageerror: ${error instanceof Error ? error.message : String(error)}`,
    ));
    this.page.on('console', (message) => {
      if (message.type() === 'error') this.#browserErrors.push(`console.error: ${message.text()}`);
    });
  }

  static async create(): Promise<E2eFixture> {
    await access(WEB_BUILD_INDEX);
    const integration = await createIntegrationFixture();
    let lightpanda: LightpandaProcess | null = null;
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      lightpanda = await LightpandaProcess.start();
      browser = await connect({ browserWSEndpoint: lightpanda.browserWsEndpoint });
      context = await browser.createBrowserContext();
      const page = await context.newPage();
      return new E2eFixture({ integration, lightpanda, browser, context, page });
    } catch (error) {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await lightpanda?.stop().catch(() => undefined);
      await integration.dispose().catch(() => undefined);
      throw error;
    }
  }

  get baseUrl(): string {
    return this.integration.garcon.baseUrl;
  }

  get browserErrors(): readonly string[] {
    return [...this.#browserErrors];
  }

  assertNoBrowserErrors(): void {
    if (this.#browserErrors.length > 0) {
      throw new Error(`Unexpected browser errors:\n${this.#browserErrors.join('\n')}`);
    }
  }

  spaWebSocketConnectionCount(): number {
    const connected = '[ws:chat] ws: chat client connected';
    return this.integration.garcon.logs.filter((line) => line.includes(connected)).length;
  }

  async waitForSpaWebSocket(options: { afterConnectionCount?: number } = {}): Promise<void> {
    const connected = '[ws:chat] ws: chat client connected';
    const requiredCount = options.afterConnectionCount === undefined
      ? 2
      : options.afterConnectionCount + 1;
    const wait = async (): Promise<void> => {
      while (this.integration.garcon.logs.filter((line) => line.includes(connected)).length < requiredCount) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    };
    await withTimeout(wait(), 10_000, () => [
      'Timed out waiting for the SPA WebSocket connection.',
      this.integration.garcon.describeLogs(),
      this.lightpanda.describeLogs(),
    ].join('\n'));
  }

  async writeDiagnostics(testName: string, error: unknown): Promise<string> {
    const safeName = testName.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    const path = join(ARTIFACT_ROOT, `${safeName || 'e2e'}-${Date.now()}.json`);
    await mkdir(dirname(path), { recursive: true });
    const pageSnapshot = await this.page.evaluate(() => ({
      html: document.documentElement.outerHTML,
      semanticElements: [...document.querySelectorAll<HTMLElement>(
        'button, input, textarea, [role], [aria-label]',
      )].map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        name: element.getAttribute('aria-label') || element.textContent?.trim() || null,
        disabled: element instanceof HTMLButtonElement || element instanceof HTMLInputElement
          ? element.disabled
          : element.getAttribute('aria-disabled') === 'true',
      })),
    })).catch(() => ({ html: null, semanticElements: [] }));
    await writeFile(path, JSON.stringify({
      testName,
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
      url: this.page.url(),
      ...pageSnapshot,
      browserErrors: this.#browserErrors,
      lightpandaLogs: this.lightpanda.logs,
      integration: this.integration.diagnostics(),
    }, null, 2));
    return path;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    try {
      await this.page.close();
      await this.context.close();
      this.browser.disconnect();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.lightpanda.stop();
      this.lightpanda.assertNoUnexpectedExit();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.integration.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, 'E2E fixture cleanup failed.');
  }
}

export async function withE2eFixture<T>(
  testName: string,
  run: (fixture: E2eFixture) => Promise<T>,
): Promise<T> {
  const fixture = await E2eFixture.create();
  let failure: unknown;
  try {
    return await run(fixture);
  } catch (error) {
    failure = error;
    const artifact = await fixture.writeDiagnostics(testName, error).catch(() => null);
    if (artifact && error instanceof Error) error.message = `${error.message}\nE2E diagnostics: ${artifact}`;
    throw error;
  } finally {
    try {
      await fixture.dispose();
    } catch (disposeError) {
      if (failure === undefined) throw disposeError;
      console.error(disposeError);
    }
  }
}
