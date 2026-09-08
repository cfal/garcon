import { describe, expect, test } from 'bun:test';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { PreamblesSnapshot } from '@garcon/common/preambles';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import type { ListCliCommand } from '../args.js';
import { runCatalogQuery, type CatalogQueryClient } from '../catalog-query.js';
import type { CliOutput } from '../output.js';

const catalog: ModelCatalogResponse = {
  catalog: {
    agents: [{
      id: 'codex',
      label: 'Codex',
      description: 'OpenAI Codex',
      kind: 'agent',
      supportsFork: true,
      supportsForkAtMessage: true,
      supportsForkWhileRunning: false,
      supportsUpdateProjectPath: true,
      supportsSteering: true,
      supportsGoals: true,
      supportsImages: true,
      acceptsApiProviderEndpoints: true,
      supportedProtocols: ['openai-compatible'],
      authLoginSupported: true,
      supportedPermissionModes: ['default', 'acceptEdits', 'plan'],
      supportedThinkingModes: ['none', 'medium', 'high'],
      settings: [],
      defaultSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
      requiresStrictModelDiscovery: true,
      generation: null,
      defaultModel: 'gpt-5.4',
      models: [
        { value: 'gpt-5.4', label: 'GPT 5.4' },
        {
          value: 'acme:east:qwen',
          label: 'Qwen',
          rawModel: 'qwen',
          apiProviderId: 'acme',
          endpointId: 'east',
          protocol: 'openai-compatible',
        },
      ],
    }],
    apiProviders: [
      {
        id: 'acme',
        label: 'Acme',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        endpoints: [
          {
            id: 'east',
            protocol: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:9000',
            defaultModel: 'qwen',
            models: [{ value: 'qwen', label: 'Qwen' }],
            supportsImages: false,
            hasApiKey: true,
          },
          {
            id: 'anthropic',
            protocol: 'anthropic-messages',
            baseUrl: 'http://127.0.0.1:9001',
            defaultModel: 'sonnet',
            models: [{ value: 'sonnet', label: 'Sonnet' }],
            supportsImages: true,
            hasApiKey: true,
          },
        ],
      },
    ],
  },
};

const settings = {
  executionDefaults: {
    global: { permissionMode: 'acceptEdits', thinkingMode: 'medium', agentSettingsById: {} },
    byAgent: {},
  },
} as RemoteSettingsSnapshot;

const preambles: PreamblesSnapshot = {
  revision: 3,
  preambles: [{
    id: '3502b645-222b-49d2-ac39-1c91f9fb1174',
    enabled: true,
    title: 'Repository guidance',
    content: 'Follow the repository guidance.',
    scope: {
      type: 'project-paths',
      rules: [{ projectPath: '/repo', includeNested: true }],
    },
    agentIds: [],
    tagFilter: { mode: 'all', tags: [] },
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
  }],
};

function client(modelCatalog: ModelCatalogResponse = catalog): CatalogQueryClient {
  return {
    async getModelCatalog() { return modelCatalog; },
    async getPreambles() { return preambles; },
    async getSettings() { return settings; },
  };
}

function output(): CliOutput & { listings: string[] } {
  return {
    listings: [],
    accepted() {},
    completed() {},
    result(content) { this.listings.push(content); },
    sent() {},
    stopped() {},
    diagnostic() {},
  };
}

function command(
  resource: ListCliCommand['resource'],
  options: Partial<ListCliCommand> = {},
): ListCliCommand {
  return {
    kind: 'list',
    resource,
    workspace: 'default',
    configDir: '/config',
    json: false,
    ...options,
  };
}

describe('runCatalogQuery', () => {
  test('lists preamble IDs directly without loading the model catalog', async () => {
    let modelCatalogRequested = false;
    const queryClient = client();
    queryClient.getModelCatalog = async () => {
      modelCatalogRequested = true;
      return catalog;
    };
    const plain = output();
    await runCatalogQuery(command('preambles'), queryClient, plain);
    expect(plain.listings[0]).toContain('ID                                    TITLE                ENABLED  SCOPE');
    expect(plain.listings[0]).toContain(
      '3502b645-222b-49d2-ac39-1c91f9fb1174  Repository guidance  yes      /repo/**',
    );

    const json = output();
    await runCatalogQuery(command('preambles', { json: true }), queryClient, json);
    expect(JSON.parse(json.listings[0]!)).toEqual(preambles);
    expect(modelCatalogRequested).toBe(false);
  });

  test('provider names and IDs produce identical canonical catalog listings', async () => {
    for (const resource of ['providers', 'endpoints', 'models'] as const) {
      const byId = output();
      const byName = output();
      const options = { agentId: 'codex', endpointId: 'east', json: true };
      await runCatalogQuery(command(resource, { ...options, providerId: 'acme' }), client(), byId);
      await runCatalogQuery(command(resource, { ...options, providerId: 'Acme' }), client(), byName);
      expect(byName.listings).toEqual(byId.listings);
      expect(JSON.parse(byName.listings[0]!)[resource]).toHaveLength(1);
    }
  });

  test('rejects duplicate names even when agent, endpoint and model filters could disambiguate', async () => {
    const duplicate = structuredClone(catalog);
    duplicate.catalog.apiProviders.push({ ...duplicate.catalog.apiProviders[0]!, id: 'other', endpoints: [] });
    for (const resource of ['providers', 'endpoints', 'models'] as const) {
      await expect(runCatalogQuery(command(resource, {
        agentId: 'codex', providerId: 'Acme', endpointId: 'east',
      }), client(duplicate), output())).rejects.toMatchObject({
        exitCode: 2, message: expect.stringContaining('ambiguous'),
      });
    }
  });

  test('resolves model-list provider names before checking agent endpoint support', async () => {
    const unsupported = structuredClone(catalog);
    unsupported.catalog.agents[0]!.acceptsApiProviderEndpoints = false;
    unsupported.catalog.apiProviders.push({ ...unsupported.catalog.apiProviders[0]!, id: 'other', endpoints: [] });
    for (const [providerId, message] of [
      ['Acme', 'ambiguous'], ['missing', 'unknown API provider'], ['acme', 'does not accept API provider endpoints'],
    ] as const) await expect(runCatalogQuery(command('models', {
      agentId: 'codex', providerId,
    }), client(unsupported), output())).rejects.toThrow(message);
  });

  test('prints actionable agent and model selections', async () => {
    const agents = output();
    await runCatalogQuery(command('agents'), client(), agents);
    expect(agents.listings[0]).toContain('AGENT  LABEL  DEFAULT MODEL');
    expect(agents.listings[0]).toContain('codex  Codex  gpt-5.4');

    const models = output();
    await runCatalogQuery(command('models', {
      agentId: 'codex',
      providerId: 'acme',
      endpointId: 'east',
      json: true,
    }), client(), models);
    expect(JSON.parse(models.listings[0]!)).toEqual({
      agentId: 'codex',
      defaultModel: 'gpt-5.4',
      models: [{
        value: 'acme:east:qwen',
        label: 'Qwen',
        rawModel: 'qwen',
        providerId: 'acme',
        endpointId: 'east',
        protocol: 'openai-compatible',
        isDefault: false,
        supportsImages: true,
        isLocal: false,
      }],
    });
  });

  test('filters provider endpoints to the selected agent protocol', async () => {
    const providers = output();
    await runCatalogQuery(command('providers', { agentId: 'codex', json: true }), client(), providers);
    expect(JSON.parse(providers.listings[0]!)).toEqual({
      agentId: 'codex',
      providers: [{ id: 'acme', label: 'Acme', endpoints: ['east'] }],
    });

    const endpoints = output();
    await runCatalogQuery(command('endpoints', {
      agentId: 'codex',
      providerId: 'acme',
      json: true,
    }), client(), endpoints);
    expect(JSON.parse(endpoints.listings[0]!).endpoints).toEqual([{
      providerId: 'acme',
      id: 'east',
      protocol: 'openai-compatible',
      defaultModel: 'qwen',
      supportsImages: false,
      hasApiKey: true,
    }]);
  });

  test('marks effective permission and reasoning defaults', async () => {
    const permissions = output();
    await runCatalogQuery(command('permissions', { agentId: 'codex', json: true }), client(), permissions);
    expect(JSON.parse(permissions.listings[0]!)).toEqual({
      agentId: 'codex',
      defaultPermission: 'acceptEdits',
      permissions: ['default', 'acceptEdits', 'plan'],
    });

    const efforts = output();
    await runCatalogQuery(command('reasoning-efforts', { agentId: 'codex' }), client(), efforts);
    expect(efforts.listings[0]).toContain('medium            yes');
  });

  test('reports unknown provider filters with available values', async () => {
    await expect(runCatalogQuery(command('models', {
      agentId: 'codex',
      providerId: 'missing',
    }), client(), output())).rejects.toThrow('available providers: acme');
  });

  test('rejects an explicitly selected endpoint that the agent cannot use', async () => {
    await expect(runCatalogQuery(command('endpoints', {
      agentId: 'codex',
      providerId: 'acme',
      endpointId: 'anthropic',
    }), client(), output())).rejects.toThrow(
      'endpoint anthropic is not compatible with agent codex',
    );
  });

  test('rejects an explicitly selected provider with no compatible endpoints', async () => {
    const incompatibleCatalog = structuredClone(catalog);
    incompatibleCatalog.catalog.apiProviders.push({
      id: 'anthropic-only',
      label: 'Anthropic only',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      endpoints: [{
        id: 'messages',
        protocol: 'anthropic-messages',
        baseUrl: 'http://127.0.0.1:9002',
        defaultModel: 'sonnet',
        models: [{ value: 'sonnet', label: 'Sonnet' }],
        supportsImages: true,
        hasApiKey: true,
      }],
    });

    for (const resource of ['providers', 'endpoints'] as const) {
      await expect(runCatalogQuery(command(resource, {
        agentId: 'codex',
        providerId: 'anthropic-only',
      }), client(incompatibleCatalog), output())).rejects.toThrow(
        'provider anthropic-only has no endpoints compatible with agent codex',
      );
    }
  });

  test('only strict model listings use the agent-scoped catalog route', async () => {
    const requestedAgents: Array<string | undefined> = [];
    const queryClient: CatalogQueryClient = {
      async getModelCatalog(agentId) {
        requestedAgents.push(agentId);
        return catalog;
      },
      async getPreambles() { return preambles; },
      async getSettings() { return settings; },
    };

    await runCatalogQuery(command('permissions', { agentId: 'codex' }), queryClient, output());
    await runCatalogQuery(command('reasoning-efforts', { agentId: 'codex' }), queryClient, output());
    await runCatalogQuery(command('models', { agentId: 'codex' }), queryClient, output());

    expect(requestedAgents).toEqual([undefined, undefined, 'codex']);
  });
});
