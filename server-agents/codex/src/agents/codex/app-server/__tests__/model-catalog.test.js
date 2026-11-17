import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';
import { resolveCodexModelCatalogPath, withCodexModelCatalog } from '../model-catalog.ts';

describe('Codex fallback model catalog', () => {
  it.each([
    {
      slug: 'gpt-6.2-sol',
      defaultEffort: 'low',
      expectedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      serviceTierDescription: '2x speed, increased usage',
      contextWindow: 500_000,
      inputModalities: ['text', 'image', 'audio'],
    },
    {
      slug: 'gpt-6.2-astra',
      defaultEffort: 'low',
      expectedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      serviceTierDescription: '2x speed, increased usage',
      contextWindow: 272_000,
    },
    {
      slug: 'gpt-6.1-sol',
      defaultEffort: 'low',
      expectedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      serviceTierDescription: '2x speed, increased usage',
      contextWindow: 272_000,
    },
    {
      slug: 'gpt-6.1-terra',
      defaultEffort: 'low',
      expectedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      serviceTierDescription: '1.5x speed',
      contextWindow: 500_000,
    },
    {
      slug: 'gpt-6-sol',
      defaultEffort: 'medium',
      expectedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      serviceTierDescription: '1.5x speed',
      contextWindow: 272_000,
    },
    {
      slug: 'gpt-6-luna',
      defaultEffort: 'medium',
      expectedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      serviceTierDescription: '1.5x speed',
      contextWindow: 272_000,
    },
  ])('supplies verified native metadata for $slug', async ({
    slug,
    defaultEffort,
    expectedEfforts,
    serviceTierDescription,
    contextWindow,
    inputModalities = ['text', 'image'],
  }) => {
    const catalog = JSON.parse(await readFile(resolveCodexModelCatalogPath(), 'utf8'));
    const model = catalog.models.find((candidate) => candidate.slug === slug);

    expect(model).toMatchObject({
      slug,
      default_reasoning_level: defaultEffort,
      context_window: contextWindow,
      max_context_window: 872_000,
      input_modalities: inputModalities,
      service_tiers: [{ id: 'priority', name: 'Fast', description: serviceTierDescription }],
    });
    expect(model.supported_reasoning_levels.map(({ effort }) => effort)).toEqual(expectedEfforts);
  });

  it.each(['gpt-6.2-sol', 'gpt-6.2-astra'])('preserves %s native tools and Ultra metadata', async (slug) => {
    const catalog = JSON.parse(await readFile(resolveCodexModelCatalogPath(), 'utf8'));
    expect(catalog.models.find((model) => model.slug === slug)).toMatchObject({
      tool_mode: 'code_mode_only',
      multi_agent_version: 'v2',
      multi_agent_reasoning_effort: 'xhigh',
      use_responses_lite: true,
      supports_reasoning_effort_updates: true,
      node_repl_auto_review_required: true,
      model_messages: { instructions_template: expect.any(String) },
      experimental_supported_tools: expect.arrayContaining([
        'request_user_input_async', 'send_message_to_user_async', 'clock',
        'literature_search_query', 'multi_agent_v2_in_code_mode',
      ]),
    });
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
