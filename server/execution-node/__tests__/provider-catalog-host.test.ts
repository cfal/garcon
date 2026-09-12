import { expect, mock, test } from 'bun:test';
import { NodeProviderCapacity } from '../provider-capacity.js';
import type { AgentCatalogSnapshot } from '@garcon/server-agent-interface';
import { NodeProviderCatalogHost } from '../provider-catalog-host.js';
import { NODE_WORKER_SERVICE_LIMITS } from '../worker/limits.js';

const snapshot: AgentCatalogSnapshot = { models: [{ value: 'synthetic', label: 'Synthetic' }], defaultModel: 'synthetic',
  requiresStrictModelDiscovery: true, generation: null };

test('catalog host preserves bounded stale models without disclosing native error bodies', async () => {
  const error = Object.assign(new Error('Synthetic private native error'), { staleModels: snapshot.models });
  const host = new NodeProviderCatalogHost(new NodeProviderCapacity(), 'synthetic-instance', { snapshot: async () => { throw error; } });
  expect(await host.snapshot({ strict: true }, new AbortController().signal))
    .toEqual({ kind: 'provider-catalog-unavailable', instanceId: 'synthetic-instance', staleModels: snapshot.models });
});

test('catalog host refuses invalid provider results instead of serializing away unknown properties', async () => {
  const host = new NodeProviderCatalogHost(new NodeProviderCapacity(), 'synthetic-instance', { snapshot: async () => ({ ...snapshot, privateExtra: 'synthetic' }) });
  expect(await host.snapshot({ strict: true }, new AbortController().signal)).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
});

test('catalog host projects provider-specific model metadata into the shared reply', async () => {
  const host = new NodeProviderCatalogHost(new NodeProviderCapacity(), 'synthetic-instance', { snapshot: async () => ({ ...snapshot,
    models: [{ value: 'synthetic', label: 'Synthetic', thinkingModes: ['low', 'high'], supportsImages: undefined }],
  }) });
  expect(await host.snapshot({ strict: true }, new AbortController().signal))
    .toEqual({ kind: 'provider-catalog', instanceId: 'synthetic-instance', snapshot });
});

test('cancelled catalog reads retain instance capacity until the native promises settle', async () => {
  const pending = Promise.withResolvers<AgentCatalogSnapshot>();
  const read = mock(() => pending.promise);
  const host = new NodeProviderCatalogHost(new NodeProviderCapacity(), 'synthetic-instance', { snapshot: read });
  const firstConnection = new AbortController();
  const work = Array.from({ length: NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests }, () => host.snapshot({ strict: true }, firstConnection.signal));
  const settled = Promise.allSettled(work);
  const reason = new Error('Synthetic replaced connection');
  firstConnection.abort(reason);
  const replacement = new AbortController().signal;
  expect(await host.snapshot({ strict: true }, replacement)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
  expect(read).toHaveBeenCalledTimes(NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests);
  pending.resolve(snapshot);
  expect(await settled).toEqual(work.map(() => ({ status: 'rejected', reason })));
  expect(await host.snapshot({ strict: false }, replacement)).toEqual({ kind: 'provider-catalog', instanceId: 'synthetic-instance', snapshot });
});
