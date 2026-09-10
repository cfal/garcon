import { expect, test, mock } from 'bun:test';
import { LocalExecutionPlacement } from '../local-placement.js';
import { testExecutionLocation } from '../testing/placement.js';

test('cancelled placement never returns a target or starts a later registry admission', async () => {
  const controller = new AbortController();
  const nodes = { prepareLocalTargets: mock(async () => [testExecutionLocation()]) };
  const placements = new LocalExecutionPlacement(nodes);
  controller.abort(new Error('synthetic cancellation'));
  await expect(placements.prepare('test', '/repo', controller.signal)).rejects.toThrow('synthetic cancellation');
  expect(nodes.prepareLocalTargets).not.toHaveBeenCalled();
});

test('cancellation during target persistence rejects the completed placement', async () => {
  const controller = new AbortController();
  const nodes = { prepareLocalTargets: mock(async () => {
    controller.abort(new Error('synthetic cancellation'));
    return [testExecutionLocation()];
  }) };
  const placements = new LocalExecutionPlacement(nodes);
  await expect(placements.prepare('test', '/repo', controller.signal)).rejects.toThrow('synthetic cancellation');
  expect(nodes.prepareLocalTargets).toHaveBeenCalledTimes(1);
});

function fixture() {
  const source = { agentId: 'test', projectPath: '/repo', executionLocation: testExecutionLocation() };
  const resolved = { instance: { default: true }, workspace: { projectPath: '/repo' } };
  const nodes = {
    localNodeId: source.executionLocation.nodeId,
    requireLocation: mock(() => resolved),
    prepareLocalTargets: mock(async () => [{
      ...source.executionLocation, instanceId: 'target-default', workspaceId: 'target-workspace',
    }]),
  };
  return { source, resolved, nodes, placements: new LocalExecutionPlacement(nodes) };
}

test.each(['remote-node', 'nondefault-profile', 'project-mismatch'])('rejects unavailable placement: %s', (kind) => {
  const f = fixture();
  if (kind === 'remote-node') f.source.executionLocation.nodeId = 'remote-node';
  if (kind === 'nondefault-profile') f.resolved.instance.default = false;
  if (kind === 'project-mismatch') f.source.projectPath = '/drifted-project';
  expect(() => f.placements.assertAvailable(f.source)).toThrow(expect.objectContaining({
    code: 'NODE_UNAVAILABLE',
    ...(kind === 'project-mismatch' ? { message: 'The chat project does not match its registered execution workspace.' } : {}),
  }));
  expect(f.nodes.requireLocation).toHaveBeenCalledWith(f.source.executionLocation, 'test');
});

test('relocation keeps the source instance while registering the new workspace', async () => {
  const f = fixture();
  expect(await f.placements.prepareRelocation(f.source, '/new-repo')).toEqual({
    ...f.source.executionLocation, workspaceId: 'target-workspace',
  });
  expect(f.nodes.prepareLocalTargets).toHaveBeenCalledWith([{ agentId: 'test', projectPath: '/new-repo' }]);
});

test('handoff refuses an unavailable source before preparing a target', async () => {
  const f = fixture();
  f.resolved.instance.default = false;
  await expect(f.placements.prepareHandoff(f.source, 'next-provider')).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  expect(f.nodes.prepareLocalTargets).not.toHaveBeenCalled();
});
