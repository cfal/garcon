import { expect, mock, test } from 'bun:test';
import { producerStreamKey, serializeNodeOutputFrame, type NodeReplayReply, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { NodeOutputRecovery } from '../output-recovery.js';
import { NodeWorkerOutputDeliveryReceiver } from '../../execution-node/worker/output-delivery-receiver.js';
import { NodeOutputAssemblyBudget } from '../../execution-node/worker/output-budget.js';
import { serializeNodeWorkerOutputSuspension, type NodeWorkerServiceCommand, type NodeWorkerServiceResult } from '../../execution-node/worker/service-protocol.js';
import { NODE_RECOVERY_TIMEOUT_MS } from '../../execution-node/supervisor.js';
import { chunkNodeWorkerOutput } from '../../execution-node/worker/output-protocol.js';
import { serializeNodeWorkerOutputDelivery } from '../../execution-node/worker/output-delivery-protocol.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const instanceId = 'synthetic-instance';
const suspension = (generation: number, connectionId = 1) => serializeNodeWorkerOutputSuspension({
  type: 'node-worker-output-suspended', version: 1, session, connectionId, generation,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const lifetime = new AbortController(); const physical = new AbortController();
  const failed = mock((_error: unknown) => {});
  const recovering = mock(() => {}); const recovered = mock(() => {});
  const reconcile = mock(async (_signal: AbortSignal) => {});
  const positions = new Map<string, { stream: ProducerStreamIdentity; afterSequence: number }>();
  const deadlines: { fire(): void; cancel: ReturnType<typeof mock>; delay: number }[] = [];
  const receiver = new NodeWorkerOutputDeliveryReceiver({ session, instanceIds: new Set([instanceId]),
    signal: lifetime.signal, budget: new NodeOutputAssemblyBudget(100_000), now: () => 0, validate() {}, failed });
  const install = (streamId: string) => {
    const stream = { ...session, streamId };
    const position = { stream, afterSequence: 0 };
    positions.set(producerStreamKey(stream), position);
    receiver.install(instanceId, stream, lifetime.signal, (_text, sequence) => { position.afterSequence = sequence; }, failed);
    return stream;
  };
  let generation = 0;
  const call = mock(async (command: NodeWorkerServiceCommand, signal: AbortSignal): Promise<NodeWorkerServiceResult> => {
    signal.throwIfAborted();
    if (command.method === 'begin-output-recovery') return { kind: 'output-recovery', generation: ++generation };
    if (command.method === 'replay-output') return { kind: 'output-replayed', ranges: command.cursors.map((cursor) => ({
      type: 'node-replay-ready', ...cursor, throughSequence: cursor.afterSequence,
    })) };
    if (command.method === 'resume-output') return { kind: 'output-live', live: true };
    throw new Error('Unexpected synthetic recovery command');
  });
  const retireGap = mock((range: Extract<NodeReplayReply, { type: 'node-replay-gap' }>) => {
    receiver.retire(range.stream); positions.delete(producerStreamKey(range.stream));
  });
  const options = { session, connectionId: 1, signal: physical.signal, receiver, service: { call },
    cursors: () => [...positions.values()].map((cursor) => ({ ...cursor })), retireGap, reconcile, recovering, recovered, failed,
    validate() { physical.signal.throwIfAborted(); },
    scheduleTimeout(fire: () => void, delay: number) {
      const timer = { fire, delay, cancel: mock(() => {}) }; deadlines.push(timer); return timer;
    } };
  const recovery = new NodeOutputRecovery(options);
  return { recovery, options, receiver, lifetime, physical, call, positions, install, failed, recovering, recovered, reconcile, retireGap, deadlines,
    close() { recovery.close(); physical.abort(); lifetime.abort(); receiver.close(); } };
}

test('recovery coalesces triggers and reconciles before releasing its admission gate', async () => {
  const f = fixture(); f.install('synthetic-stream');
  const barrier = Promise.withResolvers<void>(); f.reconcile.mockImplementation(() => barrier.promise);
  try {
    const first = f.recovery.recover();
    expect(f.recovery.recover()).toBe(first);
    await tick();
    expect(f.recovering).toHaveBeenCalledTimes(1); expect(f.recovered).not.toHaveBeenCalled();
    expect(f.call.mock.calls.map(([command]) => command.method)).toEqual(['begin-output-recovery', 'replay-output']);
    barrier.resolve(); await first;
    expect(f.call.mock.calls.at(-1)?.[0].method).toBe('resume-output');
    expect(f.recovered).toHaveBeenCalledTimes(1); expect(f.failed).not.toHaveBeenCalled();
    expect(f.deadlines).toHaveLength(1); expect(f.deadlines[0]?.delay).toBe(NODE_RECOVERY_TIMEOUT_MS);
    expect(f.deadlines[0]?.cancel).toHaveBeenCalledTimes(1);
  } finally { barrier.resolve(); f.close(); }
});

test('replay transmission cannot reconcile or release admission before controller acceptance through its watermark', async () => {
  const f = fixture(); const stream = f.install('synthetic-watermark');
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (command, signal) => command.method === 'replay-output'
    ? { kind: 'output-replayed', ranges: [{ type: 'node-replay-ready', stream, afterSequence: 0, throughSequence: 2 }] }
    : original(command, signal));
  const receive = (sequence: number) => {
    const serialized = serializeNodeOutputFrame({ type: 'node-output', stream, sequence,
      event: { type: 'notice', runId: 'synthetic-run', content: 'synthetic output' } });
    for (const payload of chunkNodeWorkerOutput(instanceId, serialized)) {
      f.receiver.receive(serializeNodeWorkerOutputDelivery({ type: 'node-worker-output-delivery', version: 1,
        session, connectionId: 1, generation: 1, payload }));
    }
  };
  try {
    const recovering = f.recovery.recover();
    await tick();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.recovered).not.toHaveBeenCalled();
    receive(1); await tick();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.recovered).not.toHaveBeenCalled();
    receive(2); await recovering;
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.recovered).toHaveBeenCalledTimes(1);
    expect(f.options.cursors()).toEqual([{ stream, afterSequence: 2 }]);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('recovery batches every owned stream and repeats from current cursors when live output advances', async () => {
  const f = fixture(); for (let i = 0; i < 257; i++) f.install(`synthetic-${i}`);
  const original = f.call.getMockImplementation()!;
  let resumes = 0;
  f.call.mockImplementation(async (command, signal) => command.method === 'resume-output'
    ? { kind: 'output-live', live: ++resumes === 2 } : original(command, signal));
  try {
    await f.recovery.recover();
    expect(f.call.mock.calls.flatMap(([command]) => command.method === 'replay-output' ? [command.cursors.length] : []))
      .toEqual([256, 1, 256, 1]);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(f.recovered).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('a replay gap retires only that stream before the reconciled sibling returns live', async () => {
  const f = fixture(); const stream = f.install('synthetic-gap'); const sibling = f.install('synthetic-sibling');
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (command, signal) => command.method === 'replay-output'
    ? { kind: 'output-replayed', ranges: [{ type: 'node-replay-gap', stream, requestedAfter: 0,
      firstRetainedSequence: 2, lastProducedSequence: 1 }, { type: 'node-replay-ready', stream: sibling, afterSequence: 0, throughSequence: 0 }] }
    : original(command, signal));
  f.reconcile.mockImplementation(async () => { expect(f.retireGap).toHaveBeenCalledTimes(1); });
  try {
    await f.recovery.recover();
    expect(f.options.cursors()).toEqual([{ stream: sibling, afterSequence: 0 }]);
    expect(f.recovered).toHaveBeenCalledTimes(1); expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('suspension overtaking the begin reply opens a new generation under the original deadline', async () => {
  const f = fixture(); f.install('synthetic-stream');
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (command, signal) => {
    const result = await original(command, signal);
    if (result.kind === 'output-recovery' && result.generation === 1) {
      f.recovery.receiveSuspension(suspension(1)); f.recovery.receiveSuspension(suspension(1));
    }
    return result;
  });
  try {
    await f.recovery.recover();
    expect(f.call.mock.calls.map(([command]) => command.method)).toEqual([
      'begin-output-recovery', 'begin-output-recovery', 'replay-output', 'resume-output',
    ]);
    expect(f.deadlines).toHaveLength(1); expect(f.recovered).toHaveBeenCalledTimes(1);
    f.recovery.receiveSuspension(suspension(1)); await tick();
    expect(f.recovering).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('suspension after live completion cannot disappear into the settling recovery promise', async () => {
  const f = fixture(); f.install('synthetic-stream');
  f.recovered.mockImplementationOnce(() => { queueMicrotask(() => f.recovery.receiveSuspension(suspension(1))); });
  try {
    await f.recovery.recover(); await tick();
    expect(f.recovering).toHaveBeenCalledTimes(2); expect(f.recovered).toHaveBeenCalledTimes(2);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('suspension cancelling replay cannot complete a stale generation or refresh its deadline', async () => {
  const f = fixture(); f.install('synthetic-stream');
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (command, signal) => {
    if (command.method === 'replay-output' && command.generation === 1) {
      f.recovery.receiveSuspension(suspension(1));
      return { kind: 'unknown' };
    }
    return original(command, signal);
  });
  try {
    await f.recovery.recover();
    expect(f.call.mock.calls.filter(([command]) => command.method === 'resume-output').map(([command]) => command))
      .toEqual([{ method: 'resume-output', generation: 2 }]);
    expect(f.deadlines).toHaveLength(1); expect(f.recovered).toHaveBeenCalledTimes(1);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('a lost begin reply fails once without retrying or releasing admission', async () => {
  const f = fixture(); f.call.mockResolvedValue({ kind: 'unknown' });
  try {
    await expect(f.recovery.recover()).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
    expect(f.call).toHaveBeenCalledTimes(1); expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.recovered).not.toHaveBeenCalled();
    expect(() => f.recovery.receiveSuspension(suspension(1))).not.toThrow();
    expect(f.failed).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('the absolute deadline aborts reconciliation and never releases its gate', async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  f.reconcile.mockImplementation((signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started.resolve();
  }));
  try {
    const pending = f.recovery.recover(); await started.promise;
    f.deadlines[0]!.fire();
    await expect(pending).rejects.toMatchObject({ code: 'NODE_WORKER_TIMEOUT' });
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.recovered).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('the original recovery deadline expires an unaccepted watermark without starting reconciliation', async () => {
  const f = fixture(); const stream = f.install('synthetic-watermark-timeout');
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (command, signal) => command.method === 'replay-output'
    ? { kind: 'output-replayed', ranges: [{ type: 'node-replay-ready', stream, afterSequence: 0, throughSequence: 1 }] }
    : original(command, signal));
  try {
    const pending = f.recovery.recover(); await tick();
    expect(f.reconcile).not.toHaveBeenCalled();
    f.deadlines[0]!.fire();
    await expect(pending).rejects.toMatchObject({ code: 'NODE_WORKER_TIMEOUT' });
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.recovered).not.toHaveBeenCalled();
    expect(f.deadlines).toHaveLength(1);
  } finally { f.close(); }
});

test('a noncooperative reconciler cannot hold recovery open past the deadline or reopen it afterwards', async () => {
  const f = fixture(); const barrier = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  f.reconcile.mockImplementation(() => { started.resolve(); return barrier.promise; });
  try {
    const pending = f.recovery.recover(); await started.promise;
    f.deadlines[0]!.fire();
    await expect(pending).rejects.toMatchObject({ code: 'NODE_WORKER_TIMEOUT' });
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.recovered).not.toHaveBeenCalled();
    barrier.resolve(); await tick();
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.recovered).not.toHaveBeenCalled();
  } finally { barrier.resolve(); f.close(); }
});

test('a stale connection close and its suspension cannot retire a replacement attempt', async () => {
  const f = fixture(); f.install('synthetic-stream');
  const physical = new AbortController();
  const replacement = new NodeOutputRecovery({ ...f.options, signal: physical.signal, connectionId: 2, validate() {} });
  try {
    await f.recovery.recover(); await replacement.recover();
    f.physical.abort();
    replacement.receiveSuspension(suspension(1, 1));
    await tick();
    expect(f.recovered).toHaveBeenCalledTimes(2); expect(f.failed).not.toHaveBeenCalled();
    replacement.receiveSuspension(suspension(2, 2)); await tick();
    expect(f.recovered).toHaveBeenCalledTimes(3);
  } finally { replacement.close(); physical.abort(); f.close(); }
});

test('queued suspension after explicit closure is inert', async () => {
  const f = fixture();
  try {
    await f.recovery.recover();
    f.recovery.close();
    expect(() => f.recovery.receiveSuspension(suspension(1))).not.toThrow();
    expect(f.recovering).toHaveBeenCalledTimes(1);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});
