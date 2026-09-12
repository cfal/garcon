import { expect, mock, test } from 'bun:test';
import type { ProjectResolution } from '@garcon/common/project-resolution';
import type { ProviderExecutionService } from '../../execution-nodes/provider-execution.js';
import { MAX_NODE_EXECUTION_RESOURCES, NodeExecutionResources, type NodeExecutionResource } from '../execution-resources.js';

function resource(overrides: Partial<NodeExecutionResource> = {}): NodeExecutionResource {
  const execution = {
    async prepare() { throw new Error('Execution must not begin during resource resolution'); },
    async dispatch() {}, release() {}, async abort() { return false; },
    async prepareSteer() { return { kind: 'unsupported' as const }; }, async steer() { return { kind: 'accepted' as const }; },
    async submitGoalControl() { return false; },
  } satisfies ProviderExecutionService;
  return {
    location: { nodeId: 'synthetic-node', instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' },
    projectPath: '/synthetic/project-alias', execution,
    files: { inspectProject: mock(async () => ({ kind: 'available' as const, effectiveProjectKey: '/synthetic/project' })) },
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

test('resolves only the registered project on the selected instance', async () => {
  const directory = new NodeExecutionResources('synthetic-node');
  const first = resource();
  const second = resource({ location: { ...first.location, instanceId: 'second-instance' } });
  directory.register(first);
  directory.register(second);
  const prepared = await directory.prepare(second.location, signal());
  expect(prepared.execution).toBe(second.execution);
  expect(prepared.projectPath).toBe('/synthetic/project');
  expect(second.files.inspectProject).toHaveBeenCalledWith('/synthetic/project-alias', expect.any(AbortSignal));
  expect(first.files.inspectProject).not.toHaveBeenCalled();
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(Object.isFrozen(prepared.location)).toBe(true);
});

test('captures registration independently of mutable caller objects', async () => {
  const directory = new NodeExecutionResources('synthetic-node');
  const input = resource();
  const location = { ...input.location };
  directory.register(input);
  Object.assign(input, { projectPath: '/synthetic/other' });
  Object.assign(input.location, { workspaceId: 'changed-workspace' });
  const prepared = await directory.prepare(location, signal());
  expect(input.files.inspectProject).toHaveBeenCalledWith('/synthetic/project-alias', expect.any(AbortSignal));
  expect(prepared.location).toEqual(location);
});

test.each(['nodeId', 'instanceId', 'workspaceId'] as const)('rejects unknown %s without resource I/O', async (field) => {
  const directory = new NodeExecutionResources('synthetic-node');
  const input = resource();
  directory.register(input);
  await expect(directory.prepare({ ...input.location, [field]: 'foreign' }, signal())).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  expect(input.files.inspectProject).not.toHaveBeenCalled();
});

test('rejects request paths outside the closed identity contract', async () => {
  const directory = new NodeExecutionResources('synthetic-node');
  const input = resource();
  directory.register(input);
  const malformed = { ...input.location, projectPath: '/synthetic/other' };
  await expect(directory.prepare(malformed, signal())).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  expect(input.files.inspectProject).not.toHaveBeenCalled();
});

test('regranting a resource never reactivates a retired preparation', async () => {
  const directory = new NodeExecutionResources('synthetic-node');
  const input = resource();
  directory.register(input);
  const retired = await directory.prepare(input.location, signal());
  directory.revoke(input.location);
  expect(retired.signal.aborted).toBe(true);
  expect(() => retired.validate()).toThrow();
  directory.register(input);
  const current = await directory.prepare(input.location, signal());
  expect(current.signal.aborted).toBe(false);
  expect(() => current.validate()).not.toThrow();
  expect(() => retired.validate()).toThrow();
  expect(() => directory.register(input)).toThrow('already registered');
  directory.revoke(input.location);
  expect(() => directory.register({ ...input, projectPath: '/synthetic/other' })).toThrow('cannot be rebound');
});

test.each(['caller', 'grant', 'close'] as const)('rejects %s cancellation during project validation', async (kind) => {
  const pending = Promise.withResolvers<ProjectResolution>();
  const files = { inspectProject: mock(() => pending.promise) };
  const input = resource({ files });
  const directory = new NodeExecutionResources('synthetic-node');
  directory.register(input);
  const controller = new AbortController();
  const prepared = directory.prepare(input.location, controller.signal);
  const failure = new Error('synthetic preparation cancellation');
  if (kind === 'caller') controller.abort(failure);
  else if (kind === 'grant') directory.revoke(input.location);
  else directory.close();
  pending.resolve({ kind: 'available', effectiveProjectKey: '/synthetic/project' });
  if (kind === 'caller') await expect(prepared).rejects.toBe(failure);
  else await expect(prepared).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
});

test('preparation caller cancellation does not retire the installed resource grant', async () => {
  const directory = new NodeExecutionResources('synthetic-node');
  const input = resource();
  directory.register(input);
  const controller = new AbortController();
  const prepared = await directory.prepare(input.location, controller.signal);
  controller.abort();
  expect(prepared.signal.aborted).toBe(false);
  expect(() => prepared.validate()).not.toThrow();
  directory.close();
  expect(prepared.signal.aborted).toBe(true);
  expect(() => directory.register(input)).toThrow();
});

test('unavailable project validation never falls back to another registered workspace', async () => {
  const directory = new NodeExecutionResources('synthetic-node');
  const input = resource({ files: { inspectProject: async () => ({ kind: 'unavailable', reason: 'not-found' }) } });
  const other = resource({ location: { ...input.location, workspaceId: 'other-workspace' } });
  directory.register(input);
  directory.register(other);
  await expect(directory.prepare(input.location, signal())).rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE', reason: 'not-found' });
  expect(other.files.inspectProject).not.toHaveBeenCalled();
});

test('bounds resource identities while allowing an existing identity to be explicitly regranted', async () => {
  const directory = new NodeExecutionResources('synthetic-node');
  const input = resource();
  for (let index = 0; index < MAX_NODE_EXECUTION_RESOURCES; index += 1) {
    directory.register({ ...input, location: { ...input.location, workspaceId: `workspace-${index}` } });
  }
  expect(() => directory.register(input)).toThrow('resource limit reached');
  const first = { ...input, location: { ...input.location, workspaceId: 'workspace-0' } };
  directory.revoke(first.location);
  expect(() => directory.register(input)).toThrow('resource limit reached');
  directory.register(first);
  expect((await directory.prepare(first.location, signal())).execution).toBe(input.execution);
});
