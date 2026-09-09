import { describe, expect, test } from 'bun:test';
import { AgentStartSelectionService } from '../agent-start-selection-service.js';
import { StartSelectionError } from '../../../common/start-selection.js';

function fixture() {
  const envelope = (source) => ({ ownerId: 'test', schemaVersion: 1, values: { nested: { source } } });
  const entry = {
    id: 'test', models: [
      { value: 'first', label: 'First' }, { value: 'second', label: 'Second' },
      ...['east', 'west'].flatMap((endpointId) => ['first', 'second'].map((rawModel) => ({
        value: `${endpointId}:${rawModel}`, label: rawModel, rawModel,
        apiProviderId: 'provider', endpointId, protocol: 'openai-compatible',
      }))),
    ],
    defaultModel: 'first', supportedPermissionModes: ['default', 'bypassPermissions'],
    supportedThinkingModes: ['none', 'high'], supportedProtocols: ['openai-compatible'],
    acceptsApiProviderEndpoints: true, requiresStrictModelDiscovery: false,
    defaultSettings: envelope('integration'),
  };
  const catalog = { catalog: { agents: [entry], apiProviders: [{
    id: 'provider', label: 'Example Proxy', endpoints: [
      { id: 'east', protocol: 'openai-compatible' }, { id: 'west', protocol: 'openai-compatible' },
    ],
  }] } };
  const parent = {
    agentId: 'test', model: 'first', apiProviderId: 'provider', modelEndpointId: 'west',
    modelProtocol: 'openai-compatible', permissionMode: 'bypassPermissions', thinkingMode: 'none',
    agentSettingsById: { test: envelope('parent') },
  };
  const defaults = {
    global: { permissionMode: 'default', thinkingMode: 'high', agentSettingsById: { test: envelope('global') } },
    byAgent: { test: { agentSettingsById: { test: envelope('target') } } },
  };
  const command = {
    type: 'start-agent', agentId: null, providerId: null, model: null, reasoningEffort: null,
    ref: 'task', async: true, fork: false, title: null, prompt: 'Synthetic task',
  };
  const service = new AgentStartSelectionService({
    agents: { getAgentCatalogEntry: async () => entry }, apiProviders: { getCatalog: () => catalog.catalog.apiProviders },
  });
  return { entry, catalog, parent, defaults, command,
    resolve: (overrides = {}) => service.resolve(catalog, { ...command, ...overrides }, defaults, parent) };
}

function expectCode(operation, code) {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(StartSelectionError);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('delegated start selection', () => {
  test.each([
    [{}, 'first', 'provider', 'west', 'none', 'parent'],
    [{ model: 'second' }, 'second', 'provider', 'west', 'none', 'parent'],
    [{ providerId: 'Example Proxy', model: 'east:second' }, 'second', 'provider', 'east', 'none', 'parent'],
    [{ agentId: 'test', providerId: 'Example Proxy', model: 'east:second' }, 'second', 'provider', 'east', 'high', 'target'],
    [{ agentId: 'test', model: 'second' }, 'second', null, null, 'high', 'target'],
  ])('resolves attribute presence %j', (command, model, apiProviderId, modelEndpointId, thinkingMode, source) => {
    const f = fixture();
    const selected = f.resolve(command);
    expect(selected).toEqual({
      agentId: 'test', model, apiProviderId, modelEndpointId,
      modelProtocol: apiProviderId === null ? null : 'openai-compatible',
      permissionMode: 'bypassPermissions', thinkingMode,
      agentSettings: { ownerId: 'test', schemaVersion: 1, values: { nested: { source } } },
    });
    selected.agentSettings.values.nested.source = 'mutated';
    expect(f.parent.agentSettingsById.test.values.nested.source).toBe('parent');
    expect(f.defaults.byAgent.test.agentSettingsById.test.values.nested.source).toBe('target');
  });

  test('normalizes absent native routing fields without choosing a configured route', () => {
    const f = fixture();
    delete f.parent.apiProviderId; delete f.parent.modelEndpointId; delete f.parent.modelProtocol;
    for (const command of [{}, { model: 'second' }]) {
      expect(f.resolve(command)).toMatchObject({ apiProviderId: null, modelEndpointId: null, modelProtocol: null });
    }
    f.parent.model = 'unlisted';
    expectCode(() => f.resolve(), 'UNKNOWN_MODEL');
  });

  test('uses the explicit agent rather than the parent for native selection and defaults', () => {
    const f = fixture();
    f.parent.agentId = 'other';
    expect(f.resolve({ agentId: 'test', model: 'second' })).toMatchObject({
      agentId: 'test', apiProviderId: null, thinkingMode: 'high',
    });
    expectCode(() => f.resolve(), 'UNKNOWN_AGENT');
  });

  test('rejects unknown native models and endpoint-only agents before admission', () => {
    const f = fixture();
    for (const model of ['unlisted', 'east:first']) {
      expectCode(() => f.resolve({ agentId: 'test', model }), 'UNKNOWN_MODEL');
    }
    f.entry.models = f.entry.models.filter((model) => model.apiProviderId);
    expectCode(() => f.resolve({ agentId: 'test', model: 'first' }), 'UNKNOWN_MODEL');
  });

  test('never borrows the parent endpoint for an explicit provider', () => {
    const f = fixture();
    expectCode(() => f.resolve({ providerId: 'provider', model: 'second' }), 'AMBIGUOUS_MODEL');
    expectCode(() => f.resolve({ model: 'east:second' }), 'UNKNOWN_MODEL');
  });

  test('rejects incomplete or changed inherited routes', () => {
    for (const field of ['apiProviderId', 'modelEndpointId', 'modelProtocol']) {
      const f = fixture(); f.parent[field] = null;
      expectCode(() => f.resolve(), 'INCOMPATIBLE_ENDPOINT');
    }
    const f = fixture(); f.parent.modelProtocol = 'anthropic-messages';
    expectCode(() => f.resolve(), 'INCOMPATIBLE_ENDPOINT');
    f.parent.modelProtocol = 'openai-compatible'; f.parent.modelEndpointId = 'removed';
    expectCode(() => f.resolve(), 'UNKNOWN_ENDPOINT');
  });

  test('does not resolve a removed inherited provider ID through another provider name', () => {
    const f = fixture();
    f.catalog.catalog.apiProviders[0].id = 'replacement';
    f.catalog.catalog.apiProviders[0].label = 'provider';
    expectCode(() => f.resolve(), 'UNKNOWN_PROVIDER');
  });

  test('does not reinterpret an inherited canonical model as a catalog alias', () => {
    const f = fixture(); f.parent.model = 'west:first';
    expectCode(() => f.resolve(), 'INCOMPATIBLE_ENDPOINT');
  });

  test('inherits active settings with integration fallback and honors reasoning overrides', () => {
    const f = fixture();
    expect(f.resolve({ reasoningEffort: 'high' }).thinkingMode).toBe('high');
    expect(f.resolve({ agentId: 'test', model: 'first', reasoningEffort: 'none' }).thinkingMode).toBe('none');
    expectCode(() => f.resolve({ reasoningEffort: 'invalid' }), 'UNSUPPORTED_REASONING_EFFORT');
    f.parent.thinkingMode = 'unsupported';
    expectCode(() => f.resolve(), 'UNSUPPORTED_REASONING_EFFORT');
    f.parent.thinkingMode = 'none';
    delete f.parent.agentSettingsById.test;
    expect(f.resolve().agentSettings).toEqual(f.entry.defaultSettings);
    f.parent.agentSettingsById.test = { ownerId: 'other', schemaVersion: 1, values: {} };
    expect(f.resolve().agentSettings).toEqual(f.entry.defaultSettings);
  });

  test('leaves omitted command values untouched', () => {
    const f = fixture();
    Object.freeze(f.command); f.resolve();
    expect(f.command).toMatchObject({ agentId: null, providerId: null, model: null });
  });
});
