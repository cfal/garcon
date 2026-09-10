import { expect, test } from 'bun:test';
import type { SharedModelOption } from '@garcon/common/models';
import { PiModelCatalogService } from '../pi-models.js';
import { testPiConfig } from './test-fixtures.js';

const available: SharedModelOption[] = [{ value: 'synthetic/model', label: 'Model', supportsImages: false }];

test('shares discovery within one instance while cancelling only the departing reader', async () => {
  const release = Promise.withResolvers<SharedModelOption[]>();
  const signals: AbortSignal[] = [];
  const models = new PiModelCatalogService(testPiConfig, (signal) => {
    signals.push(signal);
    return release.promise;
  });
  const controller = new AbortController();
  const first = models.getModelsStrict(controller.signal);
  const second = models.getModelsStrict();
  controller.abort(new Error('First reader cancelled'));
  await expect(first).rejects.toBe(controller.signal.reason);
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(false);
  release.resolve(available);
  expect(await second).toEqual(available);
  expect(await models.getModelsStrict()).toEqual(available);
  expect(signals).toHaveLength(1);
});

test('cancels the discovery when its last reader departs without retrying', async () => {
  let attempts = 0;
  let discoverySignal: AbortSignal | null = null;
  const models = new PiModelCatalogService(testPiConfig, (signal) => {
    attempts += 1;
    discoverySignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = models.getModels(controller.signal);
  controller.abort(new Error('Last reader cancelled'));
  await expect(pending).rejects.toBe(controller.signal.reason);
  expect(discoverySignal).toMatchObject({ aborted: true });
  expect(attempts).toBe(1);
});

test('late abandoned discovery cannot cache its result or clear a successor lookup', async () => {
  const abandoned = Promise.withResolvers<SharedModelOption[]>();
  const successor = Promise.withResolvers<SharedModelOption[]>();
  let attempts = 0;
  const models = new PiModelCatalogService(testPiConfig, () => {
    attempts += 1;
    return attempts === 1 ? abandoned.promise : successor.promise;
  });
  const controller = new AbortController();
  const oldRead = models.getModelsStrict(controller.signal);
  controller.abort(new Error('Old read cancelled'));
  await expect(oldRead).rejects.toBe(controller.signal.reason);
  const newRead = models.getModelsStrict();
  abandoned.resolve([{ value: 'synthetic/obsolete', label: 'Obsolete' }]);
  await Promise.resolve();
  await Promise.resolve();
  const concurrentRead = models.getModelsStrict();
  expect(attempts).toBe(2);
  successor.resolve(available);
  expect(await newRead).toEqual(available);
  expect(await concurrentRead).toEqual(available);
  expect(await models.getModelsStrict()).toEqual(available);
});

test('a cached catalog does not bypass a cancelled request or expose mutable cache objects', async () => {
  let attempts = 0;
  const models = new PiModelCatalogService(testPiConfig, async () => {
    attempts += 1;
    return available;
  });
  const first = await models.getModelsStrict();
  first[0]!.label = 'Caller mutation';
  expect(await models.getModels()).toEqual(available);
  const signal = AbortSignal.abort(new Error('Cached request cancelled'));
  await expect(models.getModels(signal)).rejects.toBe(signal.reason);
  expect(attempts).toBe(1);
});

test('keeps per-instance inflight, fresh and stale catalogs separate', async () => {
  const firstResult = Promise.withResolvers<SharedModelOption[]>();
  let failFirst = false;
  let firstCalls = 0;
  let secondCalls = 0;
  const first = new PiModelCatalogService(testPiConfig, async () => {
    firstCalls += 1;
    if (failFirst) throw new Error('Synthetic discovery unavailable');
    return firstResult.promise;
  });
  const secondModels = [{ value: 'synthetic/second', label: 'Second' }];
  const second = new PiModelCatalogService(testPiConfig, async () => {
    secondCalls += 1;
    return secondModels;
  });
  const firstRead = first.getModelsStrict();
  expect(await second.getModelsStrict()).toEqual(secondModels);
  firstResult.resolve(available);
  expect(await firstRead).toEqual(available);
  failFirst = true;
  first.expireForTests();
  await expect(first.getModelsStrict()).rejects.toMatchObject({
    code: 'PI_MODEL_DISCOVERY_UNAVAILABLE', staleModels: available,
  });
  expect(await second.getModels()).toEqual(secondModels);
  expect(secondCalls).toBe(1);
  expect(firstCalls).toBe(4);
  expect(await first.getModels()).toEqual(available);
});

test('cancellation never becomes stale-cache fallback', async () => {
  const refreshing = Promise.withResolvers<SharedModelOption[]>();
  let first = true;
  const models = new PiModelCatalogService(testPiConfig, () => {
    if (!first) return refreshing.promise;
    first = false;
    return Promise.resolve(available);
  });
  await models.getModelsStrict();
  models.expireForTests();
  const controller = new AbortController();
  const pending = models.getModels(controller.signal);
  controller.abort(new Error('Refresh cancelled'));
  refreshing.resolve(available);
  await expect(pending).rejects.toBe(controller.signal.reason);
});
