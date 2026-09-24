import { expect, spyOn, test } from 'bun:test';
import { AgentRpc } from '../rpc.js';
import { SessionTransport } from '../session-transport.js';

function pair() {
  const controller = new SessionTransport('test', 'worker', () => {}, { maxQueuedBytes: 8192 });
  const worker = new SessionTransport('test', 'controller', () => {}, { maxQueuedBytes: 8192 });
  let writable = true;
  const left = controller.attach({ send: body => right.receive(body), close() {} });
  const right = worker.attach({ send: body => left.receive(body), close() {}, canSend: () => writable });
  const client = new AgentRpc(controller);
  const service = new AgentRpc(worker);
  return { client, service, worker, block: () => { writable = false; }, unblock: () => { writable = true; },
    close() { controller.close(); worker.close(); } };
}

test('explicit no-deadline RPC installs no timer and remains cancellable', async () => {
  const fixture = pair();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let incomingSignal: AbortSignal | undefined;
  fixture.service.handle(async (_request, signal) => { incomingSignal = signal; entered.resolve(); await release.promise; });
  const timers = spyOn(globalThis, 'setTimeout');
  const abort = new AbortController();
  try {
    const result = fixture.client.call('test', 'commands.discover', { projectPath: '/repo' }, { timeoutMs: null, signal: abort.signal });
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
  fixture.service.handle(async () => { calls++; return []; });
  try {
    await expect(fixture.client.call('test', 'commands.discover', { projectPath: '/repo' }, { timeoutMs }))
      .rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(calls).toBe(0);
  } finally { fixture.close(); }
});

test('a reply that cannot fit the queue becomes a small uncertain error without retiring the session', async () => {
  const fixture = pair();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.service.handle(async () => { entered.resolve(); await release.promise; return 'x'.repeat(2000); });
  try {
    const result = fixture.client.call('test', 'commands.discover', { projectPath: '/repo' });
    await entered.promise;
    fixture.block();
    fixture.worker.send(JSON.stringify({ type: 'result', id: 'unrelated', value: 'q'.repeat(7450) }));
    release.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.worker.connected).toBe(true);
    fixture.unblock();
    await expect(result).rejects.toMatchObject({ outcome: 'unknown' });
    expect(fixture.worker.connected).toBe(true);
    fixture.service.handle(async () => []);
    await expect(fixture.client.call('test', 'commands.discover', { projectPath: '/repo' })).resolves.toEqual([]);
  } finally { release.resolve(); fixture.close(); }
});
