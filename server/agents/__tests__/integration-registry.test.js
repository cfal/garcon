import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { IntegrationHostFactory } from '../integration-host.ts';
import { IntegrationRegistry } from '../integration-registry.ts';

function createFacetIntegration(host, id, lifecycle = {}) {
  const settings = { ownerId: id, schemaVersion: 1, values: {} };
  return {
    descriptor: {
      id,
      label: id,
      icon: null,
      supportedPermissionModes: [],
      supportedThinkingModes: [],
      supportsImages: false,
      supportsProjectPathUpdate: false,
      requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: [],
      configuration: [{ key: `${id.toUpperCase()}_BIN`, source: 'environment', description: 'Binary' }],
    },
    execution: {
      start: async () => ({ id: 'execution' }),
      resume: async () => ({ id: 'execution' }),
      abort: async () => false,
      runningSessions: () => [],
    },
    attachments: null,
    legacyHistoryImport: null,
    nativeHistoryImport: null,
    nativeActivity: null,
    nativeSessions: null,
    sessionConfiguration: null,
    projectPathUpdates: null,
    catalog: {
      snapshot: async () => ({
        models: [],
        defaultModel: '',
        requiresStrictModelDiscovery: false,
        generation: null,
      }),
    },
    settings: {
      describe: () => [],
      defaults: () => settings,
      parse: (input) => input,
      migrate: async (input) => input,
      applyPatch: (current) => current,
    },
    lifecycle: {
      start: lifecycle.start ?? (async () => {}),
      stop: lifecycle.stop ?? (async () => {}),
      migrateOwnedStorage: lifecycle.migrateOwnedStorage ?? (async () => {}),
    },
    migration: {
      translateLegacyModel: async ({ model }) => model,
      translateLegacyNativeSession: async () => null,
      translateLegacySettings: async () => null,
    },
    auth: null,
    commands: null,
    compaction: null,
    forking: null,
    steering: null,
    goals: null,
    transientControls: null,
    endpoints: null,
    singleQuery: null,
    textGeneration: null,
    testHost: host,
  };
}

function integrationClass(id, options = {}) {
  return class TestIntegration {
    static integrationId = id;
    static apiVersion = options.apiVersion ?? 5;
    static descriptor = createFacetIntegration(null, id).descriptor;
    constructor(host) {
      options.onConstruct?.(host);
      Object.assign(this, createFacetIntegration(host, id, options.lifecycle));
    }
  };
}

function hostFactory(workspaceDir) {
  return new IntegrationHostFactory({
    workspaceDir,
    loggerFactory: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    readEnvironment: (name) => name === 'ALPHA_BIN' ? '/bin/alpha' : undefined,
  });
}

const migrationStoreFor = () => ({
  getVersion: async () => 0,
  read: async () => undefined,
  commit: async () => {},
});

describe('IntegrationRegistry', () => {
  test('validates every provider declaration before constructing the first executable', () => {
    let constructed = 0;
    const Alpha = integrationClass('alpha', { onConstruct: () => { constructed += 1; } });
    const Invalid = integrationClass('invalid');
    Invalid.descriptor.label = ' ';
    expect(() => new IntegrationRegistry({
      integrations: [Alpha, Invalid], hostFactory: hostFactory(os.tmpdir()), migrationStoreFor,
    })).toThrow('empty label');
    expect(constructed).toBe(0);
  });

  test('rejects an executable that changes its declared metadata', () => {
    const Alpha = integrationClass('alpha');
    Alpha.descriptor.label = 'Declared alpha';
    expect(() => new IntegrationRegistry({
      integrations: [Alpha], hostFactory: hostFactory(os.tmpdir()), migrationStoreFor,
    })).toThrow('descriptor does not match its declaration');
  });

  test('keeps the pre-construction metadata snapshot when the constructor mutates its declaration', () => {
    const Alpha = integrationClass('alpha', {
      onConstruct: () => { Alpha.descriptor.supportsImages = true; },
    });
    class MutatingIntegration extends Alpha {
      constructor(host) {
        super(host);
        this.descriptor = Alpha.descriptor;
      }
    }
    expect(() => new IntegrationRegistry({
      integrations: [MutatingIntegration], hostFactory: hostFactory(os.tmpdir()), migrationStoreFor,
    })).toThrow('descriptor does not match its declaration');
  });

  test('cannot adopt another prevalidated identity during construction', () => {
    const Beta = integrationClass('beta');
    class Alpha extends integrationClass('alpha') {
      constructor(host) {
        super(host);
        Alpha.integrationId = 'beta';
        Object.assign(this, createFacetIntegration(host, 'beta'));
      }
    }
    expect(() => new IntegrationRegistry({
      integrations: [Beta, Alpha], hostFactory: hostFactory(os.tmpdir()), migrationStoreFor,
    })).toThrow('Agent integration ID mismatch: alpha != beta');
  });

  test('captures every complete definition before any constructor can change it', () => {
    const Beta = integrationClass('beta');
    const Alpha = integrationClass('alpha', { onConstruct: () => {
      Beta.integrationId = 'changed';
      Beta.apiVersion = 1;
      Beta.descriptor = createFacetIntegration(null, 'changed').descriptor;
    } });
    const registry = new IntegrationRegistry({
      integrations: [Alpha, Beta], hostFactory: hostFactory(os.tmpdir()), migrationStoreFor,
    });
    expect(registry.list().map((integration) => integration.descriptor.id)).toEqual(['alpha', 'beta']);
    expect(registry.types.require('beta')).toEqual(registry.require('beta').descriptor);
    expect(() => registry.require('beta').testHost.environment.get('BETA_BIN')).not.toThrow();
    expect(() => registry.require('beta').testHost.environment.get('CHANGED_BIN')).toThrow();
  });

  test('captures the constructor list before any executable can replace a later constructor', () => {
    let betaConstructed = 0;
    let replacementConstructed = 0;
    const Beta = integrationClass('beta', { onConstruct: () => { betaConstructed += 1; } });
    const Replacement = integrationClass('beta', { onConstruct: () => { replacementConstructed += 1; } });
    const Alpha = integrationClass('alpha', { onConstruct: () => { integrations[1] = Replacement; } });
    const integrations = [Alpha, Beta];
    const registry = new IntegrationRegistry({
      integrations, hostFactory: hostFactory(os.tmpdir()), migrationStoreFor,
    });
    expect(registry.classes()).toEqual([Alpha, Beta]);
    expect(betaConstructed).toBe(1);
    expect(replacementConstructed).toBe(0);
  });

  test('constructs one instance and binds only declared environment names', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-agent-host-'));
    let constructed = 0;
    try {
      const registry = new IntegrationRegistry({
        integrations: [integrationClass('alpha', { onConstruct: () => { constructed += 1; } })],
        hostFactory: hostFactory(directory),
        migrationStoreFor,
      });
      const integration = registry.require('alpha');
      expect(registry.require('alpha')).toBe(integration);
      expect(constructed).toBe(1);
      expect(registry.types.require('alpha')).toEqual(integration.descriptor);
      expect(integration.testHost.environment.get('ALPHA_BIN')).toBe('/bin/alpha');
      expect(() => integration.testHost.environment.get('SECRET')).toThrow(AgentIntegrationError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects duplicate IDs and unsupported API versions before a duplicate construction', () => {
    let duplicateConstructions = 0;
    const Alpha = integrationClass('alpha');
    const Duplicate = integrationClass('alpha', { onConstruct: () => { duplicateConstructions += 1; } });
    expect(() => new IntegrationRegistry({
      integrations: [Alpha, Duplicate],
      hostFactory: hostFactory(os.tmpdir()),
      migrationStoreFor,
    })).toThrow('Duplicate agent integration ID');
    expect(duplicateConstructions).toBe(0);

    const Invalid = integrationClass('invalid', { apiVersion: 1 });
    expect(() => new IntegrationRegistry({
      integrations: [Invalid],
      hostFactory: hostFactory(os.tmpdir()),
      migrationStoreFor,
    })).toThrow('Unsupported agent integration API version for invalid: 1');
  });

  test('rolls back started integrations in reverse order', async () => {
    const calls = [];
    const Alpha = integrationClass('alpha', { lifecycle: {
      start: async () => { calls.push('start-alpha'); },
      stop: async () => { calls.push('stop-alpha'); },
    } });
    const Beta = integrationClass('beta', { lifecycle: {
      start: async () => { calls.push('start-beta'); throw new Error('boom'); },
      stop: async () => { calls.push('stop-beta'); },
    } });
    const registry = new IntegrationRegistry({
      integrations: [Alpha, Beta],
      hostFactory: hostFactory(os.tmpdir()),
      migrationStoreFor,
    });
    await expect(registry.start()).rejects.toThrow('boom');
    expect(calls).toEqual(['start-alpha', 'start-beta', 'stop-alpha']);
  });
});

describe('IntegrationHostFactory storage', () => {
  test('rejects traversal and symlink escapes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-agent-storage-'));
    try {
      const factory = hostFactory(directory);
      const host = factory.forAgent('alpha');
      expect(await host.storage.directory('search')).toBe(
        path.join(directory, 'agent-data', 'alpha', 'search'),
      );
      await expect(host.storage.directory('../escape')).rejects.toThrow(AgentIntegrationError);
      await expect(host.storage.directory('%2e%2e')).rejects.toThrow(AgentIntegrationError);
      await symlink(directory, path.join(directory, 'agent-data', 'alpha', 'linked'));
      await expect(host.storage.directory('linked')).rejects.toThrow(AgentIntegrationError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
