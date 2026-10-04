import { expect, test } from 'bun:test';
import type { AgentAuthLoginStatus, AgentDeviceAuthInfo } from '../../../common/agent-auth.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

interface CompletionRequest {
  agentId: string;
  executorId: string;
  sessionId: string;
  code: string;
}

interface AuthLoginScenario {
  status: AgentAuthLoginStatus;
  authenticated: boolean;
  launches: number;
  completions: CompletionRequest[];
  unexpectedMutations: string[];
}

type ScenarioScope = typeof globalThis & { __authLoginRetryScenario: AuthLoginScenario };

const SESSION_ID = 'synthetic-claude-login';
const DEVICE_AUTH: AgentDeviceAuthInfo = {
  url: 'https://example.test/authorize/synthetic-claude-login',
  needsCode: true,
};
const INPUT = 'section[aria-label="Local"] input[placeholder="Paste authorization code"]';
const RETRY_ERROR = 'The authorization code was rejected. Paste the complete code, including its # suffix, and try again.';
const OTHER_ACCOUNT = 'Existing synthetic OpenAI connection';

test('Claude sign-in retries a rejected code and restores pending completion when Settings reopens', async () => {
  await withE2eFixture('auth-login-retry', async (fixture) => {
    await fixture.page.evaluateOnNewDocument(({ sessionId, deviceAuth, otherAccount }) => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      const scope = globalThis as ScenarioScope;
      const scenario: AuthLoginScenario = {
        status: { state: 'idle', running: false },
        authenticated: false,
        launches: 0,
        completions: [],
        unexpectedMutations: [],
      };
      scope.__authLoginRetryScenario = scenario;
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          const local = url.searchParams.get('executorId') === 'local';
          const agentId = url.searchParams.get('agent');
          if (url.pathname === '/api/v1/agents/auth' && local) {
            if (agentId === 'claude') {
              return Promise.resolve(Response.json({
                claude: { authenticated: scenario.authenticated, canReauth: true, label: '' },
              }));
            }
            if (agentId === 'codex') {
              return Promise.resolve(Response.json({
                codex: { authenticated: true, canReauth: true, label: otherAccount },
              }));
            }
          }
          if (url.pathname === '/api/v1/agents/auth/login' && init?.method !== 'POST' && local) {
            if (agentId === 'claude') return Promise.resolve(Response.json(scenario.status));
            if (agentId === 'codex') {
              return Promise.resolve(Response.json({ state: 'idle', running: false } satisfies AgentAuthLoginStatus));
            }
          }
          if (
            init?.method === 'POST' &&
            (url.pathname === '/api/v1/agents/auth/login' || url.pathname === '/api/v1/agents/auth/login/complete')
          ) {
            const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
            if (body.executorId !== 'local' || body.agentId !== 'claude') {
              scenario.unexpectedMutations.push(url.pathname);
              return Promise.resolve(Response.json({ error: 'Unexpected auth target' }, { status: 400 }));
            }
            if (url.pathname === '/api/v1/agents/auth/login') {
              scenario.launches += 1;
              scenario.status = {
                state: 'running', running: true, sessionId, deviceAuth, completionPending: false,
              };
              return Promise.resolve(Response.json({ launched: true, alreadyRunning: false, sessionId, deviceAuth }));
            }
            scenario.completions.push(body as CompletionRequest);
            scenario.status = {
              state: 'running', running: true, sessionId, deviceAuth, completionPending: true,
            };
            return Promise.resolve(Response.json({ submitted: true, sessionId }));
          }
          return originalFetch(input, init);
        },
      });
    }, { sessionId: SESSION_ID, deviceAuth: DEVICE_AUTH, otherAccount: OTHER_ACCOUNT });

    const app = new SpaDriver(fixture.page, fixture.integration);
    const openProviders = async () => {
      await app.clickButton('More actions');
      await app.waitForMenuItemEnabled('Settings');
      await app.clickMenuItem('Settings');
      await app.waitForDialogButtonEnabled('Providers');
      await app.clickButton('Providers');
      await app.waitForText('Native Providers');
      await app.waitForText(OTHER_ACCOUNT);
    };
    const waitForPending = async () => {
      await fixture.page.waitForFunction((selector) => {
        const input = document.querySelector<HTMLInputElement>(selector);
        const button = input?.parentElement?.querySelector<HTMLButtonElement>('button');
        return input?.disabled && button?.disabled;
      }, {}, INPUT);
      await app.waitForText('Completing sign-in');
    };
    const attemptDuplicateSubmission = async () => {
      await fixture.page.$eval(INPUT, (element) => {
        const input = element as HTMLInputElement;
        input.parentElement?.querySelector<HTMLButtonElement>('button')?.click();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
    };

    await app.open();
    await fixture.waitForSpaWebSocket();
    await openProviders();
    await fixture.page.waitForFunction(() => {
      const card = [...document.querySelectorAll<HTMLElement>('section[aria-label="Local"] [data-collapsible-root]')]
        .find(element => element.textContent?.includes('Claude OAuth'));
      return [...(card?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .some(button => button.textContent?.trim() === 'Sign in' && !button.disabled);
    });
    await fixture.page.evaluate(() => {
      const card = [...document.querySelectorAll<HTMLElement>('section[aria-label="Local"] [data-collapsible-root]')]
        .find(element => element.textContent?.includes('Claude OAuth'));
      const button = [...(card?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find(element => element.textContent?.trim() === 'Sign in');
      if (!button) throw new Error('Local Claude sign-in button not found');
      button.click();
    });
    await fixture.page.waitForSelector(INPUT);
    await app.waitForText('including any # suffix');
    await app.fill(INPUT, 'synthetic-rejected-code');
    await app.clickButton('Submit code');
    await waitForPending();
    await attemptDuplicateSubmission();
    expect(await fixture.page.evaluate(() => (globalThis as ScenarioScope).__authLoginRetryScenario.completions)).toEqual([
      { agentId: 'claude', executorId: 'local', sessionId: SESSION_ID, code: 'synthetic-rejected-code' },
    ]);

    await fixture.page.evaluate(({ sessionId, deviceAuth, error }) => {
      (globalThis as ScenarioScope).__authLoginRetryScenario.status = {
        state: 'running', running: true, sessionId, deviceAuth, completionPending: false, retryableError: error,
      };
    }, { sessionId: SESSION_ID, deviceAuth: DEVICE_AUTH, error: RETRY_ERROR });
    await app.waitForText(RETRY_ERROR);
    await app.waitForButtonEnabled('Submit code');
    expect(await fixture.page.$eval(INPUT, element => (element as HTMLInputElement).disabled)).toBe(false);
    expect(await fixture.page.$eval(INPUT, element => (element as HTMLInputElement).value)).toBe('synthetic-rejected-code');
    expect(await fixture.page.$eval('section[aria-label="Local"] [role="alert"]', element => element.textContent)).toContain(RETRY_ERROR);
    expect(await fixture.page.$eval(`section[aria-label="Local"] a[href="${DEVICE_AUTH.url}"]`, element => element.textContent)).toBe(DEVICE_AUTH.url);

    await app.fill(INPUT, 'synthetic-valid-code#synthetic-suffix');
    await fixture.page.$eval(INPUT, element => element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    ));
    await waitForPending();
    await app.waitForTextAbsent(RETRY_ERROR);
    expect(await fixture.page.evaluate(() => (globalThis as ScenarioScope).__authLoginRetryScenario.completions)).toEqual([
      { agentId: 'claude', executorId: 'local', sessionId: SESSION_ID, code: 'synthetic-rejected-code' },
      { agentId: 'claude', executorId: 'local', sessionId: SESSION_ID, code: 'synthetic-valid-code#synthetic-suffix' },
    ]);

    await app.clickDialogButton('Close');
    await fixture.page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await openProviders();
    await waitForPending();
    await app.fill(INPUT, 'synthetic-duplicate-code#synthetic-suffix');
    await attemptDuplicateSubmission();
    expect(await fixture.page.evaluate(() => (globalThis as ScenarioScope).__authLoginRetryScenario.completions.length)).toBe(2);

    await fixture.page.evaluate((sessionId) => {
      const scenario = (globalThis as ScenarioScope).__authLoginRetryScenario;
      scenario.authenticated = true;
      scenario.status = { state: 'succeeded', running: false, sessionId };
    }, SESSION_ID);
    await fixture.page.waitForFunction((selector) => {
      const card = [...document.querySelectorAll<HTMLElement>('section[aria-label="Local"] [data-collapsible-root]')]
        .find(element => element.textContent?.includes('Claude OAuth'));
      return !document.querySelector(selector) && card?.textContent?.includes('Connected');
    }, {}, INPUT);
    await app.waitForTextAbsent(DEVICE_AUTH.url);
    await app.waitForTextAbsent('Completing sign-in');
    await app.waitForText(OTHER_ACCOUNT);
    await app.waitForText('Custom Providers');
    const scenario = await fixture.page.evaluate(() => (globalThis as ScenarioScope).__authLoginRetryScenario);
    expect(scenario.launches).toBe(1);
    expect(scenario.completions).toHaveLength(2);
    expect(scenario.unexpectedMutations).toEqual([]);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'in-process' });
}, 60_000);
