import { expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPiAvailableModels, parsePiModelListing, PiModelCatalogService } from '../pi-models.js';
import { getPiAuthStatus } from '../pi-auth.js';
import { testPiConfig } from './test-fixtures.js';

test('reads the padded CLI table without splitting provider/model IDs on single spaces or slashes', () => {
  const listing = [
    'provider  model                    context  max-out  thinking  images',
    'cloud     accounts/x/model id      200K     32K      yes       no',
    'vision    preview                  1M       16K      no        yes',
  ].join('\r\n');
  expect(parsePiModelListing(listing, '')).toEqual([
    { value: 'cloud/accounts/x/model id', label: 'cloud: model id', supportsImages: false },
    { value: 'vision/preview', label: 'vision: preview', supportsImages: true },
  ]);
  expect(() => parsePiModelListing(listing.replace('no        yes', 'no        unknown'), '')).toThrow();
});

test('accepts only a clean empty listing, not failed or unrecognized discovery', () => {
  const empty = 'No models available. Use /login to log into a provider via OAuth or API key. See:\n  /docs/providers.md\n  /docs/models.md\n';
  expect(parsePiModelListing(empty, '')).toEqual([]);
  expect(() => parsePiModelListing(empty, 'Warning: errors loading models.json')).toThrow('discovery errors');
  expect(() => parsePiModelListing('', '')).toThrow();
});

test.skipIf(process.platform === 'win32')('discovery times out when a descendant inherits the CLI output pipes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-discovery-'));
  const binary = join(dir, 'pi');
  try {
    await writeFile(binary, '#!/bin/sh\nsleep 1 &\nexit 0\n', { mode: 0o700 });
    await expect(getPiAvailableModels({ binary: () => binary }, AbortSignal.timeout(100))).rejects.toMatchObject({ name: 'TimeoutError' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('caller cancellation leaves a shared probe running; shutdown drains it without retrying', async () => {
  const cleanup = Promise.withResolvers<void>();
  const discover = mock(async (lifetime: AbortSignal) => {
    await new Promise<void>(resolve => lifetime.addEventListener('abort', () => resolve(), { once: true }));
    await cleanup.promise;
    lifetime.throwIfAborted();
    return [];
  });
  const service = new PiModelCatalogService(testPiConfig, discover);
  const caller = new AbortController();
  const first = service.getModelsStrict(caller.signal);
  const second = service.getModelsStrict();
  const auth = getPiAuthStatus(service).catch((error: unknown) => error);
  caller.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(discover.mock.calls[0]?.[0].aborted).toBe(false);
  let drained = false;
  const stopped = service.stop().then(() => { drained = true; });
  expect(discover.mock.calls[0]?.[0].aborted).toBe(true);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(drained).toBe(false);
  cleanup.resolve();
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  expect(await auth).toMatchObject({ name: 'AbortError' });
  await stopped;
  await expect(service.getModelsStrict()).rejects.toMatchObject({ name: 'AbortError' });
  expect(discover).toHaveBeenCalledTimes(1);
  discover.mockResolvedValueOnce([]);
  service.start();
  expect(await service.getModelsStrict()).toEqual([]);
});

test('retries transient errors, caches success, and preserves last-known-good only for non-strict reads', async () => {
  const expected = [{ value: 'acme/text', label: 'acme: text', supportsImages: false }];
  const discover = mock<() => Promise<typeof expected>>()
    .mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(expected)
    .mockRejectedValue(new Error('discovery unavailable'));
  const service = new PiModelCatalogService(testPiConfig, discover);
  expect(await service.getModelsStrict()).toEqual(expected);
  expect(await service.getModels()).toEqual(expected);
  expect(discover).toHaveBeenCalledTimes(2);
  service.expireForTests();
  await expect(service.getModelsStrict()).rejects.toMatchObject({ staleModels: expected });
  expect(await service.getModels()).toEqual(expected);
});
