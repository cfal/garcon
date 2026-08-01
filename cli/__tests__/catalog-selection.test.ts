import { describe, expect, test } from 'bun:test';
import type { AgentCatalogEntry } from '@garcon/common/agents';
import type { ApiProviderCatalogEntry } from '@garcon/common/api-providers';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import {
  resolveModelSelection,
  resolveStartSelection,
  validateExplicitModes,
} from '../catalog-selection.js';

function agent(overrides: Partial<AgentCatalogEntry> = {}): AgentCatalogEntry {
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

const provider: ApiProviderCatalogEntry = {
  id: 'acme',
  label: 'Acme',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
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

function catalog(entry = agent()): ModelCatalogResponse {
  return { catalog: { agents: [entry], apiProviders: [provider] } };
}

function settings(permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' = 'acceptEdits'): RemoteSettingsSnapshot {
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
  } as RemoteSettingsSnapshot;
}

describe('resolveModelSelection', () => {
  test('resolves an exact live catalog value to its routing tuple', () => {
    expect(resolveModelSelection(catalog(), 'codex', { model: 'east:qwen' })).toEqual({
      model: 'qwen',
      apiProviderId: 'acme',
      modelEndpointId: 'east',
      modelProtocol: 'openai-compatible',
    });
  });

  test('requires endpoint disambiguation for a repeated raw provider model', () => {
    expect(() => resolveModelSelection(catalog(), 'codex', {
      model: 'qwen',
      providerId: 'acme',
    })).toThrow('ambiguous');
    expect(resolveModelSelection(catalog(), 'codex', {
      model: 'qwen',
      providerId: 'acme',
      endpointId: 'west',
    }).modelEndpointId).toBe('west');
  });

  test('lists available catalog routing choices in selection errors', () => {
    expect(() => resolveModelSelection(catalog(), 'unknown', { model: 'gpt-5.4' })).toThrow(
      'available agents: codex',
    );
    expect(() => resolveModelSelection(catalog(), 'codex', {
      model: 'qwen',
      providerId: 'unknown',
    })).toThrow('available providers: acme');
    expect(() => resolveModelSelection(catalog(), 'codex', {
      model: 'qwen',
      providerId: 'acme',
      endpointId: 'unknown',
    })).toThrow('available endpoints: east, west');
  });

  test('allows an undiscovered native model only for non-strict agents', () => {
    expect(() => resolveModelSelection(catalog(), 'codex', { model: 'future' })).toThrow(
      'not available',
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

  test('rejects incomplete provider routing from a malformed catalog', () => {
    const malformed = agent({
      models: [{
        value: 'east:qwen',
        label: 'Qwen',
        rawModel: 'qwen',
        apiProviderId: 'acme',
        endpointId: 'east',
      }],
    });
    expect(() => resolveModelSelection(catalog(malformed), 'codex', {
      model: 'east:qwen',
    })).toThrow('routing');
  });

  test('rejects malformed model rows instead of falling through to native routing', () => {
    const malformed = agent({
      requiresStrictModelDiscovery: false,
      models: [{
        value: 'future',
        label: 'Future',
        protocol: 'invalid',
      } as unknown as AgentCatalogEntry['models'][number]],
    });

    expect(() => resolveModelSelection(catalog(malformed), 'codex', { model: 'future' }))
      .toThrow('model catalog for codex is invalid');
  });

  test('rejects routed models that disagree with their provider endpoint', () => {
    const malformed = agent({
      models: [{
        value: 'east:qwen',
        label: 'Qwen',
        rawModel: 'qwen',
        apiProviderId: 'acme',
        endpointId: 'east',
        protocol: 'anthropic-messages',
      }],
    });

    expect(() => resolveModelSelection(catalog(malformed), 'codex', { model: 'east:qwen' }))
      .toThrow('incompatible');
  });
});

describe('execution selection', () => {
  test('uses write-capable Garcon defaults and saved agent settings', () => {
    const resolved = resolveStartSelection(catalog(), settings(), {
      agentId: 'codex',
      model: 'gpt-5.4',
    });
    expect(resolved.permissionMode).toBe('acceptEdits');
    expect(resolved.thinkingMode).toBe('high');
    expect(resolved.agentSettings.values).toEqual({ source: 'saved' });
  });

  test('requires inherited bypass permission to be explicit', () => {
    expect(() => resolveStartSelection(catalog(), settings('bypassPermissions'), {
      agentId: 'codex',
      model: 'gpt-5.4',
    })).toThrow('requires explicit');
    expect(resolveStartSelection(catalog(), settings('bypassPermissions'), {
      agentId: 'codex',
      model: 'gpt-5.4',
      permissionMode: 'bypassPermissions',
    }).permissionMode).toBe('bypassPermissions');
  });

  test('rejects explicit modes outside the live agent capability', () => {
    expect(() => validateExplicitModes(catalog(), 'codex', { thinkingMode: 'ultra' })).toThrow(
      'not supported',
    );
  });
});
