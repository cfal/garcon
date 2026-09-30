import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';
import { resolveCodexModelCatalogPath, withCodexModelCatalog } from '../model-catalog.ts';

describe('Codex fallback model catalog', () => {
  it.each([
    ['gpt-6.1-sol', 'low', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], '2x speed, increased usage'],
    ['gpt-6-sol', 'medium', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], '1.5x speed'],
    ['gpt-6-luna', 'medium', ['low', 'medium', 'high', 'xhigh', 'max'], '1.5x speed'],
  ])('supplies verified native metadata for %s', async (
    slug,
    defaultEffort,
    expectedEfforts,
    serviceTierDescription,
  ) => {
    const catalog = JSON.parse(await readFile(resolveCodexModelCatalogPath(), 'utf8'));
    const model = catalog.models.find((candidate) => candidate.slug === slug);

    expect(model).toMatchObject({
      slug,
      default_reasoning_level: defaultEffort,
      context_window: 272_000,
      max_context_window: 872_000,
      input_modalities: ['text', 'image'],
      service_tiers: [{ id: 'priority', name: 'Fast', description: serviceTierDescription }],
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
