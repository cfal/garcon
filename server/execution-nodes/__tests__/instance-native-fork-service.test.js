import { afterEach, expect, test } from 'bun:test';
import { createLocalProviderInstances } from '../../execution-node/local-provider-instance.js';
import { AgentInstanceDirectory } from '../../agents/instance-directory.js';
import { toProviderNativeChatReference } from '../../agents/integration-chat-reference.js';
import { createLocatedInstanceFixture, LOCATED_CHATS } from '../../agents/__tests__/located-instance-fixture.js';

const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function fixture() {
  const result = await createLocatedInstanceFixture();
  fixtures.push(result);
  return result;
}

test.each(['same-node', 'same-instance-id'])('native fork services isolate %s and colliding native IDs', async (placement) => {
  const f = await fixture();
  const owners = ['primary', 'secondary'].map((profile) => ({
    ...f.chats.getChat(LOCATED_CHATS[profile]),
    executionLocation: {
      nodeId: placement === 'same-node' ? 'local-node' : `${profile}-node`,
      instanceId: placement === 'same-node' ? profile : 'profile', workspaceId: 'project',
    },
  }));
  const directory = new AgentInstanceDirectory(createLocalProviderInstances(owners.map((owner, index) => ({
    configuration: {
      id: owner.executionLocation.instanceId, nodeId: owner.executionLocation.nodeId, agentId: 'test',
      label: `Profile ${index}`, storageNamespace: `instances/${index}`, default: index === 0, removedAt: null,
    },
    integration: f[index === 0 ? 'primary' : 'secondary'].integration,
  }))));
  const services = owners.map((owner) => directory.nativeForkFor(owner));
  expect(services[0]).not.toBe(services[1]);
  for (const [index, profile] of ['primary', 'secondary'].entries()) {
    const owner = owners[index];
    const signal = new AbortController().signal;
    expect(directory.nativeForkFor(structuredClone(owner))).toBe(services[index]);
    const result = await services[index].fork({
      chatId: '1000000000000003',
      source: toProviderNativeChatReference(LOCATED_CHATS[profile], owner, 'synthetic-revision'),
      configuration: { model: owner.model, settings: null, endpoint: null }, providerMeta: null,
    }, signal);
    expect(result.kind).toBe('materialized');
    await services[index].discard({ session: result.session }, signal);
    expect(f[profile].integration.forking.fork).toHaveBeenCalledOnce();
    expect(f[profile].integration.forking.fork).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ agentSessionId: 'colliding-session',
        settings: expect.objectContaining({ values: { parsedBy: profile } }) }),
      settings: expect.objectContaining({ values: { parsedBy: profile } }),
    }));
    expect(f[profile].integration.forking.discard).toHaveBeenCalledWith(result.session, signal);
  }
});

test('null native fork capability belongs to the selected instance, without a default fallback', async () => {
  const f = await fixture();
  f.secondary.integration.forking = null;
  const owner = f.chats.getChat(LOCATED_CHATS.secondary);
  expect(f.instances.nativeForkFor(owner)).toBeNull();
  expect(await f.agents.forkAgentSession({
    sourceSession: owner, sourceChatId: LOCATED_CHATS.secondary, targetChatId: '1000000000000003',
    signal: new AbortController().signal,
  })).toBeNull();
  await f.agents.discardForkedAgentSession(owner, { agentSessionId: 'unused', nativeSession: null, nativeSeedReceipt: null });
  expect(f.primary.integration.forking.fork).not.toHaveBeenCalled();
  expect(f.primary.integration.forking.discard).not.toHaveBeenCalled();
  expect(f.primary.integration.settings.parse).not.toHaveBeenCalled();
});

test('unavailable, removed and mismatched instances reject before checking null fork capability', async () => {
  const f = await fixture();
  f.primary.integration.forking = null;
  const removed = new AgentInstanceDirectory(createLocalProviderInstances([{
    configuration: { id: 'primary', nodeId: 'local-node', agentId: 'test', label: 'Removed',
      storageNamespace: 'instances/primary', default: true, removedAt: '2026-09-10T00:00:00.000Z' },
    integration: f.primary.integration,
  }]));
  for (const [directory, agentId, nodeId, instanceId] of [
    [f.instances, 'test', 'local-node', 'missing'], [f.instances, 'test', 'offline-node', 'primary'],
    [f.instances, 'foreign', 'local-node', 'primary'], [removed, 'test', 'local-node', 'primary'],
  ]) {
    const owner = { agentId, executionLocation: { nodeId, instanceId, workspaceId: 'project' } };
    let failure;
    try { directory.nativeForkFor(owner); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'NODE_UNAVAILABLE' });
  }
  expect(f.primary.integration.settings.parse).not.toHaveBeenCalled();
});
