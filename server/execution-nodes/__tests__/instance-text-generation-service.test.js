import { afterEach, expect, mock, test } from 'bun:test';
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

test.each(['same-node', 'same-instance-id'])('text generation isolates %s and uses only its declared facet', async (placement) => {
  const f = await fixture();
  const profiles = ['primary', 'secondary'];
  const references = profiles.map((profile) => ({
    nodeId: placement === 'same-node' ? 'local-node' : `${profile}-node`,
    instanceId: placement === 'same-node' ? profile : 'profile',
  }));
  const directory = new AgentInstanceDirectory(profiles.map((profile, index) => {
    f[profile].integration.textGeneration = { run: mock(async () => `${profile} text`) };
    f[profile].integration.singleQuery = { run: mock(async () => { throw new Error('Unexpected one-shot fallback'); }) };
    return {
      configuration: {
        id: references[index].instanceId, nodeId: references[index].nodeId, agentId: 'test',
        label: profile, storageNamespace: `instances/${profile}`, default: index === 0, removedAt: null,
      },
      integration: f[profile].integration,
    };
  }));
  const services = references.map((reference) => directory.textGenerationForInstance(reference));
  expect(services[0]).not.toBe(services[1]);
  for (const [index, profile] of profiles.entries()) {
    const service = services[index];
    expect(directory.textGenerationForInstance(structuredClone(references[index]))).toBe(service);
    expect(f[profile].integration.settings.parse).not.toHaveBeenCalled();
    expect(await service.run({
      prompt: 'Synthetic prompt', timeoutMs: 4_000,
      configuration: { model: 'synthetic-model', settings: null, endpoint: null },
    }, new AbortController().signal)).toBe(`${profile} text`);
    expect(f[profile].integration.textGeneration.run).toHaveBeenCalledTimes(1);
    expect(f[profile].integration.textGeneration.run).toHaveBeenCalledWith(expect.objectContaining({
      settings: { ownerId: 'test', schemaVersion: 1, values: { parsedBy: profile } },
    }));
    expect(f[profile].integration.singleQuery.run).not.toHaveBeenCalled();
  }
});

test.each([false, true])('tool-free capability cannot be inferred from the one-shot permission flag: %s', async (unsafe) => {
  const f = await fixture();
  f.primary.integration.textGeneration = { run: mock(async () => 'Primary only') };
  f.secondary.integration.singleQuery = { run: mock(async () => 'Not tool-free'), ...(unsafe ? { runsToolsWithoutPermission: true } : {}) };
  expect(f.instances.textGenerationForInstance({ nodeId: 'local-node', instanceId: 'primary' })).not.toBeNull();
  expect(f.instances.textGenerationForInstance({ nodeId: 'local-node', instanceId: 'secondary' })).toBeNull();
  expect(f.secondary.integration.singleQuery.run).not.toHaveBeenCalled();
});

test('missing and removed targets reject before capability absence without a default fallback', async () => {
  const f = await fixture();
  const removed = new AgentInstanceDirectory([{
    configuration: {
      nodeId: 'local-node', id: 'primary', agentId: 'test', label: 'Removed',
      storageNamespace: 'instances/primary', default: true, removedAt: '2026-09-10T00:00:00.000Z',
    },
    integration: f.primary.integration,
  }]);
  for (const [directory, nodeId, instanceId] of [
    [f.instances, 'local-node', 'missing'], [f.instances, 'offline-node', 'primary'],
    [removed, 'local-node', 'primary'],
  ]) {
    expect(() => directory.textGenerationForInstance({ nodeId, instanceId })).toThrow('Execution instance unavailable');
  }
});
