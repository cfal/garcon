import { expect, mock, spyOn, test } from 'bun:test';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getPiAvailableModels, parsePiModelListing, PiModelCatalogService } from '../pi-models.js';
import { getPiAuthStatus } from '../pi-auth.js';
import { testPiConfig } from './test-fixtures.js';

test('reads the padded CLI table without splitting provider/model IDs on single spaces or slashes', () => {
  const listing = [
    'Synthetic extension loaded',
    'provider  model                    context  max-out  thinking  images',
    'cloud     accounts/x/model id      200K     32K      yes       no',
    'cloud     scope/model/             200K     32K      yes       no',
    'vision    preview                  1M       16K      no        yes',
  ].join('\r\n');
  expect(parsePiModelListing(listing, '')).toEqual([
    { value: 'cloud/accounts/x/model id', label: 'cloud: model id', supportsImages: false },
    { value: 'cloud/scope/model/', label: 'cloud: model', supportsImages: false },
    { value: 'vision/preview', label: 'vision: preview', supportsImages: true },
  ]);
  expect(() => parsePiModelListing(listing.replace('no        yes', 'no        unknown'), '')).toThrow();
});

test('accepts only a clean empty listing, not failed or unrecognized discovery', () => {
  const empty = 'No models available. Use /login to log into a provider via OAuth or API key. See:\n  /docs/providers.md\n  /docs/models.md\n';
  expect(parsePiModelListing(empty, '')).toEqual([]);
  expect(parsePiModelListing('Migration complete\n' + empty, '')).toEqual([]);
  expect(() => parsePiModelListing(empty + 'unexpected row', '')).toThrow();
  expect(() => parsePiModelListing(empty, 'Warning: errors loading models.json')).toThrow('discovery errors');
  expect(() => parsePiModelListing('', '')).toThrow();
});

async function expectDescendantStopped(binary: string) {
  const pid = (await Bun.file(`${binary}.ready`).text()).trim();
  expect(pid).toMatch(/^[1-9]\d*$/);
  const status = Bun.spawnSync(['ps', '-p', pid, '-o', 'stat=']).stdout.toString().trim();
  // The system may not have reaped an orphan that has already terminated.
  expect(status).toMatch(/^(Z.*)?$/);
}

test.skipIf(process.platform === 'win32')('a discovery timeout stops a descendant holding pipes after the CLI exits', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'pi-discovery-'));
  const binary = join(dir.path, 'pi');
  // Removing the executable also stops the fixture if group termination regresses.
  await writeFile(binary, '#!/bin/sh\nwhile [ -f "$0" ]; do sleep 0.1; done &\nprintf "%s" "$!" > "$0.ready"\n', { mode: 0o700 });
  const probe = getPiAvailableModels(binary, AbortSignal.timeout(500));
  await expect(Promise.race([probe, delay(3_000, 'still reading', { ref: false })])).rejects.toMatchObject({ name: 'TimeoutError' });
  await expectDescendantStopped(binary);
});

test.skipIf(process.platform === 'win32')('the output cap stops the entire discovery group, not just its writer', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'pi-oversize-'));
  const binary = join(dir.path, 'pi');
  await writeFile(binary, `#!/bin/sh
while [ -f "$0" ]; do sleep 0.1; done >/dev/null 2>&1 &
printf '%s' "$!" > "$0.ready"
exec dd if=/dev/zero bs=65536 count=100
`, { mode: 0o700 });
  await expect(getPiAvailableModels(binary)).rejects.toThrow('Pi model discovery failed (exit');
  await expectDescendantStopped(binary);
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
  using clock = spyOn(Date, 'now').mockReturnValue(0);
  const fiveMinutes = 5 * 60 * 1000;
  const expected = [{ value: 'acme/text', label: 'acme: text', supportsImages: false }];
  const discover = mock<() => Promise<typeof expected>>()
    .mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(expected)
    .mockRejectedValue(new Error('discovery unavailable'));
  const service = new PiModelCatalogService(testPiConfig, discover);
  expect(await service.getModelsStrict()).toEqual(expected);
  clock.mockReturnValue(fiveMinutes - 1);
  expect(await service.getModels()).toEqual(expected);
  expect(discover).toHaveBeenCalledTimes(2);
  clock.mockReturnValue(fiveMinutes);
  expect(await service.getModels()).toEqual(expected);
  clock.mockReturnValue(fiveMinutes + 14_999);
  await expect(service.getModelsStrict()).rejects.toMatchObject({ staleModels: expected });
  expect(discover).toHaveBeenCalledTimes(5);

  discover.mockResolvedValueOnce([]);
  clock.mockReturnValue(fiveMinutes + 15_000);
  expect(await service.getModelsStrict()).toEqual([]);
  expect(await service.getModelsStrict()).toEqual([]);
  clock.mockReturnValue(2 * fiveMinutes + 15_000);
  await expect(service.getModelsStrict()).rejects.toMatchObject({ staleModels: [] });
});

test('a transient retry keeps the original discovery deadline', async () => {
  const deadline = new AbortController();
  using timer = spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  const discover = mock(async (signal: AbortSignal) => {
    deadline.abort(new DOMException('Discovery timed out', 'TimeoutError'));
    signal.throwIfAborted();
    return [];
  }).mockRejectedValueOnce(new Error('temporarily unavailable'));
  const service = new PiModelCatalogService(testPiConfig, discover);
  await expect(service.getModelsStrict()).rejects.toMatchObject({
    code: 'PI_MODEL_DISCOVERY_UNAVAILABLE', message: 'Discovery timed out',
  });
  expect(discover).toHaveBeenCalledTimes(2);
  expect(timer).toHaveBeenCalledTimes(1);
});

test.each([
  ['timeout', () => { throw new DOMException('Discovery timed out', 'TimeoutError'); }],
  ['unsupported listing', () => parsePiModelListing('new format', '')],
  ['malformed row', () => parsePiModelListing('provider  model  context  max-out  thinking  images\ninvalid', '')],
] as const)('treats %s as final and forgets the failure on restart', async (_name, fail) => {
  const discover = mock(async () => fail());
  const service = new PiModelCatalogService(testPiConfig, discover);
  expect(await service.getModels()).toEqual([]);
  await expect(service.getModelsStrict()).rejects.toMatchObject({ code: 'PI_MODEL_DISCOVERY_UNAVAILABLE' });
  expect(discover).toHaveBeenCalledTimes(1);
  await service.stop();
  service.start();
  discover.mockResolvedValueOnce([]);
  expect(await service.getModelsStrict()).toEqual([]);
});

test('a missing Pi executable fails discovery once and is checked again on the next request', async () => {
  const discover = mock<() => Promise<[]>>()
    .mockRejectedValueOnce(Object.assign(new Error('Pi executable not found'), { code: 'ENOENT' }))
    .mockResolvedValue([]);
  const service = new PiModelCatalogService(testPiConfig, discover);
  await expect(service.getModelsStrict()).rejects.toMatchObject({ code: 'PI_MODEL_DISCOVERY_UNAVAILABLE' });
  expect(discover).toHaveBeenCalledTimes(1);
  expect(await service.getModelsStrict()).toEqual([]);
  expect(discover).toHaveBeenCalledTimes(2);
});
