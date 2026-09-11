import { describe, expect, mock, test } from 'bun:test';
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

describe('instance-qualified executable directory', () => {
  test('resolves multiple instances of the same provider without cross-node fallback', () => {
    const local = instance('local', 'default', true);
    const work = instance('node-a', 'work', true);
    const personal = instance('node-a', 'personal');
    const secondNode = instance('node-b', 'work', true);
    const directory = new AgentInstanceDirectory([local, work, personal, secondNode]);
    for (const entry of [local, work, personal, secondNode]) {
      expect(directory.require({ nodeId: entry.configuration.nodeId, instanceId: entry.configuration.id })).toBe(entry.integration);
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
    expect(() => new AgentInstanceDirectory([work, work])).toThrow('Duplicate configured');
    expect(() => new AgentInstanceDirectory([work, instance('node-a', 'personal', true)])).toThrow('Duplicate default');
    expect(() => new AgentInstanceDirectory([work, { ...personal, integration: work.integration }])).toThrow('share one executable');
    expect(() => new AgentInstanceDirectory([work, {
      ...personal, configuration: { ...personal.configuration, storageNamespace: work.configuration.storageNamespace },
    }])).toThrow('share one storage');
    expect(() => new AgentInstanceDirectory([{
      ...personal, integration: { descriptor: { id: 'different-provider' } },
    }])).toThrow('provider type');
  });

  test('captures configuration and keeps removed defaults unavailable rather than substituting another profile', () => {
    const work = instance('node-a', 'work', true);
    const personal = instance('node-a', 'personal');
    work.configuration.removedAt = '2026-09-09T00:00:00.000Z';
    const directory = new AgentInstanceDirectory([work, personal]);
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
    const directory = new AgentInstanceDirectory([work, personal]);
    const owner = { agentId: 'synthetic-provider', executionLocation: {
      nodeId: 'node-a', instanceId: 'personal', workspaceId: 'workspace-a',
    } };
    expect(directory.requireFor(owner)).toBe(personal.integration);
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
    const directory = new AgentInstanceDirectory([work, personal]);
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
    const directory = new AgentInstanceDirectory([work, personal, otherNode, removed]);
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
    const directory = new AgentInstanceDirectory(entries);
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
      const delivery = { output: { emit() {} }, admission: { signal: new AbortController().signal, async markStarted() {} } };
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
