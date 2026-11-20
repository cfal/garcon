import { describe, expect, it, mock, spyOn } from 'bun:test';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { assertLoadedTierAvailable } from '../service-tier-discovery.js';

type CatalogReader = Parameters<typeof assertLoadedTierAvailable>[0];
const model = { model: 'm', serviceTiers: [{ id: 'ultrafast' }] };
const feature = { name: 'ultrafast_mode', enabled: true };

describe('Codex loaded-tier discovery', () => {
  it.each([
    ['priority', 'fast_mode', 'ultrafast_mode'],
    ['ultrafast', 'ultrafast_mode', 'fast_mode'],
  ] as const)('requires the %s ID and its own resolved thread feature', async (tier, gate, otherGate) => {
    const entry = { model: 'test-slug', id: 'preset', serviceTiers: [{ id: tier, name: 'Synthetic label' }] };
    const selectedFeature = { name: gate, enabled: true };
    const otherFeature = { name: otherGate, enabled: false };
    const client = {
      async request(method, params) {
        if (method === 'experimentalFeature/list') {
          expect(params.threadId).toBe('test-thread');
          return { data: [selectedFeature, otherFeature] };
        }
        return params.cursor ? { data: [entry] } : { data: [], nextCursor: 'next-page' };
      },
    } satisfies CatalogReader;
    const check = (slug = entry.model) => assertLoadedTierAvailable(client, 'test-thread', slug, tier, 1000);
    await check();
    await expect(check('preset')).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
    selectedFeature.enabled = false;
    otherFeature.enabled = true;
    await expect(check()).rejects.toThrow('unavailable');
    selectedFeature.enabled = true;
    entry.serviceTiers = [{ id: tier === 'priority' ? 'ultrafast' : 'priority', name: tier }];
    await expect(check()).rejects.toThrow('unavailable');
  });

  it('bounds cyclic pagination and makes no discovery calls for Standard', async () => {
    const client = { request: mock(async () => ({ data: [], nextCursor: 'cycle' })) } satisfies CatalogReader;
    await assertLoadedTierAvailable(client, 't', 'm', 'default', 100);
    expect(client.request).not.toHaveBeenCalled();
    await expect(assertLoadedTierAvailable(client, 't', 'm', 'ultrafast', 100))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(client.request).toHaveBeenCalledTimes(4);
  });

  it('distinguishes an expired or incomplete discovery from a definitive unsupported tier', async () => {
    const client = { request: mock(async (): Promise<unknown> => ({ data: [] })) } satisfies CatalogReader;
    const check = (ms = 100) => assertLoadedTierAvailable(client, 't', 'm', 'ultrafast', ms);
    await expect(check(0)).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(client.request).not.toHaveBeenCalled();
    await expect(check()).rejects.toMatchObject({ code: 'INVALID_SETTINGS', retryable: false });
    for (const page of [null, { data: [null] }, { data: [], nextCursor: 3 }]) {
      client.request.mockResolvedValue(page);
      await expect(check()).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    }
    for (const { serviceTiers, enabled } of [
      { serviceTiers: null, enabled: true },
      { serviceTiers: [{ name: 'ultrafast' }], enabled: true },
      { serviceTiers: [], enabled: 'unknown' },
    ]) {
      client.request.mockResolvedValueOnce({ data: [{ model: 'm', serviceTiers }] });
      client.request.mockResolvedValueOnce({ data: [{ name: 'ultrafast_mode', enabled }] });
      await expect(check()).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    }
  });

  it.each(['model/list', 'experimentalFeature/list'])(
    'stops %s after ten distinct pages instead of reporting unsupported', async (paginatedMethod) => {
      const cursors: unknown[] = [];
      const client = {
        async request(method, params) {
          if (method !== paginatedMethod) return { data: [method === 'model/list' ? model : feature] };
          cursors.push(params.cursor);
          return { data: [], nextCursor: `page-${cursors.length}` };
        },
      } satisfies CatalogReader;
      await expect(assertLoadedTierAvailable(client, 't', 'm', 'ultrafast', 1000))
        .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
      expect(cursors).toEqual([undefined, ...Array.from({ length: 9 }, (_, index) => `page-${index + 1}`)]);
    },
  );

  it('starts both probes in parallel and carries one deadline through both paginated catalogs', async () => {
    let now = 0;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    const firstPages = Promise.withResolvers<{ data: never[]; nextCursor: string }>();
    const client = { request: mock<CatalogReader['request']>(async (method, params) => {
      if (!params.cursor) return firstPages.promise;
      return { data: [method === 'model/list' ? model : feature] };
    }) } satisfies CatalogReader;
    const checking = assertLoadedTierAvailable(client, 't', 'm', 'ultrafast', 100);
    try {
      expect(client.request.mock.calls).toEqual([
        ['model/list', { includeHidden: true, cursor: undefined, limit: 100 }, 100],
        ['experimentalFeature/list', { threadId: 't', cursor: undefined, limit: 100 }, 100],
      ]);
      now = 75;
      firstPages.resolve({ data: [], nextCursor: 'next' });
      await checking;
      expect(client.request.mock.calls.slice(2)).toEqual([
        ['model/list', { includeHidden: true, cursor: 'next', limit: 100 }, 25],
        ['experimentalFeature/list', { threadId: 't', cursor: 'next', limit: 100 }, 25],
      ]);
    } finally {
      firstPages.resolve({ data: [], nextCursor: 'next' });
      await checking.catch(() => undefined);
      clock.mockRestore();
    }
  });

  it('does not issue another page after the shared deadline expires', async () => {
    let now = 0;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    const firstPage = Promise.withResolvers<{ data: never[]; nextCursor: string }>();
    const client = { request: mock<CatalogReader['request']>(async (method) => (
      method === 'model/list' ? firstPage.promise : { data: [feature] }
    )) } satisfies CatalogReader;
    const checking = assertLoadedTierAvailable(client, 't', 'm', 'ultrafast', 100);
    try {
      now = 100;
      firstPage.resolve({ data: [], nextCursor: 'next' });
      await expect(checking).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
      expect(client.request).toHaveBeenCalledTimes(2);
    } finally {
      firstPage.resolve({ data: [], nextCursor: 'next' });
      await checking.catch(() => undefined);
      clock.mockRestore();
    }
  });

  it.each(['model/list', 'experimentalFeature/list'])('sanitizes untyped %s failures but preserves typed retry policy', async (failedMethod) => {
    let failure = new Error('Synthetic secret: /private/config token=do-not-publish');
    const client = {
      async request(method) {
        if (method === failedMethod) throw failure;
        return { data: [method === 'model/list' ? model : feature] };
      },
    } satisfies CatalogReader;
    const check = () => assertLoadedTierAvailable(client, 't', 'm', 'ultrafast', 100);
    await expect(check()).rejects.toMatchObject({
      code: 'UNAVAILABLE', retryable: true,
      message: `Codex ${failedMethod} could not verify speed; check the executor configuration and retry.`,
    });
    for (const retryable of [true, false]) {
      failure = new AgentIntegrationError('TIMEOUT', 'Synthetic bounded discovery timeout', retryable);
      await expect(check()).rejects.toBe(failure);
    }
  });
});
