import { WorkerSessionTransport, handleTestRpc } from '../../__tests__/test-session-transport.js';
import { RPC_V1 } from '@garcon/common/executor-contracts';
import { expect, spyOn, test } from 'bun:test';
import { ExecutorRpc } from '../rpc.js';
import { TestSessionTransport as SessionTransport } from '../../__tests__/test-session-transport.js';
import { AgentCallError } from '@garcon/server-agent-interface';

function pair() {
  const controller = new SessionTransport('test', 'worker', () => {}, { maxQueuedBytes: 8192 });
  const worker = new WorkerSessionTransport('test', 'controller', () => {}, { maxQueuedBytes: 8192 });
  let writable = true;
  const left = controller.attach({ send: body => right.receive(body), close() {} });
  const right = worker.attach({ send: body => left.receive(body), close() {}, canSend: () => writable });
  const client = new ExecutorRpc(controller);
  const service = new ExecutorRpc(worker);
  return { client, service, worker, block: () => { writable = false; }, unblock: () => { writable = true; },
    close() { controller.close(); worker.close(); } };
}

test('explicit no-deadline RPC installs no timer and remains cancellable', async () => {
  const fixture = pair();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let incomingSignal: AbortSignal | undefined;
  handleTestRpc(fixture.service, async (_request, signal) => { incomingSignal = signal; entered.resolve(); await release.promise; });
  const timers = spyOn(globalThis, 'setTimeout');
  const abort = new AbortController();
  try {
    const result = fixture.client.call('test', RPC_V1['commands.discover'], { projectPath: '/repo' }, { timeoutMs: null, signal: abort.signal });
    await entered.promise;
    expect(timers).not.toHaveBeenCalled();
    abort.abort();
    await expect(result).rejects.toMatchObject({ outcome: 'unknown' });
    expect(incomingSignal?.aborted).toBe(true);
  } finally { timers.mockRestore(); release.resolve(); fixture.close(); }
});

test.each([0, -1, Infinity, NaN, 2 ** 31, 1.5])('invalid RPC deadline %s rejects before dispatch', async timeoutMs => {
  const fixture = pair();
  let calls = 0;
  handleTestRpc(fixture.service, async () => { calls++; return []; });
  try {
    await expect(fixture.client.call('test', RPC_V1['commands.discover'], { projectPath: '/repo' }, { timeoutMs }))
      .rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(calls).toBe(0);
  } finally { fixture.close(); }
});

test('a reply that cannot fit the queue becomes a small uncertain error without retiring the session', async () => {
  const fixture = pair();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  handleTestRpc(fixture.service, async () => { entered.resolve(); await release.promise; return [{ name: 'x'.repeat(2000), source: 'command', description: 'Synthetic command' }]; });
  try {
    const result = fixture.client.call('test', RPC_V1['commands.discover'], { projectPath: '/repo' });
    await entered.promise;
    fixture.block();
    fixture.worker.send(JSON.stringify({ type: 'result', id: 'unrelated', value: 'q'.repeat(7450) }));
    release.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.worker.connected).toBe(true);
    fixture.unblock();
    await expect(result).rejects.toMatchObject({
      outcome: 'unknown', message: "The executor's reply could not be delivered, so the outcome is unknown.",
    });
    expect(fixture.worker.connected).toBe(true);
    handleTestRpc(fixture.service, async () => []);
    await expect(fixture.client.call('test', RPC_V1['commands.discover'], { projectPath: '/repo' })).resolves.toEqual([]);
  } finally { release.resolve(); fixture.close(); }
});

test('tells a handler only about a reply the queue could not take', async () => {
  const fixture = pair();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const undelivered: string[] = [];
  handleTestRpc(fixture.service, async (_request, _signal, _guardReply, onUndeliveredReply) => {
    onUndeliveredReply(() => { undelivered.push('blocked'); });
    entered.resolve();
    await release.promise;
    return [{ name: 'x'.repeat(2000), source: 'command', description: 'Synthetic command' }];
  });
  try {
    const result = fixture.client.call('test', RPC_V1['commands.discover'], { projectPath: '/repo' });
    await entered.promise;
    fixture.block();
    fixture.worker.send(JSON.stringify({ type: 'result', id: 'unrelated', value: 'q'.repeat(7450) }));
    release.resolve();
    fixture.unblock();
    await expect(result).rejects.toMatchObject({ outcome: 'unknown' });
    expect(undelivered).toEqual(['blocked']);

    handleTestRpc(fixture.service, async (_request, _signal, _guardReply, onUndeliveredReply) => {
      onUndeliveredReply(() => { undelivered.push('delivered'); });
      return [];
    });
    await expect(fixture.client.call('test', RPC_V1['commands.discover'], { projectPath: '/repo' })).resolves.toEqual([]);
    expect(undelivered).toEqual(['blocked']);
  } finally { release.resolve(); fixture.close(); }
});

test('reply guards retain their call context across handler replacement and run before enqueue', async () => {
  const fixture = pair();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const value = [{ name: 'synthetic', source: 'command', description: 'Synthetic command' }];
  let guarded = 0;
  handleTestRpc(fixture.service, async (_request, _signal, guardReply) => {
    guardReply((bytes) => {
      guarded++;
      expect(bytes).toBe(Buffer.byteLength(JSON.stringify({ type: 'result', id: crypto.randomUUID(), value })));
      expect(fixture.worker.channel.queuedBytes).toBe(0);
      throw new AgentCallError('rejected', 'Original authorization expired');
    });
    entered.resolve();
    await release.promise;
    return value;
  });
  try {
    const pending = fixture.client.call('test', RPC_V1['commands.discover'], { projectPath: '/repo' });
    await entered.promise;
    handleTestRpc(fixture.service, async () => []);
    release.resolve();
    await expect(pending).rejects.toMatchObject({ outcome: 'rejected', message: 'Original authorization expired' });
    expect(guarded).toBe(1);
    await expect(fixture.client.call('test', RPC_V1['commands.discover'], { projectPath: '/repo' })).resolves.toEqual([]);
  } finally { release.resolve(); fixture.close(); }
});
