import { expect, test } from 'bun:test';
import type { AgentCatalogSnapshot } from '@garcon/server-agent-interface';
import { captureNodeCatalogSnapshot, MAX_NODE_CATALOG_BYTES, MAX_NODE_CATALOG_MODELS, parseNodeCatalogModels, parseNodeCatalogSnapshot, parseNodeProviderCatalogReply, type NodeProviderCatalogReply } from '../provider-catalog-wire.js';

const snapshot = () => ({ models: [{ value: 'synthetic-model', label: 'Synthetic model', supportsImages: true,
  isLocal: false, apiProviderId: 'synthetic-api', endpointId: 'synthetic-endpoint', rawModel: 'native-model', protocol: 'openai-compatible' }],
  defaultModel: 'synthetic-model', requiresStrictModelDiscovery: true, generation: { priority: 10, model: 'synthetic-model' } } satisfies AgentCatalogSnapshot);

test('local model capture omits provider-private extensions and undefined optional fields while wire parsing stays exact', () => {
  const local = { ...snapshot(), models: [{ value: 'synthetic-reasoning', label: 'Synthetic reasoning',
    thinkingModes: ['low', 'medium', 'high'], supportsImages: undefined }] };
  expect(captureNodeCatalogSnapshot(local)).toEqual({ ...local, models: [{ value: 'synthetic-reasoning', label: 'Synthetic reasoning' }] });
  expect(parseNodeCatalogSnapshot(local)).toBeNull();
  expect(captureNodeCatalogSnapshot({ ...local, models: [{ value: 'synthetic', label: 'Synthetic', execute() {} }] })).toBeNull();
});

test('catalog capture and parsing never execute getters or proxy traps', () => {
  let calls = 0;
  const getter = { ...snapshot(), get defaultModel() { calls++; return calls === 1 ? 'synthetic' : 42; } };
  const modelGetter = { value: 'synthetic', label: 'Synthetic', get supportsImages() { calls++; return true; } };
  const proxy = new Proxy(snapshot(), { get() { calls++; throw new Error('Unexpected proxy access'); } });
  const revoked = Proxy.revocable(snapshot(), {}); revoked.revoke();
  for (const input of [getter, { ...snapshot(), models: [modelGetter] }, proxy, revoked.proxy]) {
    expect(parseNodeCatalogSnapshot(input)).toBeNull();
    expect(captureNodeCatalogSnapshot(input)).toBeNull();
  }
  expect(parseNodeCatalogModels(new Proxy([], { get() { calls++; return undefined; } }))).toBeNull();
  expect(parseNodeProviderCatalogReply({ kind: 'provider-catalog', instanceId: 'synthetic-instance', snapshot: getter })).toBeNull();
  expect(calls).toBe(0);
});

test('catalog DTOs copy every model field, discovery policy and generation without executable data', () => {
  const source = snapshot();
  const parsed = parseNodeCatalogSnapshot(source);
  expect(parsed).toEqual(source);
  source.models[0]!.label = 'provider mutation';
  source.generation.model = 'provider mutation';
  expect(parsed).toEqual(snapshot());
  expect(parseNodeCatalogSnapshot({ models: [], defaultModel: '', requiresStrictModelDiscovery: false, generation: null }))
    .toEqual({ models: [], defaultModel: '', requiresStrictModelDiscovery: false, generation: null });
  expect(parseNodeCatalogSnapshot({ ...snapshot(), generation: { priority: 60, model: '' } })?.generation)
    .toEqual({ priority: 60, model: '' });
});

test('catalog snapshots reject unknown fields and invalid model or generation values', () => {
  for (const invalid of [
    { ...snapshot(), extra: true }, { ...snapshot(), models: null }, { ...snapshot(), requiresStrictModelDiscovery: 1 },
    { ...snapshot(), defaultModel: 'x'.repeat(1025) }, { ...snapshot(), generation: {} },
    { ...snapshot(), generation: { model: 'synthetic', priority: Infinity } },
    { ...snapshot(), generation: { model: 'synthetic', priority: 1, extra: true } },
    ...[{ value: '', label: 'Synthetic' }, { value: 'synthetic', label: '' }, { value: 'synthetic', label: 'Synthetic', extra: true },
      ...['supportsImages', 'isLocal', 'apiProviderId', 'endpointId', 'rawModel', 'protocol'].map((key) => ({
        value: 'synthetic', label: 'Synthetic', [key]: 1,
      })), { value: 'synthetic', label: 'Synthetic', protocol: 'unknown' },
    ].map((model) => ({ ...snapshot(), models: [model] })),
    { ...snapshot(), models: [snapshot().models[0], snapshot().models[0]] },
  ]) expect(parseNodeCatalogSnapshot(invalid)).toBeNull();
});

test('catalog replies enforce identity, exact fields and both model-count and encoded-byte ceilings', () => {
  const result = { kind: 'provider-catalog', instanceId: 'synthetic-instance', snapshot: snapshot() } satisfies NodeProviderCatalogReply;
  expect(parseNodeProviderCatalogReply(result)).toEqual(result);
  const failed = { kind: 'provider-catalog-unavailable', instanceId: 'synthetic-instance', staleModels: snapshot().models } satisfies NodeProviderCatalogReply;
  expect(parseNodeProviderCatalogReply(failed)).toEqual(failed);
  expect(MAX_NODE_CATALOG_BYTES).toBe(192 * 1024);
  expect(MAX_NODE_CATALOG_MODELS).toBe(1024);
  const bounded = { ...snapshot(), models: Array.from({ length: MAX_NODE_CATALOG_MODELS }, (_, i) => ({ value: `model-${i}`, label: 'Synthetic' })) };
  expect(parseNodeCatalogSnapshot(bounded)?.models).toHaveLength(MAX_NODE_CATALOG_MODELS);
  expect(parseNodeCatalogSnapshot({ ...bounded, models: [...bounded.models, { value: 'extra', label: 'Synthetic' }] })).toBeNull();
  expect(parseNodeCatalogSnapshot({ ...bounded, models: bounded.models.map((model) => ({ ...model, label: '界'.repeat(256) })) })).toBeNull();
  for (const bad of [{ ...result, instanceId: '' }, { ...result, extra: true }, { ...result, snapshot: {} },
    { ...failed, staleModels: [false] }, { ...failed, error: 'private provider error' }]) expect(parseNodeProviderCatalogReply(bad)).toBeNull();
});

test('catalog parsing rejects executable, cyclic and inherited payloads before copying them', () => {
  const cyclic: Record<string, unknown> = snapshot(); cyclic.self = cyclic;
  const inherited = Object.assign(Object.create({ extra: true }), snapshot());
  for (const value of [cyclic, inherited, { ...snapshot(), toJSON() { return snapshot(); } },
    { ...snapshot(), models: [Object.assign(Object.create({ supportsImages: true }), { value: 'synthetic', label: 'Synthetic' })] },
    { ...snapshot(), models: [{ value: 'synthetic', label: 'Synthetic', run() {} }] },
  ]) expect(parseNodeCatalogSnapshot(value)).toBeNull();
});
