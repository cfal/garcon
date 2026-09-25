import { describe, expect, it, mock } from 'bun:test';
import { ModelCatalogResponseCache } from '../model-catalog-cache.js';

function buildModelCatalog({ agentsEntries = [], providers = [] } = {}) {
  return {
    agents: {
      getAgentCatalogEntries: () => Promise.resolve(agentsEntries),
    },
    apiProviders: {
      getCatalog: () => providers,
    },
  };
}

describe('ModelCatalogResponseCache', () => {

  it('does not cache rejected executor lookups or let a stale rejection evict a replacement', async () => {
    const cache = new ModelCatalogResponseCache();
    const executorId = '22222222-2222-4222-8222-222222222222';
    const pending = Promise.withResolvers();
    const load = mock(async () => { throw new Error('Executor unavailable'); });
    const catalog = { agents: { getAgentCatalogEntries: load }, apiProviders: { getCatalog: () => [] } };
    await expect(cache.getSnapshot(catalog, executorId)).rejects.toThrow('Executor unavailable');
    load.mockImplementationOnce(() => pending.promise);
    const stale = cache.getSnapshot(catalog, executorId);
    cache.clear(executorId);
    load.mockResolvedValue([{ id: 'test' }]);
    const replacement = await cache.getSnapshot(catalog, executorId);
    pending.reject(new Error('Old executor unavailable'));
    await expect(stale).rejects.toThrow('Old executor unavailable');
    expect(await cache.getSnapshot(catalog, executorId)).toBe(replacement);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('caches the snapshot within the TTL', async () => {
    const cache = new ModelCatalogResponseCache();
    const catalog = buildModelCatalog({ agentsEntries: [{ id: 'claude' }] });

    const first = await cache.getSnapshot(catalog);
    const second = await cache.getSnapshot(catalog);

    expect(second).toBe(first);
  });

  it('rebuilds after clear() is called', async () => {
    const cache = new ModelCatalogResponseCache();
    const catalogA = buildModelCatalog({ agentsEntries: [{ id: 'claude' }] });
    const catalogB = buildModelCatalog({ agentsEntries: [{ id: 'codex' }] });

    const first = await cache.getSnapshot(catalogA);
    expect(first.body.catalog.agents).toEqual([{ id: 'claude' }]);

    cache.clear();

    const second = await cache.getSnapshot(catalogB);
    expect(second.body.catalog.agents).toEqual([{ id: 'codex' }]);
  });

  it('does not commit a stale snapshot when clear() runs during an in-flight fetch', async () => {
    const cache = new ModelCatalogResponseCache();
    let resolveFirst;
    const firstEntries = [{ id: 'claude' }];
    const secondEntries = [{ id: 'codex' }];
    const catalog = {
      agents: {
        getAgentCatalogEntries: () => new Promise((resolve) => {
          // First call hangs until resolveFirst is invoked; later calls resolve with fresh data.
          if (!resolveFirst) {
            resolveFirst = () => resolve(firstEntries);
          } else {
            resolve(secondEntries);
          }
        }),
      },
      apiProviders: { getCatalog: () => [] },
    };

    // Start an in-flight fetch. It will hang on the first call.
    const inflight = cache.getSnapshot(catalog);

    // While it is in flight, clear the cache. This must bump the generation so
    // the resolving promise cannot commit a stale snapshot.
    cache.clear();

    // Release the in-flight fetch. Without the generation guard, its .then()
    // would write the stale snapshot back into #cachedCatalogResponse.
    resolveFirst();
    await inflight;

    // The next getSnapshot call must rebuild — the stale snapshot should not have been committed.
    const snapshot = await cache.getSnapshot(catalog);
    expect(snapshot.body.catalog.agents).toEqual([{ id: 'codex' }]);
  });

  it('returns the in-flight snapshot to concurrent callers even if clear() runs', async () => {
    const cache = new ModelCatalogResponseCache();
    let resolveFirst;
    const firstEntries = [{ id: 'claude' }];
    const catalog = {
      agents: {
        getAgentCatalogEntries: () => new Promise((resolve) => {
          if (!resolveFirst) {
            resolveFirst = () => resolve(firstEntries);
          } else {
            resolve([{ id: 'codex' }]);
          }
        }),
      },
      apiProviders: { getCatalog: () => [] },
    };

    const firstCall = cache.getSnapshot(catalog);
    const secondCall = cache.getSnapshot(catalog);
    cache.clear();
    resolveFirst();

    const [first, second] = await Promise.all([firstCall, secondCall]);
    // Both concurrent callers receive the in-flight snapshot — they started before clear().
    expect(first.body.catalog.agents).toEqual([{ id: 'claude' }]);
    expect(second).toBe(first);

    // A new call after clear() rebuilds fresh.
    const third = await cache.getSnapshot(catalog);
    expect(third.body.catalog.agents).toEqual([{ id: 'codex' }]);
  });
});
