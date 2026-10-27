import { describe, expect, it, mock } from 'bun:test';
import { ModelCatalogResponseCache } from '../model-catalog-cache.js';

function fixture(load = mock(async () => [{ id: 'synthetic-agent' }])) {
  let instanceId = 'instance-a';
  const catalog = {
    agents: {
      captureCatalog() {
        const captured = instanceId;
        return {
          executorInstanceId: captured,
          assertCurrent() { if (captured !== instanceId) throw new Error('Generation retired'); },
          getAgentCatalogEntries: load,
        };
      },
    },
    apiProviders: { getCatalog: () => [] },
  };
  return { cache: new ModelCatalogResponseCache(), catalog, load, replace: () => { instanceId = 'instance-b'; } };
}

describe('ModelCatalogResponseCache', () => {
  it('caches the snapshot within the TTL', async () => {
    const { cache, catalog, load } = fixture();
    const first = await cache.getSnapshot(catalog);
    expect(await cache.getSnapshot(catalog)).toBe(first);
    expect(first.body.executorInstanceId).toBe('instance-a');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache rejected lookups or let a stale rejection evict a replacement', async () => {
    const pending = Promise.withResolvers();
    const { cache, catalog, load } = fixture(mock(async () => { throw new Error('Unavailable'); }));
    await expect(cache.getSnapshot(catalog)).rejects.toThrow('Unavailable');
    load.mockImplementationOnce(() => pending.promise);
    const stale = cache.getSnapshot(catalog);
    cache.clear();
    load.mockResolvedValue([{ id: 'test' }]);
    const replacement = await cache.getSnapshot(catalog);
    pending.reject(new Error('Old executor unavailable'));
    await expect(stale).rejects.toThrow('Old executor unavailable');
    expect(await cache.getSnapshot(catalog)).toBe(replacement);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('returns same-generation results to evicted waiters without replacing the new cache', async () => {
    const pending = Promise.withResolvers();
    const { cache, catalog, load } = fixture(mock(() => pending.promise));
    const first = cache.getSnapshot(catalog);
    const second = cache.getSnapshot(catalog);
    cache.clear();
    load.mockResolvedValue([{ id: 'fresh-agent' }]);
    const refreshed = await cache.getSnapshot(catalog);
    pending.resolve([{ id: 'original-agent' }]);
    const snapshot = await first;
    expect(await second).toBe(snapshot);
    expect(snapshot.body.catalog.agents).toEqual([{ id: 'original-agent' }]);
    expect(() => snapshot.assertCurrent()).not.toThrow();
    expect(await cache.getSnapshot(catalog)).toBe(refreshed);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects all original waiters after generation replacement and invalidation', async () => {
    const pending = Promise.withResolvers();
    const { cache, catalog, load, replace } = fixture(mock(() => pending.promise));
    const first = cache.getSnapshot(catalog);
    const second = cache.getSnapshot(catalog);
    const results = Promise.allSettled([first, second]);
    replace();
    cache.clear();
    pending.resolve([{ id: 'stale-agent' }]);
    expect(await results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: 'Generation retired' }) },
      { status: 'rejected', reason: expect.objectContaining({ message: 'Generation retired' }) },
    ]);
    load.mockResolvedValue([{ id: 'new-agent' }]);
    expect((await cache.getSnapshot(catalog)).body.catalog.agents).toEqual([{ id: 'new-agent' }]);
  });

  it('rejects stale completion without requiring explicit cache invalidation', async () => {
    const pending = Promise.withResolvers();
    const { cache, catalog, replace } = fixture(mock(() => pending.promise));
    const result = cache.getSnapshot(catalog);
    replace();
    pending.resolve([]);
    await expect(result).rejects.toThrow('Generation retired');
  });

  it('changes the ETag and response owner on replacement with identical inventory', async () => {
    const { cache, catalog, replace } = fixture();
    const first = await cache.getSnapshot(catalog);
    replace();
    const second = await cache.getSnapshot(catalog);
    expect(second.body.catalog).toEqual(first.body.catalog);
    expect(second.body.executorInstanceId).toBe('instance-b');
    expect(second.etag).not.toBe(first.etag);
  });

  it('accepts an empty inventory', async () => {
    const { cache, catalog } = fixture(mock(async () => []));
    expect((await cache.getSnapshot(catalog)).body.catalog.agents).toEqual([]);
  });

  it('fences an already-completed snapshot at HTTP publication', async () => {
    const { cache, catalog, replace } = fixture();
    const snapshot = await cache.getSnapshot(catalog);
    cache.clear();
    expect(() => snapshot.assertCurrent()).not.toThrow();
    replace();
    expect(() => snapshot.assertCurrent()).toThrow('Generation retired');
  });
});
