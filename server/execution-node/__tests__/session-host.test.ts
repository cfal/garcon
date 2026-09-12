import { expect, mock, test } from 'bun:test';
import { NodeSessionHostOwner, type NodeSessionHostOptions } from '../systemd/session-host.js';
import type { NodeSessionHostMarker, NodeSessionMarkerStore } from '../systemd/session-marker.js';
import type { SystemdLaunchIdentity, SystemdUnitIdentity } from '../systemd/contracts.js';
import { NodeSupervisor, type NodeSupervisorOptions } from '../supervisor.js';
import { systemdExecutionLaunch } from '../systemd/launch.js';

const session = { controllerBootId: 'synthetic-controller-boot', nodeBootId: 'synthetic-node-boot', logicalSessionId: 'synthetic-session' };
const unitIdentity = (launch: SystemdLaunchIdentity): SystemdUnitIdentity => ({ ...launch, invocationId: 'c'.repeat(32), mainPid: 1234,
  controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${launch.unitName}` });

function fixture(initial: NodeSessionHostMarker | null = null) {
  let marker = initial;
  const calls: string[] = [];
  const finished = Promise.withResolvers<number>();
  const store = {
    read: mock(async () => { calls.push('read'); return marker; }),
    recordLaunch: mock(async (launch) => { calls.push('record-launch');
      marker = { version: 1, nodeId: 'synthetic-node', controllerId: 'synthetic-controller', launch, identity: null }; }),
    recordIdentity: mock(async (identity) => { calls.push('record-identity');
      if (!marker) throw new Error('Synthetic marker absent'); marker = { ...marker, identity }; }),
    clear: mock(async () => { calls.push('clear'); marker = null; }),
  } satisfies NodeSessionMarkerStore;
  const helper = mock<NonNullable<NodeSessionHostOptions['helper']>>(async (request) => {
    calls.push(request.kind);
    return request.kind === 'inspect' ? { kind: 'ready', identity: unitIdentity(request.launch) }
      : request.kind === 'retire-inert' ? { kind: 'retired-inert' } : { kind: 'stopped' };
  });
  const spawn = mock<NodeSessionHostOptions['spawn']>((launch) => {
    calls.push('spawn'); expect(marker?.launch).toEqual(launch.identity);
    return { exited: finished.promise, closeInput() { calls.push('close-input'); }, kill() { calls.push('kill-waiter'); finished.resolve(0); } };
  });
  const exited = mock<NodeSessionHostOptions['exited']>(() => {});
  const owner = new NodeSessionHostOwner({ nodeId: 'synthetic-node', marker: store, command: ['/synthetic/bun', '--synthetic-worker'], spawn, helper, exited });
  return { owner, store, helper, spawn, exited, finished, calls, marker: () => marker };
}

test('launch evidence precedes spawn and full identity precedes session binding', async () => {
  const f = fixture();
  await expect(f.owner.launch()).rejects.toThrow();
  await f.owner.reconcile();
  const host = await f.owner.launch();
  expect(() => f.owner.bind(host, session)).toThrow();
  expect(f.calls).toEqual(['read', 'record-launch', 'spawn']);
  await f.owner.confirm(host);
  f.owner.bind(host, session);
  expect(f.calls).toEqual(['read', 'record-launch', 'spawn', 'inspect', 'record-identity']);
  expect(f.marker()?.identity).toEqual(unitIdentity(host.launch.identity));
  await f.owner.cleanup(session);
  expect(f.calls.slice(-4)).toEqual(['close-input', 'stop', 'kill-waiter', 'clear']);
  expect(f.exited).not.toHaveBeenCalled();
});

test.each([false, true])('startup cleans recorded %s full identity before new launch', async (full) => {
  const launch = systemdExecutionLaunch('synthetic-node', '/synthetic/bun', []).identity;
  const initial: NodeSessionHostMarker = { version: 1, nodeId: 'synthetic-node', controllerId: 'synthetic-controller',
    launch, identity: full ? unitIdentity(launch) : null };
  const f = fixture(initial);
  await f.owner.reconcile();
  expect(f.calls).toEqual(full ? ['read', 'stop', 'clear'] : ['read', 'retire-inert', 'clear']);
  const host = await f.owner.launch();
  expect(host.launch.identity.launchId).not.toBe(launch.launchId);
  await f.owner.confirm(host);
  await f.owner.stop(host);
});

test('unconfirmed cleanup keeps exact evidence and refuses a replacement launch', async () => {
  const f = fixture();
  await f.owner.reconcile();
  const host = await f.owner.launch();
  await f.owner.confirm(host);
  f.owner.bind(host, session);
  f.helper.mockImplementationOnce(async () => { throw new Error('Synthetic cleanup failure'); });
  await expect(f.owner.cleanup(session)).rejects.toThrow('Synthetic cleanup failure');
  expect(f.marker()?.identity).toEqual(unitIdentity(host.launch.identity));
  await expect(f.owner.launch()).rejects.toThrow();
  expect(f.store.clear).not.toHaveBeenCalled();
  await f.owner.cleanup(session);
  expect(f.marker()).toBeNull();
});

test('lost persistence acknowledgement never permits activation but retains exact cleanup identity', async () => {
  const f = fixture();
  await f.owner.reconcile();
  const host = await f.owner.launch();
  f.store.recordIdentity.mockImplementationOnce(async () => { throw new Error('Synthetic unknown rename'); });
  await expect(f.owner.confirm(host)).rejects.toThrow('Synthetic unknown rename');
  expect(() => f.owner.bind(host, session)).toThrow();
  await f.owner.stop(host);
  expect(f.helper.mock.calls.map(([request]) => request.kind)).toEqual(['inspect', 'stop']);
});

test('exit before confirmation or binding cannot activate a dead worker', async () => {
  const f = fixture();
  await f.owner.reconcile();
  const host = await f.owner.launch();
  f.finished.resolve(1);
  await f.finished.promise;
  await expect(f.owner.confirm(host)).rejects.toThrow();
  expect(() => f.owner.bind(host, session)).toThrow();
  expect(f.exited).not.toHaveBeenCalled();
  await f.owner.stop(host);
});

test('bound worker death reports only its immutable session and is never itself cleanup proof', async () => {
  const f = fixture();
  await f.owner.reconcile();
  const host = await f.owner.launch();
  await f.owner.confirm(host);
  const supplied = { ...session };
  f.owner.bind(host, supplied);
  supplied.logicalSessionId = 'synthetic-other';
  f.finished.resolve(1);
  await f.finished.promise;
  expect(f.exited.mock.calls).toEqual([[session]]);
  expect(f.store.clear).not.toHaveBeenCalled();
  await expect(f.owner.launch()).rejects.toThrow();
  await f.owner.cleanup(session);
});

test('duplicate cleanup coalesces and stale sessions cannot stop another host', async () => {
  const f = fixture();
  await f.owner.reconcile();
  const host = await f.owner.launch();
  await f.owner.confirm(host);
  f.owner.bind(host, session);
  const stopped = Promise.withResolvers<{ kind: 'stopped' }>();
  f.helper.mockImplementationOnce(() => stopped.promise);
  const first = f.owner.cleanup(session);
  expect(f.owner.cleanup(session)).toBe(first);
  await expect(f.owner.cleanup({ ...session, logicalSessionId: 'synthetic-old' })).rejects.toThrow();
  await expect(f.owner.launch()).rejects.toThrow();
  expect(f.store.clear).not.toHaveBeenCalled();
  stopped.resolve({ kind: 'stopped' });
  await first;
  expect(f.store.clear).toHaveBeenCalledTimes(1);
});

test('spawn failure preserves launch evidence and requires reconciliation before another attempt', async () => {
  const f = fixture();
  await f.owner.reconcile();
  f.spawn.mockImplementationOnce(() => { throw new Error('Synthetic launch failure'); });
  await expect(f.owner.launch()).rejects.toThrow('Synthetic launch failure');
  expect(f.marker()?.identity).toBeNull();
  await expect(f.owner.launch()).rejects.toThrow();
  await f.owner.reconcile();
  expect(f.marker()).toBeNull();
});

test('an unconfirmed host retires only its inert launch and reaps a stuck waiter before clearing evidence', async () => {
  const f = fixture();
  await f.owner.reconcile();
  const host = await f.owner.launch();
  const retired = Promise.withResolvers<{ kind: 'retired-inert' }>();
  f.helper.mockImplementationOnce(() => retired.promise);
  const stopping = f.owner.stop(host);
  expect(f.calls.at(-1)).toBe('close-input');
  expect(f.calls).not.toContain('kill-waiter');
  expect(f.marker()).not.toBeNull();
  retired.resolve({ kind: 'retired-inert' });
  await stopping;
  expect(f.helper.mock.calls[0]).toEqual([{ kind: 'retire-inert', launch: host.launch.identity }]);
  expect(f.calls.slice(-2)).toEqual(['kill-waiter', 'clear']);
  expect(f.marker()).toBeNull();
});

test('a foreign unit or ambiguous inert retirement preserves evidence until a successful explicit reconciliation', async () => {
  const launch = systemdExecutionLaunch('synthetic-node', '/synthetic/bun', []).identity;
  const initial: NodeSessionHostMarker = { version: 1, nodeId: 'synthetic-node', controllerId: 'synthetic-controller', launch, identity: null };
  const f = fixture(initial);
  f.helper.mockImplementationOnce(async () => { throw new Error('Synthetic foreign occupant'); });
  await expect(f.owner.reconcile()).rejects.toThrow('Synthetic foreign occupant');
  expect(f.marker()).toEqual(initial);
  await expect(f.owner.launch()).rejects.toThrow();
  await f.owner.reconcile();
  expect(f.marker()).toBeNull();
  const host = await f.owner.launch();
  expect(host.launch.identity.launchId).not.toBe(launch.launchId);
  await f.owner.stop(host);
});

test('inert retirement is not configured-work cleanup proof', async () => {
  const f = fixture();
  await f.owner.reconcile();
  const host = await f.owner.launch();
  await f.owner.confirm(host);
  f.owner.bind(host, session);
  f.helper.mockImplementationOnce(async () => ({ kind: 'retired-inert' }));
  await expect(f.owner.cleanup(session)).rejects.toThrow();
  expect(f.store.clear).not.toHaveBeenCalled();
  await f.owner.cleanup(session);
});

test('worker failure retires the exact logical session across a physical reconnect', async () => {
  const cleaned = Promise.withResolvers<void>();
  const cleanup = mock<NodeSupervisorOptions['cleanup']>(async () => cleaned.promise);
  const supervisor = new NodeSupervisor({ cleanup, clock: { read: () => ({ elapsedMs: 0, discontinuity: false }) } });
  const first = supervisor.openSession('synthetic-controller');
  const socket = supervisor.attach(first);
  supervisor.disconnect(socket);
  const replacement = supervisor.attach(first);
  const retired = supervisor.executionHostExited(first, 'worker-exited');
  expect(replacement.authoritySignal.aborted).toBe(true);
  expect(supervisor.status).toBe('cleaning-up');
  expect(() => supervisor.openSession('synthetic-controller')).toThrow();
  cleaned.resolve();
  expect(await retired).toBe(true);
  expect(cleanup.mock.calls[0]).toEqual([first, 'worker-exited']);
  const next = supervisor.openSession('synthetic-controller');
  const nextSocket = supervisor.attach(next);
  expect(await supervisor.executionHostExited(first, 'worker-protocol-failed')).toBe(false);
  expect(nextSocket.authoritySignal.aborted).toBe(false);
  await supervisor.shutdown();
});
