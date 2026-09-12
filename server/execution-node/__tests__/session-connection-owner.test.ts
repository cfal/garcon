import { expect, mock, test } from 'bun:test';
import type { NodeHostedConnection, NodeSessionCoordinator } from '../session-coordinator.js';
import { NodeSessionConnectionOwner } from '../session-connection-owner.js';
import { NODE_CONTROLLER_LEASE_MS, NodeSupervisor } from '../supervisor.js';
import { manifest, tick } from '../worker/__tests__/lifecycle-fixture.js';

function fixture() {
  let elapsedMs = 0;
  let connectionId = 0;
  const cleanup = mock(async () => {});
  const supervisor = new NodeSupervisor({ cleanup, clock: { read: () => ({ elapsedMs, discontinuity: false }) } });
  const hosted = (lease: NodeHostedConnection['lease']): NodeHostedConnection => ({
    lease, connectionId: ++connectionId, ready: Promise.resolve([manifest()]),
  });
  const coordinator = {
    supervisor,
    initialize: mock(async () => {}),
    open: mock<NodeSessionCoordinator['open']>((boot) => hosted(supervisor.attach(supervisor.openSession(boot)))),
    attach: mock<NodeSessionCoordinator['attach']>((session) => hosted(supervisor.attach(session))),
  } satisfies Pick<NodeSessionCoordinator, 'initialize' | 'supervisor' | 'open' | 'attach'>;
  const owner = new NodeSessionConnectionOwner(coordinator);
  const connect = (boot = 'synthetic-controller-boot', signal = new AbortController().signal) => owner.connect(boot, signal);
  return { coordinator, owner, supervisor, cleanup, connect, setTime(value: number) { elapsedMs = value; } };
}

test('same-boot reconnect preserves logical authority and fences the old physical lease', async () => {
  const f = fixture();
  const first = await f.connect();
  f.supervisor.disconnect(first.lease);
  const second = await f.connect();
  expect(second.lease.session).toBe(first.lease.session);
  expect(second.lease.authoritySignal).toBe(first.lease.authoritySignal);
  expect(first.lease.signal.aborted).toBe(true);
  expect(second.lease.signal.aborted).toBe(false);
  expect(f.coordinator.open).toHaveBeenCalledTimes(1);
  expect(f.coordinator.attach).toHaveBeenCalledTimes(1);
  expect(f.cleanup).not.toHaveBeenCalled();
  expect(await f.supervisor.shutdown()).toBe(true);
});

test('changed controller boot waits for verified cleanup before creating authority', async () => {
  const f = fixture();
  const first = await f.connect();
  const stopped = Promise.withResolvers<void>();
  f.cleanup.mockImplementationOnce(() => stopped.promise);
  const replacement = f.connect('synthetic-replacement-boot');
  await tick();
  expect(first.lease.authoritySignal.aborted).toBe(true);
  expect(f.coordinator.open).toHaveBeenCalledTimes(1);
  expect(f.coordinator.attach).not.toHaveBeenCalled();
  await expect(f.connect()).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  stopped.resolve();
  const second = await replacement;
  expect(second.lease.session.controllerBootId).toBe('synthetic-replacement-boot');
  expect(second.lease.session.logicalSessionId).not.toBe(first.lease.session.logicalSessionId);
  expect(f.coordinator.open).toHaveBeenCalledTimes(2);
  expect(await f.supervisor.shutdown()).toBe(true);
});

test('expired authority creates a fresh session only after cleanup succeeds', async () => {
  const f = fixture();
  const first = await f.connect();
  f.setTime(NODE_CONTROLLER_LEASE_MS);
  f.cleanup.mockImplementation(async () => { throw new Error('Synthetic cleanup unavailable'); });
  await expect(f.connect()).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  expect(first.lease.authoritySignal.aborted).toBe(true);
  expect(f.supervisor.status).toBe('cleaning-up');
  expect(f.coordinator.open).toHaveBeenCalledTimes(1);
  f.cleanup.mockImplementation(async () => {});
  const second = await f.connect();
  expect(second.lease.session.logicalSessionId).not.toBe(first.lease.session.logicalSessionId);
  expect(f.coordinator.attach).not.toHaveBeenCalled();
  expect(await f.supervisor.shutdown()).toBe(true);
});

test('initialization is serialized and cancellation prevents authority creation after settlement', async () => {
  const f = fixture();
  const initialized = Promise.withResolvers<void>();
  f.coordinator.initialize.mockImplementationOnce(() => initialized.promise);
  const cancelled = new AbortController();
  const pending = f.connect('synthetic-controller-boot', cancelled.signal);
  await expect(f.connect()).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  cancelled.abort(new Error('Synthetic cancelled connection'));
  initialized.resolve();
  await expect(pending).rejects.toThrow('Synthetic cancelled connection');
  expect(f.coordinator.open).not.toHaveBeenCalled();
  expect((await f.connect()).lease.signal.aborted).toBe(false);
  expect(await f.supervisor.shutdown()).toBe(true);
});

test('cancellation during old-session cleanup cannot publish a replacement or release unsettled cleanup', async () => {
  const f = fixture();
  await f.connect();
  const stopped = Promise.withResolvers<void>();
  f.cleanup.mockImplementationOnce(() => stopped.promise);
  const cancelled = new AbortController();
  const replacement = f.connect('synthetic-replacement-boot', cancelled.signal);
  await tick();
  cancelled.abort(new Error('Synthetic cancelled replacement'));
  await expect(f.connect()).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  expect(f.supervisor.status).toBe('cleaning-up');
  expect(f.coordinator.open).toHaveBeenCalledTimes(1);
  stopped.resolve();
  await expect(replacement).rejects.toThrow('Synthetic cancelled replacement');
  expect(f.supervisor.status).toBe('offline');
  expect(f.coordinator.open).toHaveBeenCalledTimes(1);
  expect((await f.connect('synthetic-replacement-boot')).lease.signal.aborted).toBe(false);
  expect(await f.supervisor.shutdown()).toBe(true);
});

test('failed initialization releases only the connection admission and may retry', async () => {
  const f = fixture();
  f.coordinator.initialize.mockRejectedValueOnce(new Error('Synthetic initialization failure'));
  await expect(f.connect()).rejects.toThrow('Synthetic initialization failure');
  expect(f.coordinator.open).not.toHaveBeenCalled();
  expect((await f.connect()).lease.signal.aborted).toBe(false);
  expect(await f.supervisor.shutdown()).toBe(true);
});

test('invalid or already-cancelled connection requests do not initialize', async () => {
  const f = fixture();
  await expect(f.connect('')).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  await expect(f.connect('synthetic-controller-boot', AbortSignal.abort(new Error('Synthetic cancelled request'))))
    .rejects.toThrow('Synthetic cancelled request');
  expect(f.coordinator.initialize).not.toHaveBeenCalled();
  expect(f.coordinator.open).not.toHaveBeenCalled();
});
