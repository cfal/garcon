import { describe, expect, it, mock } from 'bun:test';
import { createModelCatalog } from '../model-catalog.js';

const fallback = [{ value: 'static-model', label: 'Static model' }];

describe('createModelCatalog', () => {
  it('preserves static models when non-strict discovery fails', async () => {
    const warn = mock(() => {});
    const catalog = createModelCatalog({
      logger: { debug() {}, info() {}, warn, error() {} },
      defaultModel: 'static-model',
      fallbackModels: fallback,
      requiresStrictModelDiscovery: false,
      generation: null,
      discover: async () => { throw new Error('secret provider payload'); },
    });

    const snapshot = await catalog.snapshot({ strict: false, signal: new AbortController().signal });

    expect(snapshot.models).toEqual(fallback);
    expect(warn).toHaveBeenCalledWith(
      'Dynamic model discovery failed; using static models.',
      { code: 'MODEL_DISCOVERY_FAILED' },
    );
  });

  it('keeps strict discovery failures visible', async () => {
    const catalog = createModelCatalog({
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      defaultModel: 'static-model',
      fallbackModels: fallback,
      requiresStrictModelDiscovery: true,
      generation: null,
      discover: async () => { throw new Error('discovery failed'); },
    });

    await expect(catalog.snapshot({
      strict: true,
      signal: new AbortController().signal,
    })).rejects.toThrow('discovery failed');
  });
});
