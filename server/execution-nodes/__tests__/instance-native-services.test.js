import { afterEach, expect, mock, test } from 'bun:test';
import { AgentInstanceDirectory } from '../../agents/instance-directory.js';
import { createLocatedInstanceFixture, LOCATED_CHATS } from '../../agents/__tests__/located-instance-fixture.js';
import { NativeTranscriptActivityService } from '../../ledger/native-activity.js';

const fixtures = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose();
});

async function fixture() {
  const f = await createLocatedInstanceFixture();
  fixtures.push(f);
  return f;
}

test('native service caches qualify both node and instance while preserving null activity', async () => {
  const f = await fixture();
  const entries = ['primary', 'secondary'].map((profile) => ({
    configuration: { id: 'profile', nodeId: `${profile}-node`, agentId: 'test', label: profile,
      storageNamespace: 'instances/profile', default: true, removedAt: null },
    integration: f[profile].integration,
  }));
  const directory = new AgentInstanceDirectory(entries);
  const ports = [];
  for (const profile of ['primary', 'secondary']) {
    const owner = { agentId: 'test', executionLocation: {
      nodeId: `${profile}-node`, instanceId: 'profile', workspaceId: 'project',
    } };
    expect(directory.nativeActivityFor(owner)).toBeNull();
    f[profile].integration.nativeActivity = { lastActivity: mock(async () => ({ kind: 'unavailable' })) };
    const sessions = directory.nativeSessionsFor(owner);
    const activity = directory.nativeActivityFor(owner);
    expect(directory.nativeSessionsFor(structuredClone(owner))).toBe(sessions);
    expect(directory.nativeActivityFor(structuredClone(owner))).toBe(activity);
    await activity.lastActivity({ ownerId: 'test', schemaVersion: 1, value: {} }, new AbortController().signal);
    expect(f[profile].integration.nativeActivity.lastActivity).toHaveBeenCalledTimes(1);
    ports.push({ sessions, activity });
  }
  expect(ports[0].sessions).not.toBe(ports[1].sessions);
  expect(ports[0].activity).not.toBe(ports[1].activity);
});

test('native service selection refuses missing, removed and provider-mismatched owners without fallback', async () => {
  const f = await fixture();
  const removed = new AgentInstanceDirectory([{
    configuration: { id: 'primary', nodeId: 'local-node', agentId: 'test', label: 'Removed',
      storageNamespace: 'instances/primary', default: true, removedAt: '2026-09-10T00:00:00.000Z' },
    integration: f.primary.integration,
  }]);
  for (const [directory, agentId, nodeId, instanceId] of [
    [f.instances, 'test', 'local-node', 'missing'], [f.instances, 'test', 'offline-node', 'primary'],
    [f.instances, 'other-provider', 'local-node', 'primary'], [removed, 'test', 'local-node', 'primary'],
  ]) {
    const owner = { agentId, executionLocation: { nodeId, instanceId, workspaceId: 'project' } };
    for (const method of ['nativeSessionsFor', 'nativeActivityFor']) {
      let failure;
      try { directory[method](owner); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'NODE_UNAVAILABLE' });
    }
  }
  expect(f.primary.integration.nativeSessions.resolveNativeSession).not.toHaveBeenCalled();
});

test.each(['resolveNativeSession', 'describeTranscriptSource'])('%s forwards the read signal and fences cancellation at port handoff', async (method) => {
  const f = await fixture();
  const controller = new AbortController();
  const returned = Promise.withResolvers();
  const cancellation = new Error('Synthetic native port cancellation');
  void returned.promise.then(() => controller.abort(cancellation));
  /** @satisfies {import('../provider-native-sessions.js').ProviderNativeSessionService} */
  const sessions = { resolve: mock(() => returned.promise), describe: mock(() => returned.promise), release: async () => {} };
  f.instances.nativeSessionsFor = mock(() => sessions);
  const chatId = LOCATED_CHATS.secondary;
  const entry = f.chats.getChat(chatId);
  const nativeSession = structuredClone(entry.nativeSession);
  const pending = f.agents[method](entry, chatId, controller.signal);
  entry.agentId = 'changed-provider';
  entry.executionLocation.instanceId = 'changed-profile';
  entry.nativeSession.value.id = 'changed-session';
  returned.resolve(method === 'resolveNativeSession' ? null : { kind: 'provider-reference', value: 'secondary/native' });
  await expect(pending).rejects.toBe(cancellation);
  const portMethod = method === 'resolveNativeSession' ? 'resolve' : 'describe';
  expect(sessions[portMethod].mock.calls[0][1]).toBe(controller.signal);
  expect(sessions[portMethod].mock.calls[0][0].chat).toMatchObject({ agentId: 'test', nativeSession });
  await expect(f.agents[method](entry, chatId, controller.signal)).rejects.toBe(cancellation);
  expect(f.instances.nativeSessionsFor).toHaveBeenCalledTimes(1);
});

test('the activation probe uses only the saved same-provider instance without changing the ledger', async () => {
  const f = await fixture();
  const chatId = LOCATED_CHATS.secondary;
  await f.adoption.ensure(chatId);
  const before = f.ledger.currentRows(chatId);
  const notified = Promise.withResolvers();
  f.primary.integration.nativeActivity = { lastActivity: mock(async () => ({ kind: 'unavailable' })) };
  f.secondary.integration.nativeActivity = { lastActivity: mock(async () => ({ kind: 'ready', value: { lastEntryAt: '2099-01-01T00:00:00.000Z' } })) };
  const activity = new NativeTranscriptActivityService({
    ledger: f.ledger, registry: f.chats, instances: f.instances, ownsExecution: () => false,
    notifyOperationalNotice: (...args) => notified.resolve(args),
  });
  activity.requestCheck(chatId, 'activation');
  expect((await notified.promise)[0]).toBe(chatId);
  expect(f.primary.integration.nativeActivity.lastActivity).not.toHaveBeenCalled();
  expect(f.secondary.integration.nativeActivity.lastActivity).toHaveBeenCalledTimes(1);
  expect(f.ledger.currentRows(chatId)).toEqual(before);
});
