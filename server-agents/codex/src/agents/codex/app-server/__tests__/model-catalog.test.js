import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';
import { resolveCodexModelCatalogPath, withCodexModelCatalog } from '../model-catalog.ts';

describe('Codex fallback model catalog', () => {
  it.each([
    ['gpt-6.1-sol', 'low', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], '2x speed, increased usage', 272_000],
    ['gpt-6.1-terra', 'low', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], '1.5x speed', 500_000],
    ['gpt-6-sol', 'medium', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], '1.5x speed', 272_000],
    ['gpt-6-luna', 'medium', ['low', 'medium', 'high', 'xhigh', 'max'], '1.5x speed', 272_000],
  ])('supplies verified native metadata for %s', async (
    slug,
    defaultEffort,
    expectedEfforts,
    serviceTierDescription,
    contextWindow,
  ) => {
    const catalog = JSON.parse(await readFile(resolveCodexModelCatalogPath(), 'utf8'));
    const model = catalog.models.find((candidate) => candidate.slug === slug);

    expect(model).toMatchObject({
      slug,
      default_reasoning_level: defaultEffort,
      context_window: contextWindow,
      max_context_window: 872_000,
      input_modalities: ['text', 'image'],
      service_tiers: [{ id: 'priority', name: 'Fast', description: serviceTierDescription }],
    });
    expect(model.supported_reasoning_levels.map(({ effort }) => effort)).toEqual(expectedEfforts);
  });

  it('preserves Terra native tool and delegation metadata', async () => {
    const catalog = JSON.parse(await readFile(resolveCodexModelCatalogPath(), 'utf8'));
    expect(catalog.models.find(({ slug }) => slug === 'gpt-6.1-terra')).toMatchObject({
      display_name: 'GPT-6.1 Terra',
      tool_mode: 'code_mode_only',
      multi_agent_version: 'v2',
      multi_agent_reasoning_effort: 'xhigh',
      use_responses_lite: true,
      supports_reasoning_effort_updates: true,
    });
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
