import { afterEach, expect, mock, test } from 'bun:test';
import { createLocalProviderInstances } from '../../execution-node/local-provider-instance.js';
import { AgentInstanceDirectory } from '../../agents/instance-directory.js';
import { createLocatedInstanceFixture } from '../../agents/__tests__/located-instance-fixture.js';

const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function fixture() {
  const result = await createLocatedInstanceFixture();
  fixtures.push(result);
  return result;
}

test.each(['same-node', 'same-instance-id'])('one-shot services isolate %s with independent settings and permission declarations', async (placement) => {
  const f = await fixture();
  const profiles = ['primary', 'secondary'];
  const references = profiles.map((profile) => ({
    nodeId: placement === 'same-node' ? 'local-node' : `${profile}-node`,
    instanceId: placement === 'same-node' ? profile : 'profile',
  }));
  const directory = new AgentInstanceDirectory(createLocalProviderInstances(profiles.map((profile, index) => {
    f[profile].integration.singleQuery = {
      ...(profile === 'secondary' ? { runsToolsWithoutPermission: true } : {}),
      run: mock(async () => `${profile} response`),
    };
    return {
      configuration: {
        id: references[index].instanceId, nodeId: references[index].nodeId, agentId: 'test',
        label: profile, storageNamespace: `instances/${profile}`, default: index === 0, removedAt: null,
      },
      integration: f[profile].integration,
    };
  })));
  const services = references.map((reference) => directory.singleQueryForInstance(reference));
  expect(services[0]).not.toBe(services[1]);
  for (const [index, profile] of profiles.entries()) {
    const service = services[index];
    expect(directory.singleQueryForInstance(structuredClone(references[index]))).toBe(service);
    expect(service.runsToolsWithoutPermission).toBe(profile === 'secondary');
    expect(f[profile].integration.settings.parse).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    expect(await service.run({
      prompt: 'Synthetic prompt', projectPath: '/synthetic/project',
      configuration: { model: 'synthetic-model', settings: null, endpoint: null },
    }, signal)).toBe(`${profile} response`);
    expect(f[profile].integration.singleQuery.run).toHaveBeenCalledOnce();
    expect(f[profile].integration.singleQuery.run).toHaveBeenCalledWith(expect.objectContaining({
      signal, settings: { ownerId: 'test', schemaVersion: 1, values: { parsedBy: profile } },
    }));
  }
});

test.each([false, true])('a null one-shot capability never borrows another instance (primary available: %s)', async (available) => {
  const f = await fixture();
  f.primary.integration.singleQuery = available ? { run: mock(async () => 'unused') } : null;
  expect(f.instances.singleQueryForInstance({ nodeId: 'local-node', instanceId: 'secondary' })).toBeNull();
  const primary = f.instances.singleQueryForInstance({ nodeId: 'local-node', instanceId: 'primary' });
  expect(primary === null).toBe(!available);
  expect(f.primary.integration.settings.parse).not.toHaveBeenCalled();
  expect(f.secondary.integration.settings.parse).not.toHaveBeenCalled();
});

test.each([null, false, true])('the registry reads the tool policy from the selected service: %s', async (policy) => {
  const f = await fixture();
  const run = mock(async () => 'unused');
  f.instances.singleQueryForInstance = mock(() => policy === null ? null : {
    runsToolsWithoutPermission: policy, run,
  });
  expect(f.agents.singleQueryRunsToolsWithoutPermission('test')).toBe(policy ?? false);
  expect(f.instances.singleQueryForInstance).toHaveBeenCalledWith({ nodeId: 'local-node', instanceId: 'primary' });
  expect(run).not.toHaveBeenCalled();
  expect(f.primary.integration.settings.parse).not.toHaveBeenCalled();
});

test('unavailable and removed instances reject before checking capability absence', async () => {
  const f = await fixture();
  const removed = new AgentInstanceDirectory(createLocalProviderInstances([{
    configuration: {
      nodeId: 'local-node', id: 'primary', agentId: 'test', label: 'Removed',
      storageNamespace: 'instances/primary', default: true, removedAt: '2026-09-10T00:00:00.000Z',
    },
    integration: f.primary.integration,
  }]));
  for (const [directory, nodeId, instanceId] of [
    [f.instances, 'local-node', 'missing'], [f.instances, 'offline-node', 'primary'],
    [removed, 'local-node', 'primary'],
  ]) {
    let failure;
    try { directory.singleQueryForInstance({ nodeId, instanceId }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'NODE_UNAVAILABLE' });
  }
  expect(f.primary.integration.settings.parse).not.toHaveBeenCalled();
});
