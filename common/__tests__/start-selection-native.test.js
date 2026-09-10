import { describe, expect, test } from 'bun:test';
import { resolveModelSelection, StartSelectionError } from '../start-selection.js';

const native = { value: 'native-model', label: 'Native model', rawModel: 'shared-model' };
const routed = {
  value: 'endpoint:shared-model', label: 'Routed model', rawModel: 'shared-model',
  apiProviderId: 'provider', endpointId: 'endpoint', protocol: 'openai-compatible',
};

function catalog(models = [native, routed]) {
  return { catalog: {
    agents: [{
      id: 'test', models, defaultModel: 'native-model',
      supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
      supportedProtocols: ['openai-compatible'], acceptsApiProviderEndpoints: true,
      requiresStrictModelDiscovery: false,
      defaultSettings: { ownerId: 'test', schemaVersion: 1, values: {} },
    }],
    apiProviders: [{ id: 'provider', label: 'Example Proxy', endpoints: [
      { id: 'endpoint', protocol: 'openai-compatible' },
    ] }],
  } };
}

function expectCode(operation, code) {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(StartSelectionError);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('native-only model selection', () => {
  test('pins native routing instead of searching configured endpoints', () => {
    expect(resolveModelSelection(catalog(), 'test', { model: 'shared-model', providerId: null })).toEqual({
      model: 'shared-model', apiProviderId: null, modelEndpointId: null, modelProtocol: null,
    });
    expectCode(() => resolveModelSelection(catalog(), 'test', { model: 'shared-model' }), 'AMBIGUOUS_MODEL');
    expect(resolveModelSelection(catalog(), 'test', {
      model: 'shared-model', providerId: 'Example Proxy',
    }).apiProviderId).toBe('provider');
  });

  test('requires known native models even when discovery is non-strict', () => {
    for (const models of [[native, routed], [routed], []]) {
      for (const model of ['future-model', routed.value]) {
        expectCode(() => resolveModelSelection(catalog(models), 'test', { model, providerId: null }), 'UNKNOWN_MODEL');
      }
    }
    expect(resolveModelSelection(catalog(), 'test', { model: 'future-model' })).toEqual({
      model: 'future-model', apiProviderId: null, modelEndpointId: null, modelProtocol: null,
    });
  });

  test('rejects native requests with endpoints and malformed native model routing', () => {
    expectCode(() => resolveModelSelection(catalog(), 'test', {
      model: native.value, providerId: null, endpointId: 'endpoint',
    }), 'INCOMPATIBLE_ENDPOINT');
    for (const metadata of [{ endpointId: 'endpoint' }, { protocol: 'openai-compatible' }]) {
      expectCode(() => resolveModelSelection(catalog([{ ...native, ...metadata }]), 'test', {
        model: native.value, providerId: null,
      }), 'INVALID_CATALOG');
    }
  });
});
