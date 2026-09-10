import { afterEach, expect, test } from 'bun:test';
import { AgentInstanceDirectory } from '../../agents/instance-directory.js';
import { toProviderNativeChatReference } from '../../agents/integration-chat-reference.js';
import { createLocatedInstanceFixture, LOCATED_CHATS } from '../../agents/__tests__/located-instance-fixture.js';

const fixtures = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose();
});

async function fixture() {
  const f = await createLocatedInstanceFixture();
  fixtures.push(f);
  return f;
}

async function read(service, entry) {
  const rows = [];
  const chat = toProviderNativeChatReference('1000000000000001', entry, 'synthetic-revision');
  for await (const batch of service.read({ chat }, new AbortController().signal)) rows.push(...batch);
  return rows;
}

test.each([[false, false], [false, true], [true, false], [true, true]])(
  'legacy (%s) and native (%s) availability remain independent for the exact instance', async (legacy, native) => {
    const f = await fixture();
    const integration = f.secondary.integration;
    if (!legacy) integration.legacyHistoryImport = null;
    if (!native) integration.nativeHistoryImport = null;
    const entry = f.chats.getChat(LOCATED_CHATS.secondary);
    const legacyService = f.instances.legacyHistoryImportFor(entry);
    const nativeService = f.instances.nativeHistoryImportFor(entry);
    expect(legacyService !== null).toBe(legacy);
    expect(nativeService !== null).toBe(native);
    expect(f.instances.hasAvailableNativeHistoryImportFor(entry)).toBe(native);
    if (legacy) {
      expect(await read(legacyService, entry)).toMatchObject([{ message: { content: 'secondary legacy' } }]);
      expect(f.instances.legacyHistoryImportFor(structuredClone(entry))).toBe(legacyService);
    }
    if (native) {
      expect(await read(nativeService, entry)).toMatchObject([{ message: { content: 'secondary native' } }]);
      expect(f.instances.nativeHistoryImportFor(structuredClone(entry))).toBe(nativeService);
    }
    if (legacy && native) expect(legacyService).not.toBe(nativeService);
    expect(f.primary.integration.settings.parse).not.toHaveBeenCalled();
    expect(f.primary.integration.legacyHistoryImport.load).not.toHaveBeenCalled();
    expect(f.primary.integration.nativeHistoryImport.load).not.toHaveBeenCalled();
  },
);

test.each(['same-node', 'same-instance-id'])('history service caches isolate %s and colliding native IDs', async (placement) => {
  const f = await fixture();
  const owners = ['primary', 'secondary'].map((profile) => ({
    ...f.chats.getChat(LOCATED_CHATS[profile]),
    executionLocation: {
      nodeId: placement === 'same-node' ? 'local-node' : `${profile}-node`,
      instanceId: placement === 'same-node' ? profile : 'profile', workspaceId: 'project',
    },
  }));
  const directory = new AgentInstanceDirectory(owners.map((owner, index) => ({
    configuration: {
      id: owner.executionLocation.instanceId, nodeId: owner.executionLocation.nodeId, agentId: 'test',
      label: `Profile ${index}`, storageNamespace: `instances/${index}`, default: index === 0, removedAt: null,
    },
    integration: f[index === 0 ? 'primary' : 'secondary'].integration,
  })));
  for (const [accessor, facet, suffix] of [
    ['legacyHistoryImportFor', 'legacyHistoryImport', 'legacy'],
    ['nativeHistoryImportFor', 'nativeHistoryImport', 'native'],
  ]) {
    const services = owners.map((owner) => directory[accessor](owner));
    expect(services[0]).not.toBe(services[1]);
    for (const [index, profile] of ['primary', 'secondary'].entries()) {
      expect(directory[accessor](structuredClone(owners[index]))).toBe(services[index]);
      expect(await read(services[index], owners[index])).toMatchObject([{ message: { content: `${profile} ${suffix}` } }]);
      expect(f[profile].integration[facet].load).toHaveBeenCalledWith(expect.objectContaining({ chat: expect.objectContaining({
        agentSessionId: 'colliding-session', settings: expect.objectContaining({ values: { parsedBy: profile } }),
      }) }));
    }
  }
});

test('unavailable, removed and foreign-provider instances reject before null facets, without fallback', async () => {
  const f = await fixture();
  f.primary.integration.legacyHistoryImport = null;
  f.primary.integration.nativeHistoryImport = null;
  const removed = new AgentInstanceDirectory([{
    configuration: { id: 'primary', nodeId: 'local-node', agentId: 'test', label: 'Removed',
      storageNamespace: 'instances/primary', default: true, removedAt: '2026-09-10T00:00:00.000Z' },
    integration: f.primary.integration,
  }]);
  for (const [directory, agentId, nodeId, instanceId] of [
    [f.instances, 'test', 'local-node', 'missing'], [f.instances, 'test', 'offline-node', 'primary'],
    [f.instances, 'foreign', 'local-node', 'primary'], [removed, 'test', 'local-node', 'primary'],
  ]) {
    const owner = { agentId, executionLocation: { nodeId, instanceId, workspaceId: 'project' } };
    for (const accessor of ['legacyHistoryImportFor', 'nativeHistoryImportFor']) {
      let failure;
      try { directory[accessor](owner); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'NODE_UNAVAILABLE' });
    }
    expect(directory.hasAvailableNativeHistoryImportFor(owner)).toBe(false);
  }
  expect(f.primary.integration.settings.parse).not.toHaveBeenCalled();
});

test('a present native import facet does not make a foreign-provider owner available', async () => {
  const f = await fixture();
  const owner = f.chats.getChat(LOCATED_CHATS.secondary);
  expect(f.instances.hasAvailableNativeHistoryImportFor(owner)).toBe(true);
  expect(f.instances.hasAvailableNativeHistoryImportFor({ ...owner, agentId: 'foreign' })).toBe(false);
  expect(f.secondary.integration.nativeHistoryImport.load).not.toHaveBeenCalled();
});

test('adoption uses only legacy while Reload and captured-source fork seeding use only native', async () => {
  const f = await fixture();
  const chatId = LOCATED_CHATS.secondary;
  await f.adoption.ensure(chatId);
  expect(f.secondary.integration.legacyHistoryImport.load).toHaveBeenCalledOnce();
  expect(f.secondary.integration.nativeHistoryImport.load).not.toHaveBeenCalled();
  await f.reload.reload(chatId);
  expect(f.secondary.integration.nativeHistoryImport.load).toHaveBeenCalledOnce();
  const sourceSession = f.chats.getChat(chatId);
  f.chats.updateChat(chatId, { projectPath: f.root, executionLocation: f.chats.getChat(LOCATED_CHATS.primary).executionLocation });
  const fork = { agentSessionId: 'forked-session', nativeSeedReceipt: null,
    nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'forked-session' } } };
  expect(await f.readFork({ targetChatId: '1000000000000003', sourceSession, fork, signal: new AbortController().signal }))
    .toMatchObject([{ kind: 'provider-row', message: { content: 'secondary native' } }]);
  expect(f.secondary.integration.nativeHistoryImport.load).toHaveBeenCalledTimes(2);
  expect(f.secondary.integration.nativeHistoryImport.load.mock.calls[1][0].chat).toMatchObject({
    chatId: '1000000000000003', ...fork, settings: { values: { parsedBy: 'secondary' } },
  });
  expect(f.secondary.integration.legacyHistoryImport.load).toHaveBeenCalledOnce();
  expect(f.primary.integration.nativeHistoryImport.load).not.toHaveBeenCalled();
  expect(f.primary.integration.legacyHistoryImport.load).not.toHaveBeenCalled();
  expect(f.primary.integration.settings.parse).not.toHaveBeenCalled();
});
