import { describe, expect, test } from 'bun:test';
import { AgentTypeRegistry } from '../type-registry.ts';
import { loadDefaultAgentIntegrations } from '../default-agent-integrations.ts';

const defaultAgentIntegrations = await loadDefaultAgentIntegrations();

function definition(id = 'alpha') {
  return {
    integrationId: id,
    apiVersion: 5,
    descriptor: {
      id, label: id, icon: null,
      supportedPermissionModes: ['default'], supportedThinkingModes: [],
      supportsImages: false, supportsProjectPathUpdate: false,
      requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [],
      configuration: [{ key: 'ALPHA_BINARY', source: 'environment', description: 'Binary' }],
    },
  };
}

describe('AgentTypeRegistry', () => {
  test('reads all shipped provider declarations without constructing executables or hosts', () => {
    const declarations = defaultAgentIntegrations.map((integration) => ({
      integrationId: integration.integrationId, apiVersion: integration.apiVersion,
      descriptor: integration.descriptor,
    }));
    const types = new AgentTypeRegistry(declarations);
    expect(types.list().map((entry) => entry.id)).toEqual(declarations.map((entry) => entry.integrationId));
    for (const declaration of declarations) expect(types.require(declaration.integrationId)).toEqual(declaration.descriptor);
    expect(types.get('missing')).toBeNull();
    expect(types.has('missing')).toBe(false);
    expect(() => types.require('missing')).toThrow('Unsupported agent integration');
  });

  test('retains immutable data rather than constructors or caller-owned arrays', () => {
    const declaration = definition();
    class Unavailable {
      static integrationId = declaration.integrationId;
      static apiVersion = declaration.apiVersion;
      static descriptor = declaration.descriptor;
      constructor() { throw new Error('No execution host exists'); }
    }
    const types = new AgentTypeRegistry([Unavailable]);
    declaration.descriptor.label = 'changed';
    declaration.descriptor.configuration[0].key = 'SECRET';
    declaration.descriptor.supportedPermissionModes.push('bypassPermissions');
    const descriptor = types.require('alpha');
    expect(descriptor.label).toBe('alpha');
    expect(descriptor.configuration[0].key).toBe('ALPHA_BINARY');
    expect(descriptor.supportedPermissionModes).toEqual(['default']);
    expect(() => { descriptor.configuration[0].key = 'SECRET'; }).toThrow();
    expect(() => { descriptor.supportedPermissionModes.push('bypassPermissions'); }).toThrow();
    types.list().pop();
    expect(types.has('alpha')).toBe(true);
    expect(Object.keys(descriptor)).toEqual(Object.keys(declaration.descriptor));
  });

  test.each([
    ['version', (entry) => { entry.apiVersion = 4; }, 'Unsupported agent integration API version'],
    ['ID', (entry) => { entry.integrationId = '../alpha'; }, 'Invalid agent integration ID'],
    ['missing ID', (entry) => { delete entry.integrationId; delete entry.descriptor.id; }, 'Invalid agent integration ID'],
    ['descriptor ID', (entry) => { entry.descriptor.id = 'beta'; }, 'Agent integration ID mismatch'],
    ['label', (entry) => { entry.descriptor.label = ' '; }, 'empty label'],
    ['environment key', (entry) => { entry.descriptor.configuration[0].key = ''; }, 'invalid configuration'],
    ['environment source', (entry) => { entry.descriptor.configuration[0].source = 'file'; }, 'invalid configuration'],
    ['duplicate configuration', (entry) => { entry.descriptor.configuration.push({ ...entry.descriptor.configuration[0] }); }, 'declares configuration'],
    ['duplicate mode', (entry) => { entry.descriptor.supportedPermissionModes.push('default'); }, 'duplicate permission modes'],
  ])('rejects an invalid %s before any execution exists', (_name, invalidate, expected) => {
    const declaration = definition();
    invalidate(declaration);
    expect(() => new AgentTypeRegistry([declaration])).toThrow(expected);
  });

  test('rejects duplicate provider definitions independently of configured instance identity', () => {
    expect(() => new AgentTypeRegistry([definition(), definition()])).toThrow('Duplicate agent integration ID');
  });
});
