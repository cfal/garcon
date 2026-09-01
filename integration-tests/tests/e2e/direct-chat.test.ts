import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';
import {
  acceptedResponseRequestBodies,
  replaceFirstAcceptedResponse,
} from '../../support/accepted-response-loss.js';

interface DraftStartRequestGate {
  startRequestCount: number;
  messageRequests: Array<{ chatId: string | null; purpose: string | null }>;
  releaseStart: (() => void) | null;
}

type DraftStartRequestGateGlobal = typeof globalThis & {
  __garconDraftStartRequestGate?: DraftStartRequestGate;
};

async function holdFirstChatStart(page: Page): Promise<void> {
  await page.evaluate(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const scope = globalThis as DraftStartRequestGateGlobal;
    scope.__garconDraftStartRequestGate = {
      startRequestCount: 0,
      messageRequests: [],
      releaseStart: null,
    };
    const gatedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      let inputUrl: string;
      if (typeof input === 'string') inputUrl = input;
      else if (input instanceof URL) inputUrl = input.href;
      else inputUrl = input.url;

      const url = new URL(inputUrl, globalThis.location.href);
      const gate = scope.__garconDraftStartRequestGate;
      if (gate && url.pathname === '/api/v1/chats/messages') {
        gate.messageRequests.push({
          chatId: url.searchParams.get('chatId'),
          purpose: url.searchParams.get('purpose'),
        });
      }
      if (gate && url.pathname === '/api/v1/chats/start') {
        gate.startRequestCount += 1;
        if (gate.startRequestCount === 1) {
          await new Promise<void>((resolve) => {
            gate.releaseStart = resolve;
          });
          gate.releaseStart = null;
        }
      }
      return originalFetch(input, init);
    };
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: gatedFetch,
    });
  });
}

async function waitForHeldChatStart(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const gate = (globalThis as DraftStartRequestGateGlobal).__garconDraftStartRequestGate;
      return gate?.startRequestCount === 1 && gate.releaseStart !== null;
    },
    { timeout: 10_000 },
  );
}

async function releaseHeldChatStart(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gate = (globalThis as DraftStartRequestGateGlobal).__garconDraftStartRequestGate;
    if (!gate?.releaseStart) throw new Error('No Chat start request is waiting for release.');
    gate.releaseStart();
  });
}

async function draftStartRequestGate(page: Page): Promise<DraftStartRequestGate> {
  return page.evaluate(() => {
    const gate = (globalThis as DraftStartRequestGateGlobal).__garconDraftStartRequestGate;
    if (!gate) throw new Error('Draft Chat start request gate is not installed.');
    return {
      startRequestCount: gate.startRequestCount,
      messageRequests: gate.messageRequests,
      releaseStart: null,
    };
  });
}

describe('Lightpanda direct chat', () => {
  test('creates a direct chat and renders one user and assistant row', async () => {
    await withE2eFixture('direct-chat', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('ui-direct-hello');
      await app.waitForText('echo:ui-direct-hello');

      expect(await app.exactTextCount('ui-direct-hello')).toBe(1);
      expect(await app.exactTextCount('echo:ui-direct-hello')).toBe(1);
      expect(fixture.integration.fakeProviders.openAi.requests().filter((request) =>
        request.lastUserText === 'ui-direct-hello')).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  });

  test('defers transcript hydration until a new Chat is admitted by the server', async () => {
    await withE2eFixture('direct-chat-draft-admission', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await holdFirstChatStart(fixture.page);

      const starting = app.startOpenAiDirectChat('ui-direct-draft-admission');
      await waitForHeldChatStart(fixture.page);
      await app.waitForText('ui-direct-draft-admission');

      expect((await draftStartRequestGate(fixture.page)).messageRequests).toEqual([]);
      expect(await app.exactTextCount('Failed to refresh messages')).toBe(0);
      expect(await app.exactTextCount('Session not found')).toBe(0);

      await releaseHeldChatStart(fixture.page);
      await starting;
      await app.waitForText('echo:ui-direct-draft-admission');
      await fixture.page.waitForFunction(
        () =>
          (globalThis as DraftStartRequestGateGlobal).__garconDraftStartRequestGate
            ?.messageRequests.length === 1,
        { timeout: 10_000 },
      );

      const gate = await draftStartRequestGate(fixture.page);
      expect(gate.startRequestCount).toBe(1);
      expect(gate.messageRequests).toHaveLength(1);
      expect(gate.messageRequests[0]).toEqual({
        chatId: expect.any(String),
        purpose: null,
      });
      expect(await app.exactTextCount('Failed to refresh messages')).toBe(0);
      expect(await app.exactTextCount('Session not found')).toBe(0);
      fixture.assertNoBrowserErrors();
    });
  });

  test('selects and runs a direct Anthropic chat', async () => {
    await withE2eFixture('direct-anthropic-chat', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      const request = await app.startAnthropicDirectChat('ui-anthropic-hello');
      await app.waitForText('echo:ui-anthropic-hello');

      expect(request.body).toMatchObject({
        model: 'integration-anthropic-echo',
        stream: true,
      });
      expect(await app.exactTextCount('ui-anthropic-hello')).toBe(1);
		expect(await app.exactTextCount('echo:ui-anthropic-hello')).toBe(1);
		expect(fixture.integration.fakeProviders.openAi.requests()).toEqual([]);
		fixture.assertNoBrowserErrors();
    });
  });

  test('retries a lost accepted response with the same identity and executes once', async () => {
    await withE2eFixture('direct-chat-lost-response', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('ui-lost-response-seed');
      await app.waitForText('echo:ui-lost-response-seed');

      await replaceFirstAcceptedResponse(fixture.page, '/api/v1/chats/run');

      await app.sendComposer('ui-lost-response-followup');
      await app.waitForText('echo:ui-lost-response-followup');

      const interceptedBodies = await acceptedResponseRequestBodies(fixture.page);
      expect(interceptedBodies).toHaveLength(2);
      expect(interceptedBodies[1]).toMatchObject({
        clientRequestId: interceptedBodies[0].clientRequestId,
        clientMessageId: interceptedBodies[0].clientMessageId,
      });
      expect(await app.exactTextCount('ui-lost-response-followup')).toBe(1);
      expect(await app.exactTextCount('echo:ui-lost-response-followup')).toBe(1);
		expect(fixture.integration.fakeProviders.openAi.requests().filter((request) => (
			request.lastUserText === 'ui-lost-response-followup'
		))).toHaveLength(1);
		fixture.assertNoBrowserErrors();
    });
  });
});
