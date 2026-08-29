import { describe, expect, it, mock } from 'bun:test';
import {
  AgentStartSelectionService,
  resultMessageForSelectionError,
} from '../agent-start-selection-service.ts';

const PARAMS = {
  ref: '69b623a7-757e-49f6-93b8-4b7ea1bc569b',
  agentId: 'codex',
  providerId: null,
  endpointId: null,
  model: 'gpt-5.4',
  reasoningEffort: null,
};

const EXECUTION_DEFAULTS = {
  global: {
    permissionMode: 'acceptEdits',
    thinkingMode: 'high',
    agentSettingsById: {
      codex: { ownerId: 'codex', schemaVersion: 1, values: { saved: true } },
    },
  },
  byAgent: {},
};

function agent(models, overrides = {}) {
  return {
    id: 'codex',
    label: 'Codex',
    kind: 'agent',
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
    supportedPermissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    supportedThinkingModes: ['none', 'high'],
    defaultSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
    requiresStrictModelDiscovery: false,
    defaultModel: 'gpt-5.4',
    models,
    ...overrides,
  };
}

function createFixture(overrides = {}) {
  const entry = overrides.entry ?? agent([{ value: 'gpt-5.4', label: 'GPT 5.4' }]);
  const agents = {
    getAgentCatalogEntry: mock(async () => entry),
    requiresStrictModelDiscovery: mock(() => false),
    ...overrides.agents,
  };
  const apiProviders = {
    getCatalog: mock(() => []),
    ...overrides.apiProviders,
  };
  return {
    service: new AgentStartSelectionService({ agents, apiProviders }),
    agents,
    apiProviders,
  };
}

describe('AgentStartSelectionService', () => {
  it('resolves a start selection from the requested agent and captured defaults', async () => {
    const fixture = createFixture();

    await expect(fixture.service.resolve(PARAMS, EXECUTION_DEFAULTS)).resolves.toEqual({
      ok: true,
      selection: {
        model: 'gpt-5.4',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
        permissionMode: 'acceptEdits',
        thinkingMode: 'high',
        agentSettings: { ownerId: 'codex', schemaVersion: 1, values: { saved: true } },
      },
    });
    expect(fixture.agents.getAgentCatalogEntry).toHaveBeenCalledWith('codex');
    expect(fixture.apiProviders.getCatalog).toHaveBeenCalledTimes(1);
  });

  it('repeats discovery strictly when the initial catalog requires it', async () => {
    const initial = agent([], { requiresStrictModelDiscovery: true });
    const strict = agent([{ value: 'gpt-5.4', label: 'GPT 5.4' }], {
      requiresStrictModelDiscovery: true,
    });
    const getAgentCatalogEntry = mock(async (_agentId, query) => query?.strict ? strict : initial);
    const fixture = createFixture({ agents: { getAgentCatalogEntry } });

    await expect(fixture.service.resolve(PARAMS, EXECUTION_DEFAULTS)).resolves.toMatchObject({ ok: true });
    expect(getAgentCatalogEntry.mock.calls).toEqual([
      ['codex'],
      ['codex', { strict: true }],
    ]);
  });

  it('maps semantic selection failures to fixed result tokens', async () => {
    const missing = createFixture({ agents: { getAgentCatalogEntry: mock(async () => null) } });
    await expect(missing.service.resolve(PARAMS, EXECUTION_DEFAULTS)).resolves.toEqual({
      ok: false,
      message: 'unknown-agent',
    });

    const unsupportedEffort = createFixture();
    await expect(unsupportedEffort.service.resolve({
      ...PARAMS,
      reasoningEffort: 'ultra',
    }, EXECUTION_DEFAULTS)).resolves.toEqual({
      ok: false,
      message: 'unsupported-reasoning-effort',
    });

    const bypass = createFixture();
    await expect(bypass.service.resolve(PARAMS, {
      ...EXECUTION_DEFAULTS,
      global: { ...EXECUTION_DEFAULTS.global, permissionMode: 'bypassPermissions' },
    })).resolves.toEqual({
      ok: false,
      message: 'permission-override-required',
    });
  });

  it('keeps every neutral selection code exhaustively mapped', () => {
    expect([
      'UNKNOWN_AGENT',
      'INVALID_CATALOG',
      'PROVIDER_NOT_SUPPORTED',
      'UNKNOWN_PROVIDER',
      'UNKNOWN_ENDPOINT',
      'INCOMPATIBLE_ENDPOINT',
      'AMBIGUOUS_MODEL',
      'UNKNOWN_MODEL',
      'UNSUPPORTED_PERMISSION_MODE',
      'UNSUPPORTED_REASONING_EFFORT',
      'PERMISSION_OVERRIDE_REQUIRED',
    ].map(resultMessageForSelectionError)).toEqual([
      'unknown-agent',
      'start-failed',
      'provider-not-supported',
      'unknown-provider',
      'unknown-endpoint',
      'incompatible-endpoint',
      'ambiguous-model',
      'unknown-model',
      'start-failed',
      'unsupported-reasoning-effort',
      'permission-override-required',
    ]);
  });
});
