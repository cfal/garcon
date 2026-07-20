import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connect,
  type Browser,
  type BrowserContext,
  type Page,
} from 'puppeteer-core';
import type { ServerWsMessage } from '../../common/ws-events.js';
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
      lightpanda = await LightpandaProcess.start(integration.dirs.home);
      browser = await connect({ browserWSEndpoint: lightpanda.browserWsEndpoint });
      context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.evaluateOnNewDocument(() => {
        const scope = globalThis as typeof globalThis & {
          __garconSpaWsOpenCount?: number;
          __garconSpaWsEvents?: unknown[];
        };
        const storageKey = '__garconSpaWsOpenCount';
        const NativeWebSocket = globalThis.WebSocket;
        scope.__garconSpaWsOpenCount = Number(globalThis.sessionStorage.getItem(storageKey)) || 0;
        scope.__garconSpaWsEvents = [];
        globalThis.WebSocket = new Proxy(NativeWebSocket, {
          construct(Target, args: ConstructorParameters<typeof WebSocket>) {
            const socket = new Target(...args);
            const url = new URL(String(args[0]), globalThis.location.href);
            if (url.pathname === '/ws') {
              socket.addEventListener('open', () => {
                scope.__garconSpaWsOpenCount = (scope.__garconSpaWsOpenCount ?? 0) + 1;
                globalThis.sessionStorage.setItem(
                  storageKey,
                  String(scope.__garconSpaWsOpenCount),
                );
              });
              socket.addEventListener('message', (event) => {
                try {
                  scope.__garconSpaWsEvents?.push(JSON.parse(String(event.data)));
                } catch {
                  // Product code owns protocol validation; the fixture only records parseable events.
                }
              });
            }
            return socket;
          },
        });
      });
      return new E2eFixture({
        integration,
        lightpanda,
        browser,
        context,
        page,
      });
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

  async spaWebSocketConnectionCount(): Promise<number> {
    return await this.page.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __garconSpaWsOpenCount?: number;
      };
      return scope.__garconSpaWsOpenCount ?? 0;
    });
  }

  async waitForSpaWebSocket(options: { afterConnectionCount?: number } = {}): Promise<void> {
    const requiredCount = options.afterConnectionCount === undefined
      ? 1
      : options.afterConnectionCount + 1;
    const wait = this.page.waitForFunction(
      (minimum) => {
        const scope = globalThis as typeof globalThis & {
          __garconSpaWsOpenCount?: number;
        };
        return (scope.__garconSpaWsOpenCount ?? 0) >= minimum;
      },
      { timeout: 10_000 },
      requiredCount,
    );
    await withTimeout(wait, 10_000, () => [
      'Timed out waiting for the SPA WebSocket connection.',
      this.integration.garcon.describeLogs(),
      this.lightpanda.describeLogs(),
    ].join('\n'));
  }

  async spaWebSocketEventCount(): Promise<number> {
    return await this.page.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __garconSpaWsEvents?: unknown[];
      };
      return scope.__garconSpaWsEvents?.length ?? 0;
    });
  }

  async waitForSpaWebSocketEvent(input: {
    afterIndex: number;
    type: ServerWsMessage['type'];
    chatId?: string;
  }): Promise<void> {
    await this.page.waitForFunction(
      ({ afterIndex, type, chatId }) => {
        const scope = globalThis as typeof globalThis & {
          __garconSpaWsEvents?: unknown[];
        };
        return (scope.__garconSpaWsEvents ?? []).slice(afterIndex).some((event) => {
          if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
          const record = event as Record<string, unknown>;
          return record.type === type && (chatId === undefined || record.chatId === chatId);
        });
      },
      { timeout: 20_000 },
      input,
    );
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
        placeholder: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.placeholder || null
          : null,
        value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value
          : null,
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
      url: await this.page.evaluate(() => globalThis.location.href).catch(() => this.page.url()),
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
