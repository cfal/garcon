import { describe, expect, test } from 'bun:test';
import {
  StartSelectionError,
  resolveModelSelection,
  resolveStartSelection,
} from '../start-selection.ts';

const provider = {
  id: 'acme',
  label: 'Acme',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  endpoints: [
    {
      id: 'east',
      protocol: 'openai-compatible',
      baseUrl: 'http://localhost:9001',
      defaultModel: 'qwen',
      models: [{ value: 'qwen', label: 'Qwen' }],
      supportsImages: false,
      hasApiKey: true,
    },
    {
      id: 'west',
      protocol: 'openai-compatible',
      baseUrl: 'http://localhost:9002',
      defaultModel: 'qwen',
      models: [{ value: 'qwen', label: 'Qwen' }],
      supportsImages: false,
      hasApiKey: true,
    },
  ],
};

function agent(overrides = {}) {
  return {
    id: 'codex',
    label: 'Codex',
    kind: 'agent',
    supportsFork: true,
    supportsForkAtMessage: true,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
    authLoginSupported: true,
    supportedPermissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    supportedThinkingModes: ['none', 'high', 'xhigh'],
    settings: [],
    defaultSettings: { ownerId: 'codex', schemaVersion: 1, values: { source: 'default' } },
    requiresStrictModelDiscovery: true,
    generation: null,
    defaultModel: 'gpt-5.4',
    models: [
      { value: 'gpt-5.4', label: 'GPT 5.4' },
      {
        value: 'east:qwen',
        label: 'Acme: Qwen',
        rawModel: 'qwen',
        apiProviderId: 'acme',
        endpointId: 'east',
        protocol: 'openai-compatible',
      },
      {
        value: 'west:qwen',
        label: 'Acme: Qwen',
        rawModel: 'qwen',
        apiProviderId: 'acme',
        endpointId: 'west',
        protocol: 'openai-compatible',
      },
    ],
    ...overrides,
  };
}

function catalog(entry = agent()) {
  return { catalog: { agents: [entry], apiProviders: [provider] } };
}

function settings(permissionMode = 'acceptEdits') {
  return {
    executionDefaults: {
      global: {
        permissionMode,
        thinkingMode: 'high',
        agentSettingsById: {
          codex: { ownerId: 'codex', schemaVersion: 1, values: { source: 'saved' } },
        },
      },
      byAgent: {},
    },
  };
}

function expectCode(operation, code) {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(StartSelectionError);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('shared start selection', () => {
  test('resolves exact provider names to canonical routes without mutating the request', () => {
    const namedCatalog = catalog();
    namedCatalog.catalog.apiProviders = [{ ...provider, label: 'Example Proxy & Co' }];
    for (const model of ['qwen', 'west:qwen']) {
      const requested = Object.freeze({ agentId: 'codex', model, providerId: 'Example Proxy & Co', endpointId: 'west' });
      expect(resolveStartSelection(namedCatalog, settings(), requested)).toMatchObject({
        model: 'qwen', apiProviderId: 'acme', modelEndpointId: 'west', modelProtocol: 'openai-compatible',
      });
      expect(requested.providerId).toBe('Example Proxy & Co');
    }
  });

  test('prefers an exact provider ID over matching names', () => {
    const collision = catalog();
    collision.catalog.apiProviders = [
      { ...provider, id: 'other', label: 'acme' }, provider, { ...provider, id: 'third', label: 'acme' },
    ];
    expect(resolveModelSelection(collision, 'codex', {
      model: 'west:qwen', providerId: 'acme',
    }).apiProviderId).toBe('acme');
  });

  test('rejects duplicate names before endpoint or model filtering', () => {
    const duplicate = catalog();
    duplicate.catalog.apiProviders.push({ ...provider, id: 'other', endpoints: [] });
    for (const requested of [
      { model: 'qwen' }, { model: 'west:qwen' }, { model: 'qwen', endpointId: 'west' },
    ]) expectCode(() => resolveModelSelection(duplicate, 'codex', {
      ...requested, providerId: 'Acme',
    }), 'AMBIGUOUS_PROVIDER');
    expect(resolveModelSelection(duplicate, 'codex', {
      model: 'west:qwen', providerId: 'acme',
    }).apiProviderId).toBe('acme');
  });

  test('requires exact names and preserves model and endpoint validation', () => {
    const nonStrict = catalog(agent({ requiresStrictModelDiscovery: false }));
    for (const providerId of ['ACME', ' Acme ', 'missing']) {
      expectCode(() => resolveModelSelection(nonStrict, 'codex', { model: 'future', providerId }), 'UNKNOWN_PROVIDER');
    }
    for (const [requested, code] of [
      [{ model: 'future' }, 'UNKNOWN_MODEL'],
      [{ model: 'gpt-5.4' }, 'UNKNOWN_MODEL'],
      [{ model: 'qwen' }, 'AMBIGUOUS_MODEL'],
      [{ model: 'west:qwen', endpointId: 'east' }, 'UNKNOWN_MODEL'],
      [{ model: 'qwen', endpointId: 'missing' }, 'UNKNOWN_ENDPOINT'],
    ]) expectCode(() => resolveModelSelection(nonStrict, 'codex', { ...requested, providerId: 'Acme' }), code);
    expectCode(() => resolveModelSelection(catalog(agent({ acceptsApiProviderEndpoints: false })), 'codex', {
      model: 'west:qwen', providerId: 'Acme',
    }), 'PROVIDER_NOT_SUPPORTED');
  });

  test('resolves provider names before checking agent endpoint support', () => {
    const unsupported = catalog(agent({ acceptsApiProviderEndpoints: false }));
    unsupported.catalog.apiProviders.push({ ...provider, id: 'other', endpoints: [] });
    for (const [providerId, code] of [
      ['Acme', 'AMBIGUOUS_PROVIDER'], ['missing', 'UNKNOWN_PROVIDER'], ['acme', 'PROVIDER_NOT_SUPPORTED'],
    ]) expectCode(() => resolveModelSelection(unsupported, 'codex', { model: 'gpt-5.4', providerId }), code);
  });

  test('resolves raw routed models and captured execution defaults', () => {
    expect(resolveStartSelection(catalog(), settings(), {
      agentId: 'codex',
      model: 'qwen',
      providerId: 'acme',
      endpointId: 'west',
    })).toEqual({
      model: 'qwen',
      apiProviderId: 'acme',
      modelEndpointId: 'west',
      modelProtocol: 'openai-compatible',
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      agentSettings: { ownerId: 'codex', schemaVersion: 1, values: { source: 'saved' } },
    });
  });

  test('allows undiscovered native models only for non-strict agents', () => {
    expectCode(
      () => resolveModelSelection(catalog(), 'codex', { model: 'future' }),
      'UNKNOWN_MODEL',
    );
    expect(resolveModelSelection(catalog(agent({ requiresStrictModelDiscovery: false })), 'codex', {
      model: 'future',
    })).toEqual({
      model: 'future',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
    });
  });

  test('returns stable semantic codes for unavailable selections', () => {
    expectCode(
      () => resolveModelSelection(catalog(), 'missing', { model: 'gpt-5.4' }),
      'UNKNOWN_AGENT',
    );
    expectCode(
      () => resolveModelSelection(catalog(), 'codex', { model: 'qwen', providerId: 'missing' }),
      'UNKNOWN_PROVIDER',
    );
    expectCode(
      () => resolveModelSelection(catalog(), 'codex', {
        model: 'qwen',
        providerId: 'acme',
        endpointId: 'missing',
      }),
      'UNKNOWN_ENDPOINT',
    );
    expectCode(
      () => resolveModelSelection(catalog(), 'codex', { model: 'qwen', providerId: 'acme' }),
      'AMBIGUOUS_MODEL',
    );
    expectCode(
      () => resolveStartSelection(catalog(), settings(), {
        agentId: 'codex',
        model: 'gpt-5.4',
        thinkingMode: 'ultra',
      }),
      'UNSUPPORTED_REASONING_EFFORT',
    );
  });

  test('uses the neutral value for agents without reasoning mode support', () => {
    const amp = agent({
      id: 'amp',
      supportedThinkingModes: [],
      defaultSettings: { ownerId: 'amp', schemaVersion: 1, values: {} },
    });

    expect(resolveStartSelection(catalog(amp), settings(), {
      agentId: 'amp',
      model: 'gpt-5.4',
      thinkingMode: 'none',
    }).thinkingMode).toBe('none');
    expectCode(
      () => resolveStartSelection(catalog(amp), settings(), {
        agentId: 'amp',
        model: 'gpt-5.4',
        thinkingMode: 'high',
      }),
      'UNSUPPORTED_REASONING_EFFORT',
    );
  });

  test('requires inherited bypass permission to be explicit', () => {
    expectCode(
      () => resolveStartSelection(catalog(), settings('bypassPermissions'), {
        agentId: 'codex',
        model: 'gpt-5.4',
      }),
      'PERMISSION_OVERRIDE_REQUIRED',
    );
    expect(resolveStartSelection(catalog(), settings('bypassPermissions'), {
      agentId: 'codex',
      model: 'gpt-5.4',
      permissionMode: 'bypassPermissions',
    }).permissionMode).toBe('bypassPermissions');
  });

  test('classifies malformed catalog data separately from user selections', () => {
    expectCode(
      () => resolveModelSelection(catalog(agent({ models: [{ value: 'broken', label: 'Broken', protocol: 'bad' }] })), 'codex', {
        model: 'broken',
      }),
      'INVALID_CATALOG',
    );
  });
});
