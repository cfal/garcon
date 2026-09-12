import { afterEach, expect, mock, test } from 'bun:test';
import type { NodeProviderManifest } from '../../execution-nodes/provider-manifest.js';
import { NodeSessionCoordinator, type NodeSessionCoordinatorOptions } from '../session-coordinator.js';
import { NODE_CONTROLLER_LEASE_MS, NODE_RECOVERY_TIMEOUT_MS } from '../supervisor.js';
import type { NodeSessionHostMarker, NodeSessionMarkerStore } from '../systemd/session-marker.js';
import type { SystemdLaunchIdentity, SystemdUnitIdentity } from '../systemd/contracts.js';
import { configuration, manifest, tick } from '../worker/__tests__/lifecycle-fixture.js';
import type { NodeWorkerPeerOptions } from '../worker/peer.js';
import { NodeWorkerTransportError } from '../worker/framing.js';

const coordinators: NodeSessionCoordinator[] = [];
afterEach(async () => { for (const coordinator of coordinators.splice(0)) await coordinator.shutdown(); });

function fixture() {
  let marker: NodeSessionHostMarker | null = null;
  let elapsedMs = 0;
  const calls: string[] = [];
  const hello = Promise.withResolvers<number>();
  void hello.promise.catch(() => {});
  const finished = Promise.withResolvers<number>();
  const polls = new Set<() => void>();
  const timeouts = new Set<() => void>();
  const clock = { read: mock((): { elapsedMs: number; discontinuity: boolean } => ({ elapsedMs, discontinuity: false })) };
  const identity = (launch: SystemdLaunchIdentity): SystemdUnitIdentity => ({ ...launch,
    invocationId: 'c'.repeat(32), mainPid: 1234, controlGroup: `/synthetic/${launch.unitName}` });
  const store = {
    read: mock(async () => { calls.push('read'); return marker; }),
    recordLaunch: mock<NodeSessionMarkerStore['recordLaunch']>(async (launch) => {
      calls.push('record-launch');
      marker = { version: 1, controllerId: 'synthetic-controller', nodeId: 'synthetic-node', launch, identity: null };
    }),
    recordIdentity: mock<NodeSessionMarkerStore['recordIdentity']>(async (value) => {
      calls.push('record-identity');
      if (!marker) throw new Error('Synthetic marker absent');
      marker = { ...marker, identity: value };
    }),
    clear: mock(async () => { calls.push('clear'); marker = null; }),
  } satisfies NodeSessionMarkerStore;
  const helper = mock<NonNullable<NodeSessionCoordinatorOptions['host']['helper']>>(async (request) => {
    calls.push(request.kind);
    return request.kind === 'inspect' ? { kind: 'ready', identity: identity(request.launch) }
      : request.kind === 'retire-inert' ? { kind: 'retired-inert' } : { kind: 'stopped' };
  });
  const spawn = mock<NodeSessionCoordinatorOptions['host']['spawn']>((launch) => {
    calls.push('spawn'); expect(marker?.launch).toEqual(launch.identity);
    return { exited: finished.promise, closeInput() { calls.push('host-close'); },
      kill() { calls.push('kill-waiter'); finished.resolve(0); } };
  });
  type Peer = ReturnType<NodeSessionCoordinatorOptions['createPeer']>;
  const peer = {
    hello: hello.promise,
    configure: mock<Peer['configure']>(async () => { calls.push('configure'); return [manifest()]; }),
    attach: mock<Peer['attach']>(async (connectionId) => { calls.push(`attach:${connectionId}`); }),
    admit: mock<Peer['admit']>(async (connectionId) => { calls.push(`admit:${connectionId}`); }),
    disconnect: mock<Peer['disconnect']>(async (connectionId) => { calls.push(`disconnect:${connectionId}`); }),
    closeInput: mock(() => { calls.push('peer-close'); hello.reject(new Error('Synthetic closed peer')); }),
    execution() { throw new Error('Unused synthetic execution client'); },
    service() { throw new Error('Unused synthetic service client'); },
    forward: mock<Peer['forward']>(() => ({ submitted: true, drained: Promise.resolve() })),
    waitForRelease: mock<Peer['waitForRelease']>(async () => {}),
  } satisfies Peer;
  const createPeer = mock<NodeSessionCoordinatorOptions['createPeer']>((_host, options) => {
    calls.push('create-peer');
    options.signal.addEventListener('abort', () => peer.closeInput(), { once: true });
    return peer;
  });
  const coordinator = new NodeSessionCoordinator({ configuration: configuration(),
    host: { nodeId: 'synthetic-node', marker: store, command: ['/synthetic/bun', '--synthetic-worker'], spawn, helper },
    createPeer, received() {},
    supervisor: { clock,
      scheduleTimeout(callback) { timeouts.add(callback); return { cancel: () => { timeouts.delete(callback); } }; } },
    scheduleLeasePoll(callback) { polls.add(callback); return { cancel: () => { polls.delete(callback); } }; },
  });
  coordinators.push(coordinator);
  const start = async () => {
    await coordinator.initialize();
    const connection = coordinator.open('synthetic-controller-boot');
    hello.resolve(1234);
    await connection.ready;
    return connection;
  };
  return { coordinator, store, helper, spawn, peer, createPeer, calls, hello, finished, polls, timeouts, clock, start,
    marker: () => marker, identity, setTime(value: number) { elapsedMs = value; },
    poll() { for (const callback of [...polls]) { polls.delete(callback); callback(); } },
    peerOptions: (): NodeWorkerPeerOptions => createPeer.mock.calls[0]![1],
  };
}

test('reconciles before opening and confirms containment before configuring or admitting work', async () => {
  const f = fixture();
  expect(() => f.coordinator.open('synthetic-controller-boot')).toThrow();
  const connection = await f.start();
  expect(f.calls).toEqual(['read', 'record-launch', 'spawn', 'create-peer', 'inspect', 'record-identity', 'configure']);
  expect(f.peer.configure.mock.calls[0]).toEqual([connection.lease.session, 1, configuration()]);
  expect(f.coordinator.supervisor.status).toBe('recovering');
  expect(() => f.coordinator.supervisor.assertAdmission(connection.lease)).toThrow();
  const recovery = f.coordinator.beginRecovery(connection);
  expect(await f.coordinator.completeRecovery(connection, recovery)).toBe(true);
  expect(f.peer.admit.mock.calls).toEqual([[1]]);
  expect(() => f.coordinator.supervisor.assertAdmission(connection.lease)).not.toThrow();
});

test('accepted retirements keep their captured worker after physical disconnect and block the replacement barrier', async () => {
  const f = fixture(); const first = await f.start();
  const capacity = Promise.withResolvers<void>();
  const frame = { type: 'node-worker-output-retired', version: 1, stream: { ...first.lease.session, streamId: 'synthetic-stream' },
    instanceId: configuration().instances[0]!.id } as const;
  f.peer.forward.mockImplementationOnce(() => { throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY'); });
  f.peer.waitForRelease.mockImplementationOnce(() => capacity.promise);
  f.coordinator.retireOutput(first, frame);
  await tick();
  expect(f.peer.waitForRelease).toHaveBeenCalledTimes(1);
  await f.coordinator.disconnect(first);
  expect(f.peer.forward.mock.calls[0]![1].aborted).toBe(false);
  expect(() => f.coordinator.retireOutput(first, frame)).toThrow();
  const next = f.coordinator.attach(first.lease.session); await next.ready;
  const completed = mock(() => {});
  const flushed = f.coordinator.flushOutputRetirements(next).then(completed);
  await tick(); expect(completed).not.toHaveBeenCalled();
  capacity.resolve(); await flushed;
  expect(f.peer.forward.mock.calls.map(([retired]) => retired)).toEqual([frame, frame]);
  expect(first.lease.authoritySignal.aborted).toBe(false);
  expect(f.peer.configure).toHaveBeenCalledTimes(1);
});

test('renews authenticated liveness before worker startup settles', async () => {
  const f = fixture();
  await f.coordinator.initialize();
  const connection = f.coordinator.open('synthetic-controller-boot');
  await tick();
  f.setTime(10_000);
  const challenge = f.coordinator.supervisor.issueChallenge(connection.lease);
  expect(challenge).not.toBeNull();
  expect(f.coordinator.supervisor.renew(connection.lease, challenge!)).toBe(true);
  f.setTime(NODE_CONTROLLER_LEASE_MS - 1);
  f.poll();
  expect(connection.lease.authoritySignal.aborted).toBe(false);
  expect(f.peer.configure).not.toHaveBeenCalled();
  f.hello.resolve(1234);
  await connection.ready;
});

test('shutdown waits for startup reconciliation before the marker owner can be released', async () => {
  const f = fixture();
  const read = Promise.withResolvers<NodeSessionHostMarker | null>();
  f.store.read.mockImplementationOnce(() => read.promise);
  const initialized = f.coordinator.initialize();
  let settled = false;
  const stopped = f.coordinator.shutdown().then((result) => { settled = true; return result; });
  await tick();
  const premature = settled;
  read.resolve(null);
  await initialized;
  expect(await stopped).toBe(true);
  expect(premature).toBe(false);
  expect(() => f.coordinator.open('synthetic-controller-boot')).toThrow();
  expect(f.spawn).not.toHaveBeenCalled();
});

test('failed initial reconciliation cannot become successful shutdown without cleanup proof', async () => {
  const f = fixture();
  const read = f.store.read.getMockImplementation()!;
  f.store.read.mockImplementation(async () => { throw new Error('Synthetic unavailable containment evidence'); });
  await expect(f.coordinator.initialize()).rejects.toThrow();
  expect(await f.coordinator.shutdown()).toBe(false);
  expect(f.store.read).toHaveBeenCalledTimes(2);
  expect(f.store.clear).not.toHaveBeenCalled();
  f.store.read.mockImplementation(read);
  expect(await f.coordinator.shutdown()).toBe(true);
  expect(f.store.read).toHaveBeenCalledTimes(3);
});

test('clock retirement between opening authority and its first attachment reconciles before replacement', async () => {
  const f = fixture();
  await f.coordinator.initialize();
  f.clock.read.mockReturnValueOnce({ elapsedMs: 0, discontinuity: false });
  f.clock.read.mockReturnValueOnce({ elapsedMs: 0, discontinuity: true });
  expect(() => f.coordinator.open('synthetic-controller-boot')).toThrow();
  expect(f.spawn).not.toHaveBeenCalled();
  expect(await f.coordinator.supervisor.retryCleanup()).toBe(true);
  expect(f.store.read).toHaveBeenCalledTimes(2);
  const next = await f.start();
  expect(next.lease.authoritySignal.aborted).toBe(false);
});

test('synchronous old-connection callbacks cannot replace the attachment being published', async () => {
  const f = fixture();
  const first = await f.start();
  let rejected: unknown;
  first.lease.signal.addEventListener('abort', () => {
    try { f.coordinator.attach(first.lease.session); }
    catch (error) { rejected = error; }
  }, { once: true });
  const replacement = f.coordinator.attach(first.lease.session);
  await replacement.ready;
  expect(rejected).toMatchObject({ code: 'NODE_UNAVAILABLE' });
  expect(replacement.lease.signal.aborted).toBe(false);
  expect(f.coordinator.peer(replacement)).toBe(f.peer);
  expect(f.peer.attach.mock.calls).toEqual([[2]]);
});

test('replacement physical connections retain the worker and fence old readiness and close callbacks', async () => {
  const f = fixture();
  await f.coordinator.initialize();
  const first = f.coordinator.open('synthetic-controller-boot');
  const replacement = f.coordinator.attach(first.lease.session);
  f.hello.resolve(1234);
  await replacement.ready;
  await expect(first.ready).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  await f.coordinator.disconnect(first);
  expect(f.peer.disconnect).not.toHaveBeenCalled();
  expect(f.peer.attach.mock.calls).toEqual([[2]]);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(replacement.lease.authoritySignal).toBe(first.lease.authoritySignal);
  expect(replacement.lease.authoritySignal.aborted).toBe(false);
});

test('disconnect of a replacement during startup also detaches the initial worker connection', async () => {
  const f = fixture();
  await f.coordinator.initialize();
  const first = f.coordinator.open('synthetic-controller-boot');
  const replacement = f.coordinator.attach(first.lease.session);
  await f.coordinator.disconnect(replacement);
  f.hello.resolve(1234);
  await expect(replacement.ready).rejects.toThrow();
  expect(f.peer.attach).not.toHaveBeenCalled();
  expect(f.peer.disconnect.mock.calls).toContainEqual([1]);
  expect(replacement.lease.authoritySignal.aborted).toBe(false);
  const third = f.coordinator.attach(first.lease.session);
  await third.ready;
  expect(f.peer.attach.mock.calls).toEqual([[3]]);
});

test('a superseded recovery cannot admit the worker before the current recovery completes', async () => {
  const f = fixture();
  const connection = await f.start();
  const stale = f.coordinator.beginRecovery(connection);
  const current = f.coordinator.beginRecovery(connection);
  expect(await f.coordinator.completeRecovery(connection, stale)).toBe(false);
  expect(f.peer.admit).not.toHaveBeenCalled();
  expect(await f.coordinator.completeRecovery(connection, current)).toBe(true);
  expect(f.peer.admit.mock.calls).toEqual([[1]]);
});

test('rechecks recovery ownership after waiting for startup', async () => {
  const f = fixture();
  await f.coordinator.initialize();
  const connection = f.coordinator.open('synthetic-controller-boot');
  const stale = f.coordinator.beginRecovery(connection);
  const completing = f.coordinator.completeRecovery(connection, stale);
  f.coordinator.beginRecovery(connection);
  f.hello.resolve(1234);
  expect(await completing).toBe(false);
  expect(f.peer.admit).not.toHaveBeenCalled();
});

test('duplicate completion submits one admission and rechecks ownership after drain', async () => {
  const f = fixture();
  const connection = await f.start();
  const drain = Promise.withResolvers<void>();
  f.peer.admit.mockImplementationOnce(() => drain.promise);
  const attempt = f.coordinator.beginRecovery(connection);
  const first = f.coordinator.completeRecovery(connection, attempt);
  const duplicate = f.coordinator.completeRecovery(connection, attempt);
  await tick();
  f.coordinator.beginRecovery(connection);
  drain.resolve();
  expect(await first).toBe(false);
  expect(await duplicate).toBe(false);
  expect(f.peer.admit).toHaveBeenCalledTimes(1);
  expect(f.coordinator.supervisor.status).toBe('recovering');
});

test('disconnect preserves logical authority but expiry cleans it without another socket event', async () => {
  const f = fixture();
  const connection = await f.start();
  const attempt = f.coordinator.beginRecovery(connection);
  expect(await f.coordinator.completeRecovery(connection, attempt)).toBe(true);
  await f.coordinator.disconnect(connection);
  expect(f.coordinator.supervisor.status).toBe('reconnecting');
  expect(connection.lease.authoritySignal.aborted).toBe(false);
  expect(f.store.clear).not.toHaveBeenCalled();
  f.setTime(NODE_CONTROLLER_LEASE_MS);
  f.poll();
  expect(connection.lease.authoritySignal.aborted).toBe(true);
  expect(() => f.coordinator.open('synthetic-next-controller')).toThrow();
  expect(await f.coordinator.supervisor.retryCleanup()).toBe(true);
  expect(f.calls.slice(-4)).toEqual(['host-close', 'stop', 'kill-waiter', 'clear']);
  expect(f.polls.size).toBe(0);
});

test('lease retirement during an unsettled launch retains the replacement fence through cleanup timeout', async () => {
  const f = fixture();
  const recorded = Promise.withResolvers<void>();
  const record = f.store.recordLaunch.getMockImplementation()!;
  f.store.recordLaunch.mockImplementationOnce(async (launch) => { await record(launch); await recorded.promise; });
  await f.coordinator.initialize();
  const connection = f.coordinator.open('synthetic-controller-boot');
  await tick();
  f.setTime(NODE_CONTROLLER_LEASE_MS);
  f.poll();
  const cleanup = f.coordinator.supervisor.retryCleanup();
  for (const timeout of [...f.timeouts]) timeout();
  expect(await cleanup).toBe(false);
  expect(() => f.coordinator.open('synthetic-next-controller')).toThrow();
  expect(f.store.clear).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
  recorded.resolve();
  await expect(connection.ready).rejects.toThrow();
  await tick();
  expect(f.createPeer).not.toHaveBeenCalled();
  expect(f.helper.mock.calls.map(([request]) => request.kind)).toEqual(['retire-inert']);
  expect(f.marker()).toBeNull();
  expect(f.coordinator.supervisor.status).toBe('offline');
});

test('expiry during confirmation waits for native settlement and never configures the worker', async () => {
  const f = fixture();
  const inspected = Promise.withResolvers<void>();
  f.helper.mockImplementationOnce(async (request) => {
    if (request.kind !== 'inspect') throw new Error('Synthetic expected inspect');
    await inspected.promise;
    return { kind: 'ready', identity: f.identity(request.launch) };
  });
  await f.coordinator.initialize();
  const connection = f.coordinator.open('synthetic-controller-boot');
  f.hello.resolve(1234);
  await tick();
  f.setTime(NODE_RECOVERY_TIMEOUT_MS);
  f.poll();
  const cleanup = f.coordinator.supervisor.retryCleanup();
  await tick();
  expect(f.helper).toHaveBeenCalledTimes(1);
  expect(f.store.clear).not.toHaveBeenCalled();
  inspected.resolve();
  await expect(connection.ready).rejects.toThrow();
  expect(await cleanup).toBe(true);
  expect(f.peer.configure).not.toHaveBeenCalled();
  expect(f.helper.mock.calls.map(([request]) => request.kind)).toEqual(['inspect', 'stop']);
});

test('expiry during configuration waits for its settlement and never admits the worker', async () => {
  const f = fixture();
  const configured = Promise.withResolvers<readonly NodeProviderManifest[]>();
  f.peer.configure.mockImplementationOnce(() => configured.promise);
  await f.coordinator.initialize();
  const connection = f.coordinator.open('synthetic-controller-boot');
  f.hello.resolve(1234);
  await tick();
  f.setTime(NODE_CONTROLLER_LEASE_MS);
  f.poll();
  const cleanup = f.coordinator.supervisor.retryCleanup();
  await tick();
  expect(f.store.clear).not.toHaveBeenCalled();
  configured.resolve([manifest()]);
  await expect(connection.ready).rejects.toThrow();
  expect(await cleanup).toBe(true);
  expect(f.peer.admit).not.toHaveBeenCalled();
});

test.each(['pid', 'persistence'] as const)('%s failure never configures and cleans using confirmed identity', async (failure) => {
  const f = fixture();
  if (failure === 'persistence') f.store.recordIdentity.mockImplementationOnce(async () => { throw new Error('Synthetic unknown persistence'); });
  await f.coordinator.initialize();
  const connection = f.coordinator.open('synthetic-controller-boot');
  f.hello.resolve(failure === 'pid' ? 5678 : 1234);
  await expect(connection.ready).rejects.toThrow();
  expect(await f.coordinator.supervisor.retryCleanup()).toBe(true);
  expect(f.peer.configure).not.toHaveBeenCalled();
  expect(f.helper.mock.calls.map(([request]) => request.kind)).toEqual(['inspect', 'stop']);
});

test('an unexpected worker exit retires the exact authority and still requires containment cleanup', async () => {
  const f = fixture();
  const connection = await f.start();
  const stop = Promise.withResolvers<void>();
  f.helper.mockImplementationOnce(async () => { await stop.promise; return { kind: 'stopped' }; });
  f.finished.resolve(1);
  await tick();
  expect(connection.lease.authoritySignal.aborted).toBe(true);
  expect(f.store.clear).not.toHaveBeenCalled();
  expect(f.coordinator.supervisor.status).toBe('cleaning-up');
  stop.resolve();
  expect(await f.coordinator.supervisor.retryCleanup()).toBe(true);
});

test('cleanup failure retains evidence until successful retry and stale callbacks cannot retire a successor', async () => {
  const f = fixture();
  const connection = await f.start();
  const oldOptions = f.peerOptions();
  f.helper.mockImplementationOnce(async () => { throw new Error('Synthetic cleanup refusal'); });
  expect(await f.coordinator.supervisor.revokeConnection(connection.lease)).toBe(false);
  expect(f.marker()?.identity).not.toBeNull();
  expect(() => f.coordinator.open('synthetic-next-controller')).toThrow();
  expect(await f.coordinator.supervisor.retryCleanup()).toBe(true);
  expect(f.marker()).toBeNull();
  const nextExit = Promise.withResolvers<number>();
  f.spawn.mockImplementationOnce(() => ({ exited: nextExit.promise, closeInput() {}, kill() { nextExit.resolve(0); } }));
  const next = f.coordinator.open('synthetic-next-controller');
  await next.ready;
  oldOptions.failed(new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
  expect(next.lease.authoritySignal.aborted).toBe(false);
});
