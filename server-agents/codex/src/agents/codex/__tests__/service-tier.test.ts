import { describe, expect, it, mock } from 'bun:test';
import { assertLoadedTierAvailable } from '../app-server/service-tier-discovery.js';
import { assertEffectiveTier, codexServiceTier, codexSpeed } from '../service-tier.js';

describe('Codex speed selection', () => {
  it('defaults an old empty settings envelope to Standard without accepting unknown values', () => {
    const envelope = { ownerId: 'codex', schemaVersion: 1, values: {} };
    expect(codexServiceTier(codexSpeed(envelope))).toBe('default');
    for (const speed of [null, 'priority', 'toString']) {
      expect(() => codexSpeed({ ...envelope, values: { speed } })).toThrow('Invalid value');
    }
  });

  it('accepts native aliases but rejects a different effective tier', () => {
    for (const standard of [null, 'default']) {
      expect(() => assertEffectiveTier('default', standard, 'm')).not.toThrow();
    }
    expect(() => assertEffectiveTier('priority', 'fast', 'm')).not.toThrow();
    for (const effective of [null, 'priority', 'default', 'flex']) {
      expect(() => assertEffectiveTier('ultrafast', effective, 'm')).toThrow('Ultrafast speed is unavailable');
    }
    expect(() => assertEffectiveTier('default', 'ultrafast', 'm')).toThrow();
  });

  it.each([
    ['priority', 'fast_mode', 'ultrafast_mode'],
    ['ultrafast', 'ultrafast_mode', 'fast_mode'],
  ] as const)('requires the %s ID and its own resolved thread feature', async (tier, gate, otherGate) => {
    const model = { model: 'test-slug', id: 'preset', serviceTiers: [{ id: tier, name: 'Synthetic label' }] };
    const selectedFeature = { name: gate, enabled: true };
    const otherFeature = { name: otherGate, enabled: false };
    const client = {
      async request(method: string, params: Record<string, unknown>) {
        if (method === 'experimentalFeature/list') {
          expect(params.threadId).toBe('test-thread');
          return { data: [selectedFeature, otherFeature] };
        }
        return params.cursor ? { data: [model] } : { data: [], nextCursor: 'next-page' };
      },
    };
    const check = (slug = model.model) => assertLoadedTierAvailable(client, 'test-thread', slug, tier, 1000);
    await check();
    await expect(check('preset')).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
    selectedFeature.enabled = false;
    otherFeature.enabled = true;
    await expect(check()).rejects.toThrow('unavailable');
    selectedFeature.enabled = true;
    model.serviceTiers = [{ id: tier === 'priority' ? 'ultrafast' : 'priority', name: tier }];
    await expect(check()).rejects.toThrow('unavailable');
  });

  it('bounds paginated discovery and makes no discovery calls for Standard', async () => {
    const client = { request: mock(async () => ({ data: [], nextCursor: 'cycle' })) };
    await assertLoadedTierAvailable(client, 't', 'm', 'default', 100);
    expect(client.request).not.toHaveBeenCalled();
    await expect(assertLoadedTierAvailable(client, 't', 'm', 'ultrafast', 100))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(client.request).toHaveBeenCalledTimes(4);
  });

  it('distinguishes an expired or incomplete discovery from a definitive unsupported tier', async () => {
    const client = { request: mock(async (): Promise<unknown> => ({ data: [] })) };
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
});
