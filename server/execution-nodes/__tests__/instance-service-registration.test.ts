import { expect, mock, test } from 'bun:test';
import { AgentCatalogService } from '../../agents/catalog-service.js';
import { AgentInstanceDirectory } from '../../agents/instance-directory.js';
import { ApiProviderEndpointResolver } from '../../api-providers/endpoint-resolver.js';
import type { ProviderInstanceRegistration, ProviderInstanceServices } from '../provider-instance.js';
import type { ProviderInstanceMetadata } from '../provider-metadata.js';
import type { ProviderNativeSessionRequest } from '../provider-native-sessions.js';

function registration(nodeId: string, id: string) {
  const unexpected = mock((): never => { throw new Error('Unexpected provider I/O'); });
  const metadata = {
    descriptor: { id: 'synthetic-provider', label: id, icon: null,
      supportedPermissionModes: ['default'], supportedThinkingModes: ['none'], supportsImages: false,
      supportsProjectPathUpdate: true, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: [], configuration: [] },
    settings: [], defaultSettings: { ownerId: 'synthetic-provider', schemaVersion: 1, values: { profile: id } },
    facets: { attachments: null, execution: true, catalog: true, auth: null, commands: null,
      compaction: null, forking: null, steering: null, goals: null, endpoints: null,
      singleQuery: null, textGeneration: null, legacyHistoryImport: null, nativeHistoryImport: null,
      nativeActivity: null, nativeSessions: true, sessionConfiguration: null, projectPathUpdates: null },
    fileAttachmentMimeTypes: [], authCapabilities: { launchLogin: false, completeLogin: false },
  } satisfies ProviderInstanceMetadata;
  const pending = Promise.withResolvers<Awaited<ReturnType<ProviderInstanceServices['catalog']['snapshot']>>>();
  const snapshot = mock(() => pending.promise);
  const resolve = mock(async (request: ProviderNativeSessionRequest, signal: AbortSignal) => {
    signal.throwIfAborted();
    return { ownerId: 'synthetic-provider', schemaVersion: 1,
      value: { nodeId, instanceId: id, sessionId: request.chat.agentSessionId } };
  });
  const services = {
    binding: Object.freeze({}), agentId: 'synthetic-provider', metadata,
    configuration: { prepareUpdate: unexpected, prepareApply: unexpected, commit: unexpected, cancel: unexpected },
    catalog: { snapshot }, auth: { status: unexpected, loginStatus: unexpected, launchLogin: unexpected, completeLogin: unexpected },
    commands: { discover: unexpected },
    execution: { prepare: unexpected, dispatch: unexpected, release: unexpected, abort: unexpected,
      prepareSteer: unexpected, steer: unexpected, submitGoalControl: unexpected },
    nativeSessions: { resolve, describe: unexpected, release: unexpected },
    nativeActivity: null, legacyHistoryImport: null, nativeHistoryImport: null, nativeFork: null,
    singleQuery: null, textGeneration: null, projectPathUpdates: null,
  } satisfies ProviderInstanceServices;
  const entry = {
    configuration: { nodeId, id, agentId: 'synthetic-provider', label: id, storageNamespace: `instances/${id}`,
      default: true, removedAt: null }, services,
  } satisfies ProviderInstanceRegistration;
  return { entry, unexpected, snapshot, resolve, pending };
}

test('controller catalog consumes registered metadata and async ports without an executable integration', async () => {
  const local = registration('local', 'profile'); const remote = registration('remote', 'profile');
  const directory = new AgentInstanceDirectory([local.entry, remote.entry]);
  const ref = { nodeId: 'remote', instanceId: 'profile' };
  expect(directory.metadataForInstance(ref)).toBe(remote.entry.services.metadata);
  expect(remote.snapshot).not.toHaveBeenCalled();
  const catalog = new AgentCatalogService({ instances: directory, localNodeId: 'local', defaultAgentIds: ['synthetic-provider'],
    endpointResolver: new ApiProviderEndpointResolver(() => [], () => []) });
  const pending = catalog.getAgentCatalogEntryForInstance(ref);
  expect(remote.snapshot).toHaveBeenCalledTimes(1);
  expect(local.snapshot).not.toHaveBeenCalled();
  remote.pending.resolve({ models: [{ value: 'remote-model', label: 'Remote model', supportsImages: false }],
    defaultModel: 'remote-model', requiresStrictModelDiscovery: true, generation: null });
  expect(await pending).toMatchObject({ defaultModel: 'remote-model', supportsUpdateProjectPath: true });
  expect(directory.projectPathUpdatesFor({ agentId: 'synthetic-provider', executionLocation: { ...ref, workspaceId: 'workspace' } })).toBeNull();
  expect(local.unexpected).not.toHaveBeenCalled(); expect(remote.unexpected).not.toHaveBeenCalled();
});

test('registered native services retain exact node and instance ownership for colliding native identities', async () => {
  const entries = [registration('first-node', 'profile'), registration('second-node', 'profile')];
  const directory = new AgentInstanceDirectory(entries.map(({ entry }) => entry));
  const signal = new AbortController().signal;
  const request = { chat: { chatId: '1000000000000001', agentId: 'synthetic-provider', model: 'synthetic-model',
    agentSessionId: 'colliding-session', projectPath: '/same/project', nativeSession: null, nativeSeedReceipt: null,
    carryOverRevision: 'synthetic-revision', settings: null } } satisfies ProviderNativeSessionRequest;
  for (const { entry, resolve, unexpected } of entries) {
    const owner = { agentId: entry.configuration.agentId, executionLocation: {
      nodeId: entry.configuration.nodeId, instanceId: entry.configuration.id, workspaceId: 'workspace',
    } };
    expect(await directory.nativeSessionsFor(owner).resolve(request, signal)).toMatchObject({
      value: { nodeId: owner.executionLocation.nodeId, instanceId: 'profile', sessionId: 'colliding-session' },
    });
    expect(resolve).toHaveBeenCalledWith(request, signal);
    expect(() => directory.nativeSessionsFor({ ...owner, agentId: 'different-provider' })).toThrow('provider');
    expect(() => directory.nativeSessionsFor({ ...owner, executionLocation: { ...owner.executionLocation, nodeId: 'missing' } })).toThrow('unavailable');
    expect(unexpected).not.toHaveBeenCalled();
  }
});

test('registrations reject reused services and mismatched providers while removed defaults never fall back', () => {
  const first = registration('node', 'first'); const second = registration('node', 'second');
  expect(() => new AgentInstanceDirectory([first.entry, { ...second.entry, services: first.entry.services }])).toThrow('share one service');
  expect(() => new AgentInstanceDirectory([{ ...first.entry, services: { ...first.entry.services, agentId: 'foreign' } }])).toThrow('provider type');
  const directory = new AgentInstanceDirectory([
    { ...first.entry, configuration: { ...first.entry.configuration, removedAt: '2026-09-11T00:00:00.000Z' } },
    { ...second.entry, configuration: { ...second.entry.configuration, default: false } },
  ]);
  expect(directory.defaultFor('node', 'synthetic-provider')).toBeNull();
  expect(() => directory.catalogForInstance({ nodeId: 'node', instanceId: 'first' })).toThrow('unavailable');
  expect(directory.catalogForInstance({ nodeId: 'node', instanceId: 'second' })).toBe(second.entry.services.catalog);
  expect(first.snapshot).not.toHaveBeenCalled(); expect(second.snapshot).not.toHaveBeenCalled();
});

test('shallow service copies cannot alias one configured provider binding', () => {
  const first = registration('first-node', 'first');
  const second = registration('second-node', 'second');
  expect(() => new AgentInstanceDirectory([first.entry, { ...second.entry, services: { ...first.entry.services } }])).toThrow('share one');
});

test.each(['descriptor', 'defaults'])('metadata validates its provider owner lazily: %s', (mismatch) => {
  const first = registration('first-node', 'first');
  const metadata = structuredClone(first.entry.services.metadata);
  if (mismatch === 'descriptor') metadata.descriptor.id = 'foreign-provider';
  else metadata.defaultSettings.ownerId = 'foreign-provider';
  const readMetadata = mock(() => metadata);
  const entry = { ...first.entry, services: { ...first.entry.services, get metadata() { return readMetadata(); } } } satisfies ProviderInstanceRegistration;
  const directory = new AgentInstanceDirectory([entry]);
  expect(readMetadata).not.toHaveBeenCalled();
  const ref = { nodeId: 'first-node', instanceId: 'first' };
  expect(() => directory.metadataForInstance(ref)).toThrow('provider');
  expect(() => directory.metadataFor({ agentId: first.entry.configuration.agentId,
    executionLocation: { ...ref, workspaceId: 'workspace' } })).toThrow('provider');
  expect(first.unexpected).not.toHaveBeenCalled();
});
