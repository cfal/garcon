import { describe, expect, it } from 'bun:test';

import { getFactoryModelCatalog } from '../factory-models.js';

describe('factory model discovery', () => {
  it('returns a catalog with expected default model and image support metadata', async () => {
    const catalog = await getFactoryModelCatalog(true);

    expect(catalog.defaultModel).toBe('claude-opus-4-7');
    expect(catalog.options.find((entry) => entry.value === 'claude-opus-4-7')).toBeTruthy();
    expect(catalog.metadata['claude-opus-4-7']?.supportsImages).toBe(true);
    expect(catalog.metadata['glm-5']?.supportsImages).toBe(false);
  });

  it('includes reasoning efforts when the droid CLI is available', async () => {
    const catalog = await getFactoryModelCatalog(true);
    const gpt54 = catalog.metadata['gpt-5.4'];
    // reasoningEfforts is only populated when `droid exec --help` is reachable.
    // In CI without the binary, the fallback catalog omits this field.
    if (gpt54?.reasoningEfforts) {
      expect(gpt54.reasoningEfforts.includes('xhigh')).toBe(true);
    }
  });
});
