import type { Page } from 'puppeteer-core';

interface AcceptedResponseLossHarness {
  path: string;
  replaced: boolean;
  requestBodies: Array<Record<string, unknown>>;
}

type HarnessGlobal = typeof globalThis & {
  __garconAcceptedResponseLoss?: AcceptedResponseLossHarness;
};

export async function replaceFirstAcceptedResponse(page: Page, path: string): Promise<void> {
  await page.evaluate((targetPath) => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const testGlobal = globalThis as HarnessGlobal;
    testGlobal.__garconAcceptedResponseLoss = {
      path: targetPath,
      replaced: false,
      requestBodies: [],
    };
    const interceptedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      const inputUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const harness = testGlobal.__garconAcceptedResponseLoss;
      if (!harness || new URL(inputUrl, globalThis.location.href).pathname !== harness.path) {
        return response;
      }
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : {};
      harness.requestBodies.push(body);
      if (harness.replaced || response.status !== 202) return response;
      harness.replaced = true;
      return new Response(JSON.stringify({
        success: false,
        error: 'Simulated response loss after acceptance',
        errorCode: 'INTERNAL_ERROR',
        retryable: false,
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: interceptedFetch,
    });
  }, path);
}

export async function acceptedResponseRequestBodies(
  page: Page,
): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (
    (globalThis as HarnessGlobal).__garconAcceptedResponseLoss?.requestBodies ?? []
  ));
}

export async function waitForAcceptedResponseRequestBodies(
  page: Page,
  minimumCount: number,
): Promise<Array<Record<string, unknown>>> {
  await page.waitForFunction(
    (minimum) => {
      const requestCount = (globalThis as HarnessGlobal)
        .__garconAcceptedResponseLoss?.requestBodies.length ?? 0;
      return requestCount >= minimum;
    },
    { timeout: 10_000 },
    minimumCount,
  );
  return acceptedResponseRequestBodies(page);
}
