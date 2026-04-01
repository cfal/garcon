import { describe, expect, it } from 'bun:test';

import { getFactoryModelCatalog } from '../factory-models.js';

describe('factory model discovery', () => {
  it('parses the installed droid help output into model metadata', async () => {
    const catalog = await getFactoryModelCatalog(true);

    expect(catalog.defaultModel).toBe('claude-opus-4-6');
    expect(catalog.options.find((entry) => entry.value === 'claude-opus-4-6')).toBeTruthy();
    expect(catalog.metadata['claude-opus-4-6']?.supportsImages).toBe(true);
    expect(catalog.metadata['glm-5']?.supportsImages).toBe(false);
    expect(catalog.metadata['gpt-5.4']?.reasoningEfforts?.includes('xhigh')).toBe(true);
  });
});
