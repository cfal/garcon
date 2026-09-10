import { afterEach, expect, test } from 'bun:test';
import { AgentInstanceDirectory } from '../../agents/instance-directory.js';
import { createProviderAuthFixture } from '../../agents/__tests__/provider-auth-fixture.js';
import { LOCATED_CHATS } from '../../agents/__tests__/located-instance-fixture.js';

const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function fixture() {
  const f = await createProviderAuthFixture();
  fixtures.push(f);
  return f;
}

test('binds and memoizes auth and commands by exact instance without sharing same-provider state', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const ports = [];
  for (const profile of ['primary', 'secondary']) {
    const ref = { nodeId: 'local-node', instanceId: profile };
    const auth = f.instances.authForInstance(ref);
    const commands = f.instances.commandsForInstance(ref);
    expect(f.instances.authForInstance({ ...ref })).toBe(auth);
    expect(f.instances.commandsForInstance({ ...ref })).toBe(commands);
    expect(await auth.status(signal)).toMatchObject({ label: profile });
    expect(await commands.discover({ projectPath: f.root }, signal)).toEqual([
      { name: `${profile}-command`, source: 'command' },
    ]);
    ports.push({ auth, commands });
  }
  expect(ports[0].auth).not.toBe(ports[1].auth);
  expect(ports[0].commands).not.toBe(ports[1].commands);
  await ports[1].auth.launchLogin();
  await ports[1].auth.completeLogin({ sessionId: 'colliding-session', code: 'synthetic-code' });
  expect(f.primary.integration.auth.launchLogin).not.toHaveBeenCalled();
  expect(f.primary.integration.auth.completeLogin).not.toHaveBeenCalled();
  expect(f.secondary.integration.auth.completeLogin).toHaveBeenCalledWith('colliding-session', 'synthetic-code');
});

test('the same instance ID on different nodes cannot share a cached auth or commands service', async () => {
  const f = await fixture();
  const entries = ['primary', 'secondary'].map((profile) => ({
    configuration: {
      id: 'profile', nodeId: `${profile}-node`, agentId: 'test', label: profile,
      storageNamespace: 'instances/profile', default: true, removedAt: null,
    },
    integration: f[profile].integration,
  }));
  const directory = new AgentInstanceDirectory(entries);
  const signal = new AbortController().signal;
  for (const profile of ['primary', 'secondary']) {
    const ref = { nodeId: `${profile}-node`, instanceId: 'profile' };
    expect(await directory.authForInstance(ref).status(signal)).toMatchObject({ label: profile });
    expect(await directory.commandsForInstance(ref).discover({ projectPath: f.root }, signal)).toEqual([
      { name: `${profile}-command`, source: 'command' },
    ]);
  }
});

test('missing and removed instances refuse service acquisition without borrowing a default', async () => {
  const f = await fixture();
  const removed = new AgentInstanceDirectory([{
    configuration: {
      id: 'primary', nodeId: 'local-node', agentId: 'test', label: 'Removed',
      storageNamespace: 'instances/primary', default: true, removedAt: '2026-09-10T00:00:00.000Z',
    },
    integration: f.primary.integration,
  }]);
  for (const [directory, ref] of [
    [f.instances, { nodeId: 'local-node', instanceId: 'missing' }],
    [f.instances, { nodeId: 'offline', instanceId: 'primary' }],
    [removed, { nodeId: 'local-node', instanceId: 'primary' }],
  ]) {
    for (const method of ['authForInstance', 'commandsForInstance']) {
      let failure;
      try { directory[method](ref); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'NODE_UNAVAILABLE' });
    }
  }
  expect(f.primary.integration.auth.status).not.toHaveBeenCalled();
  expect(f.primary.integration.commands.discover).not.toHaveBeenCalled();
});

test.each(['chat', 'default'])('%s command discovery checks cancellation after port delivery', async (target) => {
  const f = await fixture();
  const controller = new AbortController();
  const response = Promise.withResolvers();
  const cancellation = new Error('Synthetic command cancellation');
  void response.promise.then(() => controller.abort(cancellation));
  /** @satisfies {import('../provider-commands.js').ProviderCommandsService} */
  const commands = { discover: () => response.promise };
  f.instances.commandsForInstance = () => commands;
  const pending = target === 'chat'
    ? f.agents.getChatSlashCommands(f.chats.getChat(LOCATED_CHATS.secondary), 'test', controller.signal)
    : f.agents.getDefaultSlashCommands('test', f.root, controller.signal);
  response.resolve([{ name: 'stale-command', source: 'command' }]);
  await expect(pending).rejects.toBe(cancellation);
});
