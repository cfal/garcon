import { describe, expect, it, mock } from 'bun:test';
import { assertLoadedTierAvailable } from '../app-server/service-tier-discovery.js';
import { assertEffectiveTier, codexServiceTier, codexSpeed } from '../service-tier.js';

describe('Codex speed selection', () => {
  it('defaults an old empty settings envelope to Standard without accepting unknown values', () => {
    const envelope = { ownerId: 'codex', schemaVersion: 1, values: {} };
    expect(codexServiceTier(codexSpeed(envelope))).toBe('default');
    expect(() => codexSpeed({ ...envelope, values: { speed: null } })).toThrow('Invalid value');
    for (const standard of [null, 'default']) expect(() => assertEffectiveTier('default', standard, 'm')).not.toThrow();
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
    const features = [{ name: gate, enabled: true }, { name: otherGate, enabled: false }];
    const client = { request: mock(async (method: string, params: Record<string, unknown>, _timeout: number) => {
      if (method === 'experimentalFeature/list') {
        expect(params.threadId).toBe('test-thread');
        return { data: features };
      }
      return params.cursor ? { data: [model] } : { data: [], nextCursor: 'next-page' };
    }) };
    const check = (slug = model.model) => assertLoadedTierAvailable(client, 'test-thread', slug, tier, 1000);
    await check();
    await expect(check('preset')).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
    features[0]!.enabled = false;
    features[1]!.enabled = true;
    await expect(check()).rejects.toThrow('unavailable');
    features[0]!.enabled = true;
    model.serviceTiers = [{ id: tier === 'priority' ? 'ultrafast' : 'priority', name: tier }];
    await expect(check()).rejects.toThrow('unavailable');
  });

  it('bounds paginated discovery and makes no discovery calls for Standard', async () => {
    const client = { request: mock(async () => ({ data: [], nextCursor: 'cycle' })) };
    await assertLoadedTierAvailable(client, 't', 'm', 'default', 100);
    expect(client.request).not.toHaveBeenCalled();
    await expect(assertLoadedTierAvailable(client, 't', 'm', 'ultrafast', 100)).rejects.toThrow('unavailable');
    expect(client.request).toHaveBeenCalledTimes(4);
  });
});
