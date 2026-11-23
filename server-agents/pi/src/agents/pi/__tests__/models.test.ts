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
  const loginWarning = `Warning: ${empty}`;
  expect(parsePiModelListing(empty, '')).toEqual([]);
  expect(parsePiModelListing('Migration complete\n' + empty, '')).toEqual([]);
  expect(parsePiModelListing(empty, loginWarning.replaceAll('\n', '\r\n'))).toEqual([]);
  expect(() => parsePiModelListing(empty + 'unexpected row', '')).toThrow();
  expect(() => parsePiModelListing(empty, 'Warning: errors loading models.json')).toThrow('discovery errors');
  expect(() => parsePiModelListing(empty, loginWarning + 'Warning: errors loading models.json')).toThrow('discovery errors');
  expect(() => parsePiModelListing(empty, loginWarning.replace('/docs/', '/other/'))).toThrow('discovery errors');
  expect(() => parsePiModelListing('', '')).toThrow();
});

async function expectDescendantStopped(binary: string) {
  const pid = (await Bun.file(`${binary}.ready`).text()).trim();
  expect(pid).toMatch(/^[1-9]\d*$/);
  const status = Bun.spawnSync(['ps', '-p', pid, '-o', 'stat=']).stdout.toString().trim();
  // The system may not have reaped an orphan that has already terminated.
  expect(status).toMatch(/^(Z.*)?$/);
}

async function writeCliWithChild(directory: string, command: string, stdio: 'inherit' | 'ignore') {
  const binary = join(directory, 'pi');
  const redirect = stdio === 'ignore' ? '>/dev/null 2>&1' : '';
  // Removing the executable also stops the fixture if group termination regresses.
  await writeFile(binary, `#!/bin/sh
while [ -f "$0" ]; do sleep 0.1; done ${redirect} &
printf '%s' "$!" > "$0.ready"
${command}
`, { mode: 0o700 });
  return binary;
}

test.skipIf(process.platform === 'win32')('a discovery timeout stops a hanging CLI and its descendant', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'pi-discovery-'));
  const binary = await writeCliWithChild(dir.path, 'wait', 'inherit');
  const probe = getPiAvailableModels(binary, AbortSignal.timeout(500));
  await expect(Promise.race([probe, delay(3_000, 'still reading', { ref: false })])).rejects.toMatchObject({ name: 'TimeoutError' });
  await expectDescendantStopped(binary);
});

for (const stdio of ['inherit', 'ignore'] as const) {
  test.skipIf(process.platform === 'win32')(`reads the completed listing and stops a descendant with stdio=${stdio}`, async () => {
    await using dir = await mkdtempDisposable(join(tmpdir(), 'pi-success-'));
    const binary = await writeCliWithChild(dir.path, `echo 'provider  model  context  max-out  thinking  images'
echo 'fixture   text   32K      4K       no        no'`, stdio);
    expect(await getPiAvailableModels(binary, AbortSignal.timeout(2_000))).toEqual([
      { value: 'fixture/text', label: 'fixture: text', supportsImages: false },
    ]);
    await expectDescendantStopped(binary);
  });
}

test.skipIf(process.platform === 'win32')('the output cap stops the entire discovery group, not just its writer', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'pi-oversize-'));
  const binary = await writeCliWithChild(dir.path, 'exec dd if=/dev/zero bs=65536 count=100', 'ignore');
  await expect(getPiAvailableModels(binary)).rejects.toThrow('Pi model discovery failed (exit');
  await expectDescendantStopped(binary);
});

test('cancelling a catalog reader preserves the shared result for auth and later readers', async () => {
  const models = [{ value: 'acme/text', label: 'acme: text', supportsImages: false }];
  const probe = Promise.withResolvers<typeof models>();
  const discover = mock((_signal: AbortSignal) => probe.promise);
  const service = new PiModelCatalogService(testPiConfig, discover);
  const caller = new AbortController();
  const cancelled = service.getModels(caller.signal);
  const auth = getPiAuthStatus(service);
  caller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  expect(discover.mock.calls[0]?.[0].aborted).toBe(false);

  probe.resolve(models);
  expect((await auth).authenticated).toBe(true);
  expect(await service.getModelsStrict()).toEqual(models);
  expect(discover).toHaveBeenCalledTimes(1);
});

test('executor shutdown drains shared discovery without retrying', async () => {
  const cleanup = Promise.withResolvers<void>();
  const discover = mock(async (lifetime: AbortSignal) => {
    await new Promise<void>(resolve => lifetime.addEventListener('abort', () => resolve(), { once: true }));
    await cleanup.promise;
    lifetime.throwIfAborted();
    return [];
  });
  const service = new PiModelCatalogService(testPiConfig, discover);
  const catalog = service.getModelsStrict();
  const auth = getPiAuthStatus(service).catch((error: unknown) => error);
  let drained = false;
  const stopped = service.stop().then(() => { drained = true; });
  expect(discover.mock.calls[0]?.[0].aborted).toBe(true);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(drained).toBe(false);
  cleanup.resolve();
  await expect(catalog).rejects.toMatchObject({ name: 'AbortError' });
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
  expect(timer.mock.calls).toEqual([[20_000]]);
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
