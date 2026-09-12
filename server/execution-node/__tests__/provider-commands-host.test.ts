import { expect, mock, test } from 'bun:test';
import { NodeProviderCapacity } from '../provider-capacity.js';
import type { ProjectResolution } from '../../../common/project-resolution.js';
import type { SlashCommand } from '../../../common/slash-commands.js';
import type { ProviderExecutionService } from '../../execution-nodes/provider-execution.js';
import { NodeExecutionResources } from '../execution-resources.js';
import { LocalProviderCommandsService } from '../local-provider-commands.js';
import { NodeProviderCommandsHost } from '../provider-commands-host.js';
import { NODE_WORKER_SERVICE_LIMITS } from '../worker/limits.js';

const instance = { nodeId: 'synthetic-node', instanceId: 'synthetic-instance' };
const command = { method: 'provider-commands', instanceId: instance.instanceId, workspaceId: 'synthetic-workspace' } as const;
const signal = () => new AbortController().signal;

function fixture() {
  const execution = { async prepare() { throw new Error('Unexpected execution'); }, async dispatch() {}, release() {},
    async abort() { return false; }, async prepareSteer() { return { kind: 'unsupported' as const }; },
    async steer() { return { kind: 'accepted' as const }; }, async submitGoalControl() { return false; },
  } satisfies ProviderExecutionService;
  const native = mock(async (_projectPath: string, _signal: AbortSignal): Promise<readonly SlashCommand[]> => [{ name: 'review', source: 'skill' }]);
  const inspect = mock(async (_projectPath: string): Promise<ProjectResolution> => ({ kind: 'available', effectiveProjectKey: '/synthetic/canonical' }));
  const inspectNative = mock(async (projectPath: string): Promise<ProjectResolution> => ({ kind: 'available', effectiveProjectKey: projectPath }));
  const resources = new NodeExecutionResources(instance.nodeId);
  const location = { ...instance, workspaceId: command.workspaceId };
  resources.register({ location, projectPath: '/synthetic/alias', execution, files: { inspectProject: inspect } });
  const host = new NodeProviderCommandsHost(new NodeProviderCapacity(), instance, resources, new LocalProviderCommandsService({ commands: { discover: native } }, inspectNative));
  return { host, native, inspect, inspectNative, resources, location };
}

test('discovers through the exact grant and the local adapter from the owner-canonical path', async () => {
  const f = fixture();
  try {
    expect(await f.host.discover(command, signal())).toEqual({ kind: 'provider-commands', instanceId: instance.instanceId,
      workspaceId: command.workspaceId, commands: [{ name: 'review', source: 'skill' }] });
    expect(f.inspect).toHaveBeenCalledWith('/synthetic/alias', expect.any(AbortSignal));
    expect(f.inspectNative).toHaveBeenCalledWith('/synthetic/canonical');
    expect(f.native).toHaveBeenCalledWith('/synthetic/canonical', expect.any(AbortSignal));
  } finally { f.resources.close(); }
});

test('foreign instances and uninstalled workspaces never invoke discovery or project inspection', async () => {
  const f = fixture();
  try {
    expect(await f.host.discover({ ...command, instanceId: 'foreign' }, signal())).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(await f.host.discover({ ...command, workspaceId: 'ungranted' }, signal())).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(f.native).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled();
  } finally { f.resources.close(); }
});

test('revocation during project inspection prevents provider invocation', async () => {
  const f = fixture();
  const project = Promise.withResolvers<ProjectResolution>();
  f.inspect.mockImplementationOnce(() => project.promise);
  try {
    const pending = f.host.discover(command, signal());
    f.resources.revoke(f.location);
    project.resolve({ kind: 'available', effectiveProjectKey: '/synthetic/canonical' });
    expect(await pending).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(f.native).not.toHaveBeenCalled();
  } finally { f.resources.close(); }
});

test('revocation during native discovery cancels the read and rejects its late result', async () => {
  const f = fixture();
  const started = Promise.withResolvers<AbortSignal>();
  const native = Promise.withResolvers<readonly SlashCommand[]>();
  f.native.mockImplementationOnce((_path, signal) => { started.resolve(signal); return native.promise; });
  try {
    const pending = f.host.discover(command, signal());
    const nativeSignal = await started.promise;
    f.resources.revoke(f.location);
    expect(nativeSignal.aborted).toBe(true);
    native.resolve([{ name: 'late', source: 'skill' }]);
    await expect(pending).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  } finally { native.resolve([]); f.resources.close(); }
});

test('cancelled physical reads retain all discovery slots until native settlement', async () => {
  const f = fixture();
  const capacity = NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests;
  const started = Promise.withResolvers<void>();
  const native = Promise.withResolvers<readonly SlashCommand[]>();
  f.native.mockImplementation(() => { if (f.native.mock.calls.length === capacity) started.resolve(); return native.promise; });
  const caller = new AbortController();
  const reason = new Error('Synthetic cancelled physical connection');
  const pending = Array.from({ length: capacity }, () => f.host.discover(command, caller.signal).catch((error: unknown) => error));
  try {
    await started.promise; caller.abort(reason);
    expect(await f.host.discover(command, signal())).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(f.native).toHaveBeenCalledTimes(capacity);
    native.resolve([]);
    expect(await Promise.all(pending)).toEqual(Array.from({ length: capacity }, () => reason));
    expect(await f.host.discover(command, signal())).toMatchObject({ kind: 'provider-commands', commands: [] });
    expect(f.native).toHaveBeenCalledTimes(capacity + 1);
  } finally { native.resolve([]); f.resources.close(); }
});

test('project failures preserve only their typed reason and native failures disclose no diagnostics', async () => {
  const f = fixture();
  try {
    f.inspect.mockResolvedValueOnce({ kind: 'unavailable', reason: 'not-found' });
    expect(await f.host.discover(command, signal())).toEqual({ kind: 'provider-commands-unavailable', instanceId: command.instanceId,
      workspaceId: command.workspaceId, reason: 'not-found' });
    expect(f.native).not.toHaveBeenCalled();
    f.native.mockRejectedValueOnce(new Error('Synthetic private discovery error'));
    expect(await f.host.discover(command, signal())).toEqual({ kind: 'unknown' });
    const malformed: SlashCommand = { name: 'review', source: 'skill' };
    Reflect.deleteProperty(malformed, 'name'); f.native.mockResolvedValueOnce([malformed]);
    expect(await f.host.discover(command, signal())).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
  } finally { f.resources.close(); }
});

test('an instance without command discovery still validates its workspace before returning empty', async () => {
  const f = fixture();
  const host = new NodeProviderCommandsHost(new NodeProviderCapacity(), instance, f.resources, new LocalProviderCommandsService({ commands: null }, f.inspectNative));
  try {
    expect(await host.discover(command, signal())).toMatchObject({ kind: 'provider-commands', commands: [] });
    expect(f.native).not.toHaveBeenCalled(); expect(f.inspect).toHaveBeenCalledTimes(1);
    f.resources.revoke(f.location);
    expect(await host.discover(command, signal())).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  } finally { f.resources.close(); }
});
