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
      start: async () => ({ agentSessionId: 'session', nativeSession: null }),
      resume: async () => {},
      abort: async () => false,
      isRunning: () => false,
      runningSessions: () => [],
      subscribe: () => () => {},
    },
    transcript: {
      resolveNativeSession: async () => null,
      load: async () => ({ messages: [], revision: 'empty' }),
      preview: async () => null,
      revision: async () => 'empty',
      release: async () => {},
    },
    transcriptSearch: {
      reconcile: async () => {},
      search: async () => ({
        hits: [],
        index: { indexedChatCount: 0, pendingChatCount: 0, failedChatCount: 0, unsupportedChatCount: 0 },
      }),
      status: async () => ({ indexedChatCount: 0, pendingChatCount: 0, failedChatCount: 0, unsupportedChatCount: 0 }),
      disableAndDelete: async () => {},
    },
    catalog: {
      snapshot: async () => ({
        models: [],
        defaultModel: '',
        requiresStrictModelDiscovery: false,
        generation: null,
        availability: { state: 'ready', reason: 'test' },
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
      translateLegacyNativeSession: async () => null,
      translateLegacySettings: async () => null,
    },
    auth: null,
    commands: null,
    forking: null,
    endpoints: null,
    singleQuery: null,
    testHost: host,
  };
}

function integrationClass(id, options = {}) {
  return class TestIntegration {
    static integrationId = id;
    static apiVersion = options.apiVersion ?? 1;

    constructor(host) {
      options.onConstruct?.(host);
      Object.assign(this, createFacetIntegration(host, id, options.lifecycle));
    }
  };
}

function hostFactory(workspaceDir) {
  return new IntegrationHostFactory({
    workspaceDir,
    resolveCredential: async () => null,
    loadCarryOver: async ({ expectedRevision }) => ({ revision: expectedRevision, messages: [] }),
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

    const Invalid = integrationClass('invalid', { apiVersion: 2 });
    expect(() => new IntegrationRegistry({
      integrations: [Invalid],
      hostFactory: hostFactory(os.tmpdir()),
      migrationStoreFor,
    })).toThrow('Unsupported agent integration API version');
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
