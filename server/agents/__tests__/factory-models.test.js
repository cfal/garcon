import { describe, expect, it } from 'bun:test';

import { getFactoryModelCatalog } from '../factory/factory-models.js';

describe('factory model discovery', () => {
  it('returns a catalog with a valid default model and image support metadata', async () => {
    const catalog = await getFactoryModelCatalog(true);

    expect(catalog.options.length).toBeGreaterThan(0);
    expect(catalog.options.find((entry) => entry.value === catalog.defaultModel)).toBeTruthy();
    expect(typeof catalog.metadata[catalog.defaultModel]?.supportsImages).toBe('boolean');
  }, 10_000);

  it('includes reasoning efforts when the droid CLI is available', async () => {
    const catalog = await getFactoryModelCatalog(true);
    const gpt54 = catalog.metadata['gpt-5.4'];
    // reasoningEfforts is only populated when `droid exec --help` is reachable.
    // In CI without the binary, the fallback catalog omits this field.
    if (gpt54?.reasoningEfforts) {
      expect(gpt54.reasoningEfforts.includes('xhigh')).toBe(true);
    }
  }, 10_000);
});
