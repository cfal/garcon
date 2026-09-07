import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda auth reconnect recovery', () => {
  test('preserves a stored session and protected route while auth is unavailable', async () => {
    await withE2eFixture('auth-network-reconnect', async (fixture) => {
      await fixture.page.evaluateOnNewDocument(() => {
        const scope = globalThis as typeof globalThis & {
          __garconAuthApiAvailable?: boolean;
          __garconAuthStatusAttempts?: number;
        };
        const nativeFetch = globalThis.fetch;
        scope.__garconAuthApiAvailable = false;
        scope.__garconAuthStatusAttempts = 0;
        localStorage.setItem('bearer-token', 'saved-token');
        globalThis.fetch = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const rawUrl = typeof input === 'string' || input instanceof URL
              ? String(input)
              : input.url;
            const url = new URL(rawUrl, globalThis.location.href);
            if (url.pathname === '/api/v1/auth/status') {
              scope.__garconAuthStatusAttempts = (scope.__garconAuthStatusAttempts ?? 0) + 1;
              if (!scope.__garconAuthApiAvailable) throw new TypeError('Failed to fetch');
              return Response.json({
                needsSetup: false,
                isAuthenticated: true,
                authDisabled: false,
              });
            }
            if (url.pathname === '/api/v1/auth/user') {
              return Response.json({ user: { id: 'admin', username: 'admin' } });
            }
            return nativeFetch(input, init);
          },
          { preconnect: nativeFetch.preconnect },
        );
      });

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await app.waitForText('Reconnecting to Garcon', 15_000);

      expect(await fixture.page.evaluate(() => ({
        pathname: globalThis.location.pathname,
        token: localStorage.getItem('bearer-token'),
        attempts: (globalThis as typeof globalThis & {
          __garconAuthStatusAttempts?: number;
        }).__garconAuthStatusAttempts,
      }))).toEqual({
        pathname: '/',
        token: 'saved-token',
        attempts: 5,
      });

      await fixture.page.evaluate(() => {
        (globalThis as typeof globalThis & {
          __garconAuthApiAvailable?: boolean;
        }).__garconAuthApiAvailable = true;
      });
      await app.clickButton('Retry');
      await app.waitForButton('New Chat');
      await fixture.waitForSpaWebSocket();

      expect(await fixture.page.evaluate(() => localStorage.getItem('bearer-token')))
        .toBe('saved-token');
      const recoveredAttemptCount = await fixture.page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __garconAuthStatusAttempts?: number;
        }).__garconAuthStatusAttempts);
      await fixture.page.evaluate(() => globalThis.dispatchEvent(new Event('online')));
      await Bun.sleep(100);
      expect(await fixture.page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __garconAuthStatusAttempts?: number;
        }).__garconAuthStatusAttempts)).toBe(recoveredAttemptCount);
      expect(fixture.browserErrors.filter((message) =>
        !message.includes('[AuthStore] Auth status check failed:'))).toEqual([]);
    });
  });
});
