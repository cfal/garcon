import { expect, mock, test } from 'bun:test';
import type { AgentDispatchOutcome, AgentNativeTask } from '@garcon/server-agent-interface';
import { NodeNativeOccupancy } from '../native-occupancy.js';
import { NodeNativeTasks } from '../native-tasks.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const occupancy = new NodeNativeOccupancy(2);
  const authority = new AbortController();
  const caller = new AbortController();
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  const tasks = new NodeNativeTasks({ occupancy, signal: authority.signal, dispatchMs: 100, nativeSettlementMs: 200,
    scheduleTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return { cancel() { timer.cancelled = true; } };
    } });
  const dispatch = Promise.withResolvers<AgentDispatchOutcome>();
  const result = Promise.withResolvers<string>();
  const settled = Promise.withResolvers<void>();
  const abort = mock(async () => true);
  const contain = mock(() => {});
  const native = { dispatch: dispatch.promise, result: result.promise, settled: settled.promise, abort } satisfies AgentNativeTask<string>;
  return { occupancy, authority, caller, tasks, timers, dispatch, result, settled, abort, contain, native,
    run: () => tasks.run(() => native, caller.signal, contain),
    expire(delay: number) { for (const timer of timers) if (!timer.cancelled && timer.delay === delay) timer.callback(); },
  };
}

test('a completed caller retains auxiliary capacity until attested native settlement', async () => {
  const f = fixture();
  const execution = f.occupancy.reserveExecution('synthetic-chat');
  execution.enter();
  const running = f.run();
  f.dispatch.resolve({ kind: 'accepted' });
  f.result.resolve('synthetic result');
  expect(await running).toBe('synthetic result');
  expect(f.tasks.active).toBe(1);
  expect(f.occupancy.active).toBe(2);
  expect(() => f.occupancy.reserveAuxiliary()).toThrow('reserved by other work');
  expect(() => f.occupancy.reserveExecution('synthetic-other-chat')).toThrow('reserved by other work');
  f.settled.resolve();
  await tick();
  expect(f.tasks.active).toBe(0);
  expect(f.occupancy.active).toBe(1);
  f.expire(200);
  expect(f.contain).not.toHaveBeenCalled();
  execution.release();
  expect(f.occupancy.active).toBe(0);
});

test('cancellation rejects promptly and invokes the captured abort while its acknowledgement releases nothing', async () => {
  const f = fixture();
  const observed = f.run().catch((error: unknown) => error);
  const replacement = mock(async () => false);
  f.native.abort = replacement;
  f.dispatch.resolve({ kind: 'accepted' });
  f.caller.abort(new Error('Synthetic cancelled caller'));
  expect(await observed).toMatchObject({ message: 'Synthetic cancelled caller' });
  await tick();
  expect(f.abort).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
  expect(f.occupancy.active).toBe(1);
  f.result.resolve('synthetic ignored result');
  await tick();
  expect(f.occupancy.active).toBe(1);
  f.settled.resolve();
  await tick();
  expect(f.occupancy.active).toBe(0);
});

test.each(['rejected', 'unknown'] as const)('%s dispatch keeps native cleanup and capacity until settlement', async (kind) => {
  const f = fixture();
  const observed = f.run().catch((error: unknown) => error);
  const error = new Error('Synthetic dispatch failure');
  f.dispatch.resolve({ kind, error });
  expect(await observed).toBe(error);
  await tick();
  expect(f.abort).toHaveBeenCalledTimes(1);
  expect(f.occupancy.active).toBe(1);
  f.settled.resolve();
  f.result.reject(error);
  await tick();
  expect(f.occupancy.active).toBe(0);
});

test.each(['deadline', 'rejection'] as const)('settlement %s requests whole-session containment without later releasing capacity', async (kind) => {
  const f = fixture();
  const running = f.run();
  f.dispatch.resolve({ kind: 'accepted' });
  f.result.resolve('synthetic result');
  await running;
  if (kind === 'deadline') f.expire(200);
  else f.settled.reject(new Error('Synthetic unconfirmed cleanup'));
  await tick();
  expect(f.contain).toHaveBeenCalledTimes(1);
  expect(() => f.occupancy.reserveAuxiliary()).toThrow('retired');
  f.settled.resolve();
  await tick();
  expect(f.occupancy.active).toBe(1);
  expect(f.tasks.active).toBe(1);
});

test('dispatch deadline never reports settlement or redispatches', async () => {
  const f = fixture();
  const begin = mock(() => f.native);
  const observed = f.tasks.run(begin, f.caller.signal, f.contain).catch((error: unknown) => error);
  f.expire(100);
  expect(await observed).toMatchObject({ name: 'TimeoutError' });
  expect(f.occupancy.active).toBe(1);
  expect(begin).toHaveBeenCalledTimes(1);
  f.expire(200);
  expect(f.contain).toHaveBeenCalledTimes(1);
});

test('authority closure retains unsettled capacity and rejects new work', async () => {
  const f = fixture();
  const observed = f.run().catch((error: unknown) => error);
  f.authority.abort();
  expect(await observed).toMatchObject({ name: 'AbortError' });
  expect(f.occupancy.active).toBe(1);
  expect(() => f.tasks.run(() => f.native, new AbortController().signal, f.contain)).toThrow('retired');
  f.dispatch.resolve({ kind: 'accepted' });
  f.result.resolve('synthetic late result');
  f.settled.resolve();
  await tick();
  expect(f.occupancy.active).toBe(0);
});

test('synchronous pre-entry refusal releases the unused reservation', () => {
  const f = fixture();
  expect(() => f.tasks.run(() => { throw new Error('Synthetic refusal'); }, f.caller.signal, f.contain)).toThrow('Synthetic refusal');
  expect(f.occupancy.active).toBe(0);
  expect(f.tasks.active).toBe(0);
});
