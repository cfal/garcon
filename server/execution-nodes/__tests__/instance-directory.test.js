import { describe, expect, mock, test } from 'bun:test';
import { createLocalProviderInstances } from '../../execution-node/local-provider-instance.js';
import { AgentInstanceDirectory } from '../../agents/instance-directory.js';

function instance(nodeId, id, defaults = false) {
  return {
    configuration: {
      id, nodeId, agentId: 'synthetic-provider', label: id, storageNamespace: `instances/${id}`,
      default: defaults, removedAt: null,
    },
    integration: { descriptor: { id: 'synthetic-provider' } },
  };
}

describe('instance-qualified service directory', () => {
  test('separately composed local registrations retain one executable binding', () => {
    const first = instance('first-node', 'first');
    const second = { ...instance('second-node', 'second'), integration: first.integration };
    const original = createLocalProviderInstances([first]);
    const alias = createLocalProviderInstances([second]);
    expect(() => new AgentInstanceDirectory([...original, ...alias])).toThrow('share one');
    expect(original[0].services.binding).toBe(alias[0].services.binding);
    expect(Object.keys(original[0].services.binding)).toEqual([]);
    expect(() => new AgentInstanceDirectory(original)).not.toThrow();
    expect(() => new AgentInstanceDirectory(alias)).not.toThrow();
  });

  test('resolves multiple instances of the same provider without cross-node fallback', () => {
    const local = instance('local', 'default', true);
    const work = instance('node-a', 'work', true);
    const personal = instance('node-a', 'personal');
    const secondNode = instance('node-b', 'work', true);
    const registrations = createLocalProviderInstances([local, work, personal, secondNode]);
    const directory = new AgentInstanceDirectory(registrations);
    for (const entry of registrations) {
      expect(directory.require({ nodeId: entry.configuration.nodeId, instanceId: entry.configuration.id })).toBe(entry.services);
    }
    expect(directory.defaultFor('node-a', 'synthetic-provider')).toEqual({ nodeId: 'node-a', instanceId: 'work' });
    expect(directory.defaultFor('missing-node', 'synthetic-provider')).toBeNull();
    expect(directory.defaultFor('node-a', 'missing-provider')).toBeNull();
    expect(() => directory.require({ nodeId: 'node-b', instanceId: 'personal' })).toThrow('unavailable');
    expect(directory.configurations('node-a').map((entry) => entry.id)).toEqual(['work', 'personal']);
  });

  test('rejects duplicate identity, default, shared executable, shared storage and provider mismatch', () => {
    const work = instance('node-a', 'work', true);
    const personal = instance('node-a', 'personal');
    expect(() => new AgentInstanceDirectory(createLocalProviderInstances([work, instance('node-a', 'work', true)]))).toThrow('Duplicate configured');
    expect(() => new AgentInstanceDirectory(createLocalProviderInstances([work, instance('node-a', 'personal', true)]))).toThrow('Duplicate default');
    expect(() => new AgentInstanceDirectory(createLocalProviderInstances([work, { ...personal, integration: work.integration }]))).toThrow('share one executable');
    expect(() => new AgentInstanceDirectory(createLocalProviderInstances([work, {
      ...personal, configuration: { ...personal.configuration, storageNamespace: work.configuration.storageNamespace },
    }]))).toThrow('share one storage');
    expect(() => new AgentInstanceDirectory(createLocalProviderInstances([{
      ...personal, integration: { descriptor: { id: 'different-provider' } },
    }]))).toThrow('provider type');
  });

  test('captures configuration and keeps removed defaults unavailable rather than substituting another profile', () => {
    const work = instance('node-a', 'work', true);
    const personal = instance('node-a', 'personal');
    work.configuration.removedAt = '2026-09-09T00:00:00.000Z';
    const directory = new AgentInstanceDirectory(createLocalProviderInstances([work, personal]));
    work.configuration.removedAt = null;
    expect(directory.defaultFor('node-a', 'synthetic-provider')).toBeNull();
    expect(directory.get({ nodeId: 'node-a', instanceId: 'work' })).toBeNull();
    const returned = directory.configurations('node-a');
    returned[0].removedAt = null;
    expect(directory.configurations('node-a')[0].removedAt).not.toBeNull();
  });

  test('checks the exact chat owner instead of resolving by its provider type', () => {
    const work = instance('node-a', 'work', true);
    const personal = instance('node-a', 'personal');
    const registrations = createLocalProviderInstances([work, personal]);
    const directory = new AgentInstanceDirectory(registrations);
    const owner = { agentId: 'synthetic-provider', executionLocation: {
      nodeId: 'node-a', instanceId: 'personal', workspaceId: 'workspace-a',
    } };
    expect(directory.requireFor(owner)).toBe(registrations[1].services);
    expect(() => directory.requireFor({ ...owner, agentId: 'other-provider' })).toThrow('provider');
    expect(() => directory.requireFor({ ...owner, executionLocation: { ...owner.executionLocation, nodeId: 'offline' } }))
      .toThrow('unavailable');
  });

  test('binds configuration services to exact instances and caches only that binding', async () => {
    const work = instance('node-a', 'work', true);
    const personal = instance('node-a', 'personal');
    for (const entry of [work, personal]) {
      entry.integration.descriptor.supportedPermissionModes = ['default'];
      entry.integration.descriptor.supportedThinkingModes = ['none'];
      entry.integration.settings = {
        defaults: () => ({ ownerId: 'synthetic-provider', schemaVersion: 1, values: { profile: entry.configuration.id } }),
        parse: (value) => value,
      };
    }
    const directory = new AgentInstanceDirectory(createLocalProviderInstances([work, personal]));
    const owner = { agentId: 'synthetic-provider', executionLocation: {
      nodeId: 'node-a', instanceId: 'personal', workspaceId: 'workspace-a',
    } };
    const configuration = directory.configurationFor(owner);
    expect(directory.configurationFor(owner)).toBe(configuration);
    const result = await configuration.resolve({ model: 'synthetic-model', settings: null, endpoint: null }, new AbortController().signal);
    expect(result.settings.values).toEqual({ profile: 'personal' });
    expect(() => directory.configurationFor({ ...owner, agentId: 'other-provider' })).toThrow('provider');
    expect(() => directory.configurationFor({ ...owner, executionLocation: { ...owner.executionLocation, nodeId: 'offline' } }))
      .toThrow('unavailable');
  });

  test('caches an immutable metadata snapshot per instance while checking availability on every lookup', () => {
    const entries = [instance('node-a', 'work'), instance('node-a', 'personal'), instance('node-b', 'work')];
    const removed = instance('node-a', 'removed');
    removed.configuration.removedAt = '2026-09-09T00:00:00.000Z';
    for (const entry of entries) {
      entry.integration.settings = {
        describe: mock(() => []),
        defaults: mock(() => ({ ownerId: 'synthetic-provider', schemaVersion: 1,
          values: { nested: { profile: entry.configuration.id } } })),
      };
    }
    const directory = new AgentInstanceDirectory(createLocalProviderInstances([...entries, removed]));
    const snapshots = [];
    for (const entry of entries) {
      const ref = { nodeId: entry.configuration.nodeId, instanceId: entry.configuration.id };
      directory.assertAvailableForInstance(ref);
      expect(entry.integration.settings.describe).not.toHaveBeenCalled();
      const metadata = directory.metadataForInstance(ref);
      const owner = { agentId: 'synthetic-provider', executionLocation: { ...ref, workspaceId: 'workspace' } };
      expect(directory.metadataFor(owner)).toBe(metadata);
      expect(directory.metadataForInstance({ ...ref })).toBe(metadata);
      expect(entry.integration.settings.describe).toHaveBeenCalledTimes(1);
      expect(entry.integration.settings.defaults).toHaveBeenCalledTimes(1);
      expect(metadata.defaultSettings.values).toEqual({ nested: { profile: entry.configuration.id } });
      expect(Object.isFrozen(metadata)).toBe(true);
      expect(Object.isFrozen(metadata.defaultSettings.values.nested)).toBe(true);
      expect(() => directory.metadataFor({ ...owner, agentId: 'other-provider' })).toThrow('provider');
      snapshots.push(metadata);
    }
    expect(new Set(snapshots).size).toBe(3);
    for (const ref of [
      { nodeId: 'node-a', instanceId: 'removed' }, { nodeId: 'node-a', instanceId: 'missing' },
    ]) {
      expect(() => directory.metadataForInstance(ref)).toThrow('unavailable');
      expect(() => directory.assertAvailableForInstance(ref)).toThrow('unavailable');
    }
  });

  test('binds project-path preparation to exact instances and permits absent native preparation', async () => {
    const entries = [instance('node-a', 'work'), instance('node-a', 'personal'), instance('node-b', 'work')];
    for (const entry of entries) {
      entry.integration.settings = { parse: (value) => value };
      entry.integration.projectPathUpdates = { prepare: mock(async () => ({ rollback: async () => {} })) };
    }
    const noPreparation = instance('node-a', 'without-preparation');
    noPreparation.integration.projectPathUpdates = null;
    const directory = new AgentInstanceDirectory(createLocalProviderInstances([...entries, noPreparation]));
    const services = [];
    for (const entry of entries) {
      const owner = { agentId: 'synthetic-provider', executionLocation: {
        nodeId: entry.configuration.nodeId, instanceId: entry.configuration.id, workspaceId: 'workspace',
      } };
      const service = directory.projectPathUpdatesFor(owner);
      expect(directory.projectPathUpdatesFor(structuredClone(owner))).toBe(service);
      await service.prepare({ chat: { chatId: 'synthetic-chat', agentId: 'synthetic-provider', agentSessionId: 'colliding-session',
        projectPath: '/source', nativeSession: null, carryOverRevision: 'synthetic-revision',
        settings: { ownerId: 'synthetic-provider', schemaVersion: 1, values: { profile: entry.configuration.id } },
      }, nextProjectPath: '/destination' }, new AbortController().signal);
      expect(entry.integration.projectPathUpdates.prepare).toHaveBeenCalledTimes(1);
      expect(entry.integration.projectPathUpdates.prepare.mock.calls[0][0].chat.settings.values)
        .toEqual({ profile: entry.configuration.id });
      expect(() => directory.projectPathUpdatesFor({ ...owner, agentId: 'other-provider' })).toThrow('provider');
      expect(() => directory.projectPathUpdatesFor({ ...owner, executionLocation: { ...owner.executionLocation, nodeId: 'offline' } }))
        .toThrow('unavailable');
      services.push(service);
    }
    expect(new Set(services).size).toBe(3);
    expect(directory.projectPathUpdatesFor({ agentId: 'synthetic-provider', executionLocation: {
      nodeId: 'node-a', instanceId: 'without-preparation', workspaceId: 'workspace',
    } })).toBeNull();
  });

  test('binds catalogs to the exact node and instance without provider fallback', async () => {
    const work = instance('node-a', 'work', true);
    const personal = instance('node-a', 'personal');
    const otherNode = instance('node-b', 'work', true);
    const removed = instance('node-a', 'removed');
    removed.configuration.removedAt = '2026-09-09T00:00:00.000Z';
    for (const entry of [work, personal, otherNode, removed]) {
      const model = `${entry.configuration.nodeId}/${entry.configuration.id}`;
      entry.integration.catalog = {
        snapshot: async () => ({
          models: [{ value: model, label: model, supportsImages: false }],
          defaultModel: model, requiresStrictModelDiscovery: false, generation: null,
        }),
      };
    }
    const directory = new AgentInstanceDirectory(createLocalProviderInstances([work, personal, otherNode, removed]));
    const signal = new AbortController().signal;
    for (const entry of [work, personal, otherNode]) {
      const ref = { nodeId: entry.configuration.nodeId, instanceId: entry.configuration.id };
      const catalog = directory.catalogForInstance(ref);
      expect(directory.catalogForInstance({ ...ref })).toBe(catalog);
      expect((await catalog.snapshot({ strict: false }, signal)).defaultModel)
        .toBe(`${entry.configuration.nodeId}/${entry.configuration.id}`);
    }
    for (const ref of [
      { nodeId: 'node-a', instanceId: 'missing' },
      { nodeId: 'node-a', instanceId: 'removed' },
      { nodeId: 'offline', instanceId: 'work' },
    ]) {
      expect(() => directory.catalogForInstance(ref)).toThrow('unavailable');
    }
  });

  test('execution operations retain the configured instance and its cached configuration service', async () => {
    const entries = [instance('node-a', 'work', true), instance('node-a', 'personal'), instance('node-b', 'work', true)];
    for (const entry of entries) {
      Object.assign(entry.integration.descriptor, { supportedPermissionModes: ['default'], supportedThinkingModes: ['none'] });
      entry.integration.settings = {
        defaults: () => ({ ownerId: 'synthetic-provider', schemaVersion: 1, values: { profile: entry.configuration.id } }),
        parse: (value) => value,
      };
      const handle = Object.freeze({});
      entry.integration.execution = {
        start: mock(async () => handle), resume: mock(async () => handle),
        abort: mock(async (target) => target === handle), runningSessions: () => [],
      };
      entry.integration.compaction = null;
    }
    const directory = new AgentInstanceDirectory(createLocalProviderInstances(entries));
    const services = [];
    for (const entry of entries) {
      const owner = { agentId: 'synthetic-provider', executionLocation: {
        nodeId: entry.configuration.nodeId, instanceId: entry.configuration.id, workspaceId: 'workspace',
      } };
      const configuration = directory.configurationFor(owner);
      configuration.resolve = mock(configuration.resolve.bind(configuration));
      const service = directory.executionFor(owner);
      expect(directory.executionFor(structuredClone(owner))).toBe(service);
      const operation = await service.prepare({
        kind: 'resume', chatId: 'synthetic-chat', projectPath: '/project', runId: 'synthetic-run',
        agentSessionId: 'colliding-native-session', nativeSession: null,
        configuration: { model: 'synthetic-model', settings: null, endpoint: null },
      }, new AbortController().signal);
      const content = { prompt: 'synthetic input', attachments: [], carriedContext: null };
      const delivery = { output: { signal: new AbortController().signal, emit() {} }, admission: { signal: new AbortController().signal, async markStarted() {} } };
      for (const other of services) {
        await expect(other.dispatch(operation, content, delivery)).rejects.toThrow('operation is invalid');
        await expect(other.abort(operation)).rejects.toThrow('operation is invalid');
      }
      await service.dispatch(operation, content, delivery);
      expect(configuration.resolve).toHaveBeenCalledTimes(1);
      expect(entry.integration.execution.resume).toHaveBeenCalledTimes(1);
      expect(entry.integration.execution.resume.mock.calls[0][0].settings.values).toEqual({ profile: entry.configuration.id });
      expect(await service.abort(operation)).toBe(true);
      expect(entry.integration.execution.abort).toHaveBeenCalledTimes(1);
      services.push(service);
      expect(() => directory.executionFor({ ...owner, agentId: 'other-provider' })).toThrow('provider');
      expect(() => directory.executionFor({ ...owner, executionLocation: { ...owner.executionLocation, nodeId: 'offline' } }))
        .toThrow('unavailable');
    }
    expect(new Set(services).size).toBe(3);
  });
});
