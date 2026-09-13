import { afterEach, expect, mock, test } from 'bun:test';
import type { NodeProviderManifest } from '../provider-manifest.js';
import { ControllerNodeHandshake } from '../controller-handshake.js';
import { NodeControllerHandshake, type NodeControllerHandshakeOptions } from '../../execution-node/controller-handshake.js';
import type { NodeHostedConnection } from '../../execution-node/session-coordinator.js';
import { NodeSupervisor } from '../../execution-node/supervisor.js';
import { manifest, tick } from '../../execution-node/worker/__tests__/lifecycle-fixture.js';
import { parseNodeSessionFrameText, serializeNodeSessionFrame, type NodeSessionAccepted } from '../transport/session-wire.js';
import type { NodeSocketWriter } from '../transport/socket-writer.js';
import { DomainError } from '../../lib/domain-error.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

function fixture() {
  const physical = new AbortController();
  const worker = Promise.withResolvers<readonly NodeProviderManifest[]>();
  const nodeFrames: string[] = []; const controllerFrames: string[] = [];
  const deadlines: { fire(): void; delayMs: number; cancel: ReturnType<typeof mock> }[] = [];
  const heartbeats: (() => void)[] = [];
  const scheduleTimeout = (fire: () => void, delayMs: number) => {
    const timer = { fire, delayMs, cancel: mock(() => {}) }; deadlines.push(timer); return timer;
  };
  let elapsedMs = 0;
  const clock = { read: () => ({ elapsedMs, discontinuity: false }) };
  const supervisor = new NodeSupervisor({ cleanup: async () => {}, clock });
  const connect = mock<NodeControllerHandshakeOptions['connect']>(async (controllerBootId, signal) => {
    signal.throwIfAborted();
    const session = supervisor.openSession(controllerBootId);
    return { connectionId: 1, lease: supervisor.attach(session), ready: worker.promise };
  });
  const nodeWriter = {
    send: mock((text: string) => { nodeFrames.push(text); return true; }),
    drained: mock(async (_signal: AbortSignal) => {}), close: mock(() => {}),
  } satisfies Pick<NodeSocketWriter, 'send' | 'drained' | 'close'>;
  const controllerWriter = {
    send: mock((text: string) => { controllerFrames.push(text); return true; }), close: mock(() => {}),
  } satisfies Pick<NodeSocketWriter, 'send' | 'close'>;
  const connected = mock((_connection: NodeHostedConnection) => {});
  const nodeReady = mock((_connection: NodeHostedConnection) => {});
  const disconnect = mock((_connection: NodeHostedConnection) => {});
  const nodeDisconnected = mock((_error: unknown) => {});
  const controllerDisconnected = mock((_error: unknown) => {});
  const accepted = mock((_connection: NodeSessionAccepted) => {});
  const identity = { nodeId: 'synthetic-node', controllerId: 'synthetic-controller-id' };
  const controllerValidate = mock(() => physical.signal.throwIfAborted());
  const node = new NodeControllerHandshake(nodeWriter, { ...identity, signal: physical.signal, supervisor, connect, connected, ready: nodeReady,
    validate() { physical.signal.throwIfAborted(); }, disconnect, disconnected: nodeDisconnected, scheduleTimeout, clock,
    scheduleHeartbeat(callback) { heartbeats.push(callback); return { cancel() {} }; } });
  const controller = new ControllerNodeHandshake(controllerWriter, { ...identity, controllerBootId: 'synthetic-controller-boot', signal: physical.signal,
    validate: controllerValidate, accepted, disconnected: controllerDisconnected, scheduleTimeout, clock });
  const flush = () => {
    for (let round = 0; round < 16; round++) {
      if (!nodeFrames.length && !controllerFrames.length) return;
      while (controllerFrames.length) node.receive(controllerFrames.shift()!);
      while (nodeFrames.length) controller.receive(nodeFrames.shift()!);
    }
    throw new Error('Synthetic handshake did not quiesce');
  };
  const begin = async () => { controller.start(); flush(); await tick(); flush(); };
  disposals.push(async () => { physical.abort(); node.close(); controller.close(); worker.resolve([]); await supervisor.shutdown(); });
  return { node, controller, supervisor, physical, worker, connect, connected, nodeReady, accepted, nodeDisconnected, controllerDisconnected,
    disconnect, nodeWriter, controllerWriter, controllerValidate, nodeFrames, controllerFrames, deadlines, heartbeats, flush, begin,
    setTime(value: number) { elapsedMs = value; } };
}

test('establishes exact boot authority and renews while startup is pending without opening admission', async () => {
  const f = fixture(); await f.begin();
  expect(f.connect).toHaveBeenCalledTimes(1);
  const connection = f.connected.mock.calls[0]![0];
  expect(f.accepted.mock.calls[0]![0]).toMatchObject({ session: connection.lease.session, connectionId: 1 });
  expect(Object.isFrozen(f.accepted.mock.calls[0]![0].session)).toBe(true);
  expect(f.supervisor.status).toBe('recovering');
  expect(f.nodeReady).not.toHaveBeenCalled();
  expect(() => f.supervisor.assertAdmission(connection.lease)).toThrow();
  f.setTime(5000);
  f.heartbeats.shift()!(); f.flush();
  f.setTime(16_000);
  f.supervisor.poll();
  expect(connection.lease.authoritySignal.aborted).toBe(false);
  expect(f.deadlines.map((timer) => timer.delayMs)).toEqual([10_000, 10_000, 60_000]);
  f.deadlines[0]!.fire(); f.deadlines[1]!.fire();
  expect(f.nodeDisconnected).not.toHaveBeenCalled();
  expect(f.controllerDisconnected).not.toHaveBeenCalled();
  f.worker.resolve([manifest()]); await tick(); f.flush();
  expect((await f.controller.ready).manifests).toEqual([manifest()]);
});

test('worker readiness advertises only captured manifests and leaves recovery admission closed', async () => {
  const f = fixture(); await f.begin();
  f.worker.resolve([manifest()]); await tick(); f.flush();
  const ready = await f.controller.ready;
  expect(ready.manifests).toEqual([manifest()]);
  expect(f.nodeReady).toHaveBeenCalledTimes(1);
  expect(f.supervisor.status).toBe('recovering');
  expect(f.nodeDisconnected).not.toHaveBeenCalled();
  expect(f.controllerDisconnected).not.toHaveBeenCalled();
  expect(f.deadlines.every((timer) => timer.cancel.mock.calls.length === 1)).toBe(true);
});

test.each(['timer', 'clock'] as const)('accepted worker readiness timeout has its own %s failure reason', async (expiry) => {
  const f = fixture(); await f.begin();
  if (expiry === 'timer') f.deadlines[2]!.fire();
  else {
    f.setTime(60_000);
    f.worker.resolve([manifest()]); await tick(); f.flush();
  }
  await expect(f.controller.ready).rejects.toMatchObject({ code: 'NODE_READINESS_TIMEOUT' });
  expect(f.controllerDisconnected.mock.calls[0]![0]).toMatchObject({ code: 'NODE_READINESS_TIMEOUT' });
  expect(f.controllerDisconnected).toHaveBeenCalledTimes(1);
});

test.each(['NODE_SESSION_EXPIRED', 'NODE_REMOVED', 'NODE_UNAUTHORIZED'] as const)('preserves %s as the reason an established controller channel closes', async (code) => {
  const f = fixture(); await f.begin();
  f.worker.resolve([manifest()]); await tick(); f.flush(); await f.controller.ready;
  f.controllerValidate.mockImplementation(() => { throw new DomainError(code, 'Synthetic authorization lost', 403); });
  f.setTime(5000); f.heartbeats.shift()!(); f.flush();
  expect(f.controllerDisconnected.mock.calls[0]?.[0]).toMatchObject({ code });
  expect(f.controllerDisconnected).toHaveBeenCalledTimes(1);
});

test('an incompatible hello is rejected before connecting and its diagnostic drains before closure', async () => {
  const f = fixture();
  f.controller.start();
  const hello = JSON.parse(f.controllerFrames.shift()!);
  const drained = Promise.withResolvers<void>(); f.nodeWriter.drained.mockImplementationOnce(() => drained.promise);
  f.node.receive(JSON.stringify({ ...hello, version: 2 }));
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.nodeWriter.close).not.toHaveBeenCalled();
  expect(parseNodeSessionFrameText(f.nodeFrames[0]!)).toEqual({ type: 'node-session-rejected', version: 1, code: 'NODE_INCOMPATIBLE' });
  f.flush();
  await expect(f.controller.ready).rejects.toMatchObject({ code: 'NODE_INCOMPATIBLE' });
  drained.resolve(); await tick();
  expect(f.nodeDisconnected).toHaveBeenCalledTimes(1);
});

test.each(['controllerId', 'nodeId'])('a mismatched paired %s cannot open authority', async (field) => {
  const f = fixture(); f.controller.start();
  const hello = JSON.parse(f.controllerFrames.shift()!);
  f.node.receive(JSON.stringify({ ...hello, [field]: 'synthetic-foreign' }));
  await tick();
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.nodeDisconnected.mock.calls[0]![0]).toMatchObject({ code: 'NODE_PROTOCOL' });
  expect(f.supervisor.status).toBe('offline');
});

test('duplicate hello cannot launch another worker while the first connection is pending', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<NodeHostedConnection>(); f.connect.mockImplementationOnce(() => pending.promise);
  f.controller.start();
  const hello = f.controllerFrames.shift()!;
  f.node.receive(hello); f.node.receive(hello);
  const lease = f.supervisor.attach(f.supervisor.openSession('synthetic-controller-boot'));
  pending.resolve({ connectionId: 1, lease, ready: f.worker.promise });
  await tick();
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.nodeDisconnected).toHaveBeenCalledTimes(1);
  expect(f.disconnect).toHaveBeenCalledTimes(1);
  expect(lease.signal.aborted).toBe(true);
  expect(lease.authoritySignal.aborted).toBe(false);
  expect(f.nodeFrames).toHaveLength(0);
});

test('physical closure during startup suppresses late ready and preserves the logical worker lease', async () => {
  const f = fixture(); await f.begin();
  const connection = f.connected.mock.calls[0]![0];
  f.physical.abort();
  f.worker.resolve([manifest()]); await tick();
  expect(f.nodeFrames).toHaveLength(0);
  expect(f.nodeReady).not.toHaveBeenCalled();
  expect(connection.lease.signal.aborted).toBe(true);
  expect(connection.lease.authoritySignal.aborted).toBe(false);
  expect(f.nodeDisconnected).toHaveBeenCalledTimes(1);
  await expect(f.controller.ready).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
});

test('stale physical closure cannot disconnect a replacement lease or emit late startup metadata', async () => {
  const f = fixture(); await f.begin();
  const prior = f.connected.mock.calls[0]![0];
  const next = f.supervisor.attach(prior.lease.session);
  f.node.close(); f.worker.resolve([manifest()]); await tick();
  expect(next.signal.aborted).toBe(false);
  expect(next.authoritySignal.aborted).toBe(false);
  expect(f.nodeReady).not.toHaveBeenCalled();
  expect(f.nodeFrames).toHaveLength(0);
});

test('initial handshake timeout closes physical delivery once and never advertises a late connection', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<NodeHostedConnection>();
  f.connect.mockImplementationOnce(() => pending.promise);
  await f.begin();
  f.deadlines[0]!.fire();
  const lease = f.supervisor.attach(f.supervisor.openSession('synthetic-controller-boot'));
  pending.resolve({ connectionId: 1, lease, ready: f.worker.promise });
  f.worker.resolve([manifest()]); await tick();
  expect(f.nodeDisconnected.mock.calls).toHaveLength(1);
  expect(f.nodeDisconnected.mock.calls[0]![0]).toMatchObject({ code: 'NODE_HANDSHAKE_TIMEOUT' });
  expect(f.nodeReady).not.toHaveBeenCalled();
  expect(f.nodeFrames).toHaveLength(0);
  expect(lease.signal.aborted).toBe(true);
});

test('controller rejects a stale boot before accepting a session or answering its lease challenge', async () => {
  const f = fixture(); f.controller.start();
  f.controllerFrames.length = 0;
  const session = f.supervisor.openSession('synthetic-stale-controller-boot');
  f.controller.receive(serializeNodeSessionFrame({ type: 'node-session-accepted', version: 1, controllerId: 'synthetic-controller-id',
    nodeId: 'synthetic-node', session, connectionId: 1, readinessTimeoutMs: 60_000 }));
  await expect(f.controller.ready).rejects.toMatchObject({ code: 'NODE_PROTOCOL' });
  expect(f.accepted).not.toHaveBeenCalled();
  expect(f.controllerFrames).toHaveLength(0);
});

test('controller rejects a foreign instance manifest and unexpected physical readiness', async () => {
  const f = fixture(); await f.begin();
  const connection = f.connected.mock.calls[0]![0];
  f.controller.receive(serializeNodeSessionFrame({ type: 'node-session-ready', version: 1, session: connection.lease.session,
    connectionId: connection.connectionId, manifests: [{ ...manifest(), nodeId: 'synthetic-foreign' }] }));
  await expect(f.controller.ready).rejects.toMatchObject({ code: 'NODE_PROTOCOL' });
  expect(f.controllerDisconnected).toHaveBeenCalledTimes(1);
});

test('a refused acceptance frame suspends the hop without retiring logical authority', async () => {
  const f = fixture(); f.nodeWriter.send.mockReturnValueOnce(false);
  await f.begin();
  const connection = f.connected.mock.calls[0]![0];
  expect(connection.lease.signal.aborted).toBe(true);
  expect(connection.lease.authoritySignal.aborted).toBe(false);
  expect(f.nodeReady).not.toHaveBeenCalled();
  expect(f.nodeDisconnected).toHaveBeenCalledTimes(1);
});
