import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';
import { resolveCodexModelCatalogPath, withCodexModelCatalog } from '../model-catalog.ts';

describe('Codex fallback model catalog', () => {
  it.each([
    ['gpt-6-sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
    ['gpt-6-luna', ['low', 'medium', 'high', 'xhigh', 'max']],
  ])('supplies verified native metadata for %s', async (slug, expectedEfforts) => {
    const catalog = JSON.parse(await readFile(resolveCodexModelCatalogPath(), 'utf8'));
    const model = catalog.models.find((candidate) => candidate.slug === slug);

    expect(model).toMatchObject({
      slug,
      default_reasoning_level: 'medium',
      context_window: 272_000,
      max_context_window: 872_000,
      input_modalities: ['text', 'image'],
      service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
    });
    expect(model.supported_reasoning_levels.map(({ effort }) => effort)).toEqual(expectedEfforts);
  });

  it('preserves an explicitly configured catalog', () => {
    expect(withCodexModelCatalog({
      config: {},
      modelCatalogPath: '/custom/models.json',
    })).toEqual({
      config: {},
      modelCatalogPath: '/custom/models.json',
    });
  });
});
