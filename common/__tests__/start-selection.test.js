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
