import { expect, mock, test } from 'bun:test';
import { LocalProviderCatalogService } from '../local-provider-catalog.js';

function catalog(model) {
  return {
    models: [{ value: model, label: model, supportsImages: false }],
    defaultModel: model,
    requiresStrictModelDiscovery: true,
    generation: { priority: 10, model },
  };
}

function service(snapshot) {
  /** @satisfies {Pick<import('@garcon/server-agent-interface').AgentIntegration, 'catalog'>} */
  const integration = { catalog: { snapshot } };
  return new LocalProviderCatalogService(integration);
}

test('captures request options while preserving the exact cancellation signal', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const calls = [];
  const owner = service(async (request) => {
    entered.resolve();
    await release.promise;
    calls.push(request);
    return catalog('synthetic-model');
  });
  const input = { strict: true };
  const signal = new AbortController().signal;
  const pending = owner.snapshot(input, signal);
  await entered.promise;
  input.strict = false;
  release.resolve();
  await pending;
  expect(calls).toEqual([{ strict: true, signal }]);
  expect(calls[0].signal).toBe(signal);
});

test('returns owned snapshots without exposing the provider cache', async () => {
  const cached = catalog('synthetic-model');
  const owner = service(async () => cached);
  const signal = new AbortController().signal;
  const first = await owner.snapshot({ strict: false }, signal);
  first.models[0].label = 'caller mutation';
  first.generation.model = 'caller mutation';
  expect(await owner.snapshot({ strict: false }, signal)).toEqual(catalog('synthetic-model'));
  cached.models[0].label = 'provider mutation';
  expect(first.models[0].label).toBe('caller mutation');
});

test('separately bound catalogs cannot exchange responses during interleaved discovery', async () => {
  const firstResult = Promise.withResolvers();
  const first = service(() => firstResult.promise);
  const second = service(async () => catalog('second-profile'));
  const signal = new AbortController().signal;
  const pending = first.snapshot({ strict: true }, signal);
  expect(await second.snapshot({ strict: true }, signal)).toEqual(catalog('second-profile'));
  firstResult.resolve(catalog('first-profile'));
  expect(await pending).toEqual(catalog('first-profile'));
});

test('refuses an already aborted catalog read before entering the provider', async () => {
  const snapshot = mock(async () => catalog('synthetic-model'));
  const owner = service(snapshot);
  const lifetime = new AbortController();
  const reason = new Error('Synthetic cancellation');
  lifetime.abort(reason);
  await expect(owner.snapshot({ strict: true }, lifetime.signal)).rejects.toBe(reason);
  expect(snapshot).not.toHaveBeenCalled();
});

test('does not deliver a catalog after cancellation during the provider read', async () => {
  const release = Promise.withResolvers();
  const owner = service(() => release.promise);
  const lifetime = new AbortController();
  const pending = owner.snapshot({ strict: true }, lifetime.signal);
  const reason = new Error('Synthetic cancellation');
  lifetime.abort(reason);
  release.resolve(catalog('synthetic-model'));
  await expect(pending).rejects.toBe(reason);
});

test('preserves provider discovery errors and their stale-catalog evidence', async () => {
  const error = Object.assign(new Error('Synthetic discovery failure'), {
    code: 'SYNTHETIC_DISCOVERY_UNAVAILABLE',
    staleModels: catalog('stale-model').models,
  });
  const owner = service(async () => { throw error; });
  await expect(owner.snapshot({ strict: true }, new AbortController().signal)).rejects.toBe(error);
});
