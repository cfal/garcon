import type { Page } from 'puppeteer-core';
import { parseDisplayWindowRequest, parseDisplayWindowResponse } from '../../common/transcript-display-contract.js';

interface CapturedDisplayWindow { request: unknown; response: unknown }
type DisplayWindowRecorderGlobal = typeof globalThis & { __displayWindowReads?: CapturedDisplayWindow[] };

export async function recordDisplayWindows(page: Page): Promise<void> {
  // Captures JSON at fetch because Lightpanda omits POST bodies from CDP request events.
  const install = () => {
    const scope = globalThis as DisplayWindowRecorderGlobal;
    const reads: CapturedDisplayWindow[] = [];
    scope.__displayWindowReads = reads;
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== '/api/v1/chats/transcript-display/window') return nativeFetch(input, init);
      const read: CapturedDisplayWindow = { request: JSON.parse(String(init?.body)), response: null };
      reads.push(read);
      const response = await nativeFetch(input, init);
      if (response.ok) read.response = await response.clone().json();
      return response;
    };
  };
  await page.evaluateOnNewDocument(install);
  await page.evaluate(install);
}

export async function recordedDisplayWindows(page: Page) {
  const reads = await page.evaluate(() => (globalThis as DisplayWindowRecorderGlobal).__displayWindowReads ?? []);
  return reads.map(read => ({
    request: parseDisplayWindowRequest(read.request),
    response: read.response === null ? null : parseDisplayWindowResponse(read.response),
  }));
}
