import { expect, mock, test } from 'bun:test';
import { NodeWorkerServiceClient, NodeWorkerServiceServer } from '../../execution-node/worker/service-channel.js';
import { NODE_WORKER_SERVICE_LIMITS, NODE_WORKER_WRITER_LIMITS } from '../../execution-node/worker/limits.js';
import { parseNodeWorkerServiceText, type NodeWorkerServiceCommand, type NodeWorkerServiceResult } from '../../execution-node/worker/service-protocol.js';
import { NodeWorkerWriter } from '../../execution-node/worker/writer.js';
import { RemoteProviderCommandsService } from '../remote-provider-commands.js';

function fixture() {
  const physical = new AbortController();
  const failed = mock((error: unknown) => physical.abort(error));
  const options = { session: { controllerBootId: 'controller-boot', nodeBootId: 'node-boot', logicalSessionId: 'session' },
    connectionId: 1, signal: physical.signal, validate() {}, failed };
  const writerOptions = { ...NODE_WORKER_WRITER_LIMITS, signal: physical.signal,
    failed(error: unknown) { if (!physical.signal.aborted) failed(error); } };
  const execute = mock(async (command: NodeWorkerServiceCommand, _signal: AbortSignal): Promise<NodeWorkerServiceResult> =>
    command.method === 'provider-commands' ? { kind: 'provider-commands', instanceId: command.instanceId, workspaceId: command.workspaceId,
      commands: [{ name: `${command.instanceId}-${command.workspaceId}`, source: 'skill' }] } : { kind: 'output-recovery', generation: 1 });
  let alter: (result: NodeWorkerServiceResult) => NodeWorkerServiceResult = (result) => result;
  const requests = new NodeWorkerWriter({ async write(bytes) {
    const frame = parseNodeWorkerServiceText(Buffer.from(bytes.subarray(4)).toString());
    if (!frame) throw new Error('Invalid synthetic commands request');
    server.receive(frame);
  }, close() {} }, writerOptions);
  const replies = new NodeWorkerWriter({ async write(bytes) {
    const frame = parseNodeWorkerServiceText(Buffer.from(bytes.subarray(4)).toString());
    if (!frame || frame.type !== 'node-worker-service-result') throw new Error('Invalid synthetic commands reply');
    client.receive({ ...frame, result: alter(frame.result) });
  }, close() {} }, writerOptions);
  const client = new NodeWorkerServiceClient(requests, options);
  const server = new NodeWorkerServiceServer(replies, execute, options);
  const workspaceFor = mock((projectPath: string) => projectPath === '/synthetic/first'
    ? { nodeId: 'node', workspaceId: 'first-workspace' } : projectPath === '/synthetic/second'
      ? { nodeId: 'node', workspaceId: 'second-workspace' } : null);
  return { client, execute, failed, physical, workspaceFor,
    service: (instanceId: string) => new RemoteProviderCommandsService(client, { nodeId: 'node', instanceId }, workspaceFor),
    alterReply(fn: typeof alter) { alter = fn; },
    close() { physical.abort(); client.close(); server.close(); requests.close(); replies.close(); },
  };
}

const signal = () => new AbortController().signal;

test('interleaved commands use captured instance/workspace IDs without transmitting paths', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<NodeWorkerServiceResult>();
  f.execute.mockImplementationOnce(() => pending.promise);
  try {
    const request = { projectPath: '/synthetic/first' };
    const first = f.service('first-instance').discover(request, signal());
    request.projectPath = '/synthetic/second';
    expect(await f.service('second-instance').discover({ projectPath: '/synthetic/second' }, signal()))
      .toEqual([{ name: 'second-instance-second-workspace', source: 'skill' }]);
    pending.resolve({ kind: 'provider-commands', instanceId: 'first-instance', workspaceId: 'first-workspace', commands: [{ name: 'original', source: 'command' }] });
    expect(await first).toEqual([{ name: 'original', source: 'command' }]);
    expect(f.execute.mock.calls[0]?.[0]).toEqual({ method: 'provider-commands', instanceId: 'first-instance', workspaceId: 'first-workspace' });
    expect(f.failed).not.toHaveBeenCalled();
  } finally { pending.resolve({ kind: 'unknown' }); f.close(); }
});

test('missing or foreign-node workspace metadata never reaches the channel', async () => {
  const f = fixture();
  try {
    await expect(f.service('first-instance').discover({ projectPath: '/synthetic/missing' }, signal())).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    f.workspaceFor.mockReturnValueOnce({ nodeId: 'other-node', workspaceId: 'first-workspace' });
    await expect(f.service('first-instance').discover({ projectPath: '/synthetic/first' }, signal())).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    expect(f.execute).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test.each(['instanceId', 'workspaceId'] as const)('a foreign %s reply fails only the captured physical channel', async (key) => {
  const f = fixture();
  try {
    f.alterReply((result) => result.kind === 'provider-commands' ? { ...result, [key]: 'foreign' } : result);
    await expect(f.service('first-instance').discover({ projectPath: '/synthetic/first' }, signal()))
      .rejects.toMatchObject({ code: 'NODE_INCOMPATIBLE', retryable: false });
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.physical.signal.aborted).toBe(true);
  } finally { f.close(); }
});

test('project refusal uses the captured requested path and preserves its reason', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<NodeWorkerServiceResult>();
  f.execute.mockImplementationOnce(() => pending.promise);
  try {
    const request = { projectPath: '/synthetic/first' };
    const discovery = f.service('first-instance').discover(request, signal());
    request.projectPath = '/synthetic/second';
    pending.resolve({ kind: 'provider-commands-unavailable', instanceId: 'first-instance', workspaceId: 'first-workspace', reason: 'not-found' });
    await expect(discovery).rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE', reason: 'not-found', projectPath: '/synthetic/first', retryable: false });
  } finally { pending.resolve({ kind: 'unknown' }); f.close(); }
});

test('cancelled discoveries cannot deliver late data or consume control headroom', async () => {
  const f = fixture();
  const capacity = NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests;
  const started = Promise.withResolvers<void>();
  const native = Promise.withResolvers<NodeWorkerServiceResult>();
  f.execute.mockImplementation((command) => {
    if (command.method !== 'provider-commands') return Promise.resolve({ kind: 'output-recovery', generation: 1 });
    if (f.execute.mock.calls.length === capacity) started.resolve();
    return native.promise;
  });
  const caller = new AbortController();
  const reason = new Error('Synthetic command read cancellation');
  const pending = Array.from({ length: capacity }, () => f.service('first-instance').discover({ projectPath: '/synthetic/first' }, caller.signal).catch((error: unknown) => error));
  try {
    await started.promise;
    await expect(f.service('second-instance').discover({ projectPath: '/synthetic/second' }, signal())).rejects.toMatchObject({ code: 'NODE_CAPACITY', retryable: true });
    caller.abort(reason);
    expect(await Promise.all(pending)).toEqual(Array.from({ length: capacity }, () => reason));
    expect(await f.client.call({ method: 'begin-output-recovery' }, signal())).toEqual({ kind: 'output-recovery', generation: 1 });
    native.resolve({ kind: 'provider-commands', instanceId: 'first-instance', workspaceId: 'first-workspace', commands: [] });
    expect(f.physical.signal.aborted).toBe(false);
  } finally { native.resolve({ kind: 'unknown' }); f.close(); }
});

test.each(['VALIDATION_FAILED', 'NODE_CAPACITY', 'NODE_UNAVAILABLE'] as const)('classifies %s without silently returning empty commands', async (code) => {
  const f = fixture();
  try {
    f.execute.mockResolvedValueOnce({ kind: 'rejected', code });
    await expect(f.service('first-instance').discover({ projectPath: '/synthetic/first' }, signal()))
      .rejects.toMatchObject({ code: code === 'VALIDATION_FAILED' ? 'NODE_INCOMPATIBLE' : code, retryable: code !== 'VALIDATION_FAILED' });
  } finally { f.close(); }
});
