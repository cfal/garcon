import { expect, mock, test } from 'bun:test';
import { NodeWorkerBootstrap, type NodeWorkerRuntime, type NodeWorkerRuntimeContext } from '../bootstrap.js';
import { NodeWorkerLifeline, NODE_WORKER_PULSE_TIMEOUT_MS } from '../lifeline.js';
import { type NodeWorkerGateMessage, type NodeWorkerParentMessage, serializeNodeWorkerParent } from '../protocol.js';
import { configureMessage, manifest, session, tick } from './lifecycle-fixture.js';
import { serializeNodeWorkerExecution } from '../execution-protocol.js';
import { serializeNodeWorkerOutputRetirement } from '../output-retirement.js';

function fixture() {
  let now = 0;
  const lifeline = new NodeWorkerLifeline({ clock: { read: () => ({ elapsedMs: now, discontinuity: false }) },
    scheduleTimeout: () => ({ cancel() {} }), retired() {} });
  const started = Promise.withResolvers<NodeWorkerRuntime>();
  const start = mock((_context: NodeWorkerRuntimeContext) => started.promise);
  const runtime = { manifests: [manifest()], control: mock(async (_message: NodeWorkerGateMessage) => {}), application: mock((_frame: unknown, _text: string) => {}), close: mock(async () => {}) } satisfies NodeWorkerRuntime;
  const failed = mock(() => {});
  const send = mock(async (_text: string) => {});
  const bootstrap = new NodeWorkerBootstrap({ role: 'session', lifeline, start, failed, send });
  const receive = (message: NodeWorkerParentMessage) => bootstrap.receive(serializeNodeWorkerParent(message));
  return { bootstrap, lifeline, start, started, runtime, failed, send, receive,
    advance(ms: number) { now += ms; }, async dispose() { started.resolve(runtime); await bootstrap.close(); } };
}

test('configuration starts one runtime, keeps admissions closed and reads pulses while initialization waits', async () => {
  const f = fixture();
  try {
    expect(f.start).not.toHaveBeenCalled();
    f.receive(configureMessage());
    const authority = f.start.mock.calls[0]![0].authority;
    expect(() => authority.assertAdmission(authority.connection(1))).toThrow();
    f.advance(NODE_WORKER_PULSE_TIMEOUT_MS - 1);
    f.receive({ type: 'node-worker-pulse', version: 1, session, connectionId: 1 });
    f.advance(NODE_WORKER_PULSE_TIMEOUT_MS - 1);
    expect(() => f.lifeline.poll()).not.toThrow();
    expect(f.send).not.toHaveBeenCalled();
    f.started.resolve(f.runtime);
    await tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.receive({ type: 'node-worker-admit', version: 1, session, connectionId: 1 });
    expect(() => authority.assertAdmission(authority.connection(1))).not.toThrow();
    expect(f.runtime.control).toHaveBeenCalledTimes(1);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

test('EOF retires pending initialization immediately and closes its eventual runtime without ready', async () => {
  const f = fixture();
  f.receive(configureMessage());
  const authority = f.start.mock.calls[0]![0].authority;
  const closing = f.bootstrap.close();
  expect(f.bootstrap.close()).toBe(closing);
  expect(authority.signal.aborted).toBe(true);
  expect(f.lifeline.signal.aborted).toBe(true);
  f.started.resolve(f.runtime);
  await closing;
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.failed).not.toHaveBeenCalled();
});

test('connection replacement during initialization reaches descendants before readiness', async () => {
  const f = fixture();
  try {
    f.receive(configureMessage());
    const authority = f.start.mock.calls[0]![0].authority;
    const previous = authority.connection(1);
    f.receive({ type: 'node-worker-attach', version: 1, session, connectionId: 2 });
    f.receive({ type: 'node-worker-disconnect', version: 1, session, connectionId: 1 });
    expect(previous.signal.aborted).toBe(true);
    expect(authority.connection(2).signal.aborted).toBe(false);
    f.receive({ type: 'node-worker-disconnect', version: 1, session, connectionId: 2 });
    f.receive({ type: 'node-worker-disconnect', version: 1, session, connectionId: 2 });
    f.started.resolve(f.runtime);
    await tick();
    expect(f.runtime.control.mock.calls.map(([message]) => [message.type, message.connectionId])).toEqual([
      ['node-worker-attach', 2], ['node-worker-disconnect', 2] ]);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(() => authority.connection(2)).toThrow();
    f.receive({ type: 'node-worker-attach', version: 1, session, connectionId: 3 });
    expect(f.runtime.control).toHaveBeenCalledTimes(3);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

test('a repeated disconnect after readiness is not forwarded to instance peers', async () => {
  const f = fixture();
  try {
    f.receive(configureMessage()); f.started.resolve(f.runtime); await tick();
    f.receive({ type: 'node-worker-disconnect', version: 1, session, connectionId: 1 });
    f.receive({ type: 'node-worker-disconnect', version: 1, session, connectionId: 1 });
    await tick();
    expect(f.runtime.control).toHaveBeenCalledTimes(1);
    expect(f.failed).not.toHaveBeenCalled();
    expect(f.lifeline.signal.aborted).toBe(false);
  } finally { await f.dispose(); }
});

test('disconnect during an awaited initialization attach is forwarded exactly once', async () => {
  const f = fixture();
  const attached = Promise.withResolvers<void>();
  f.runtime.control.mockImplementation(async (message) => {
    if (message.type === 'node-worker-attach') await attached.promise;
  });
  try {
    f.receive(configureMessage());
    f.receive({ type: 'node-worker-attach', version: 1, session, connectionId: 2 });
    f.started.resolve(f.runtime);
    await tick();
    expect(f.send).not.toHaveBeenCalled();
    f.receive({ type: 'node-worker-disconnect', version: 1, session, connectionId: 2 });
    attached.resolve();
    await tick();
    expect(f.runtime.control.mock.calls.map(([message]) => [message.type, message.connectionId])).toEqual([
      ['node-worker-attach', 2], ['node-worker-disconnect', 2],
    ]);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.lifeline.signal.aborted).toBe(false);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { attached.resolve(); await f.dispose(); }
});

test('execution frames reach only a ready runtime on the current physical connection', async () => {
  const f = fixture();
  const frame = { type: 'node-worker-execution', version: 1, session, connectionId: 1, instanceId: 'synthetic-instance', payload: '{}' } as const;
  try {
    f.receive(configureMessage()); f.started.resolve(f.runtime); await tick();
    f.bootstrap.receive(serializeNodeWorkerExecution(frame));
    expect(f.runtime.application).toHaveBeenCalledWith(frame, serializeNodeWorkerExecution(frame));
    f.receive({ type: 'node-worker-attach', version: 1, session, connectionId: 2 });
    f.bootstrap.receive(serializeNodeWorkerExecution(frame));
    expect(f.runtime.application).toHaveBeenCalledTimes(1);
    f.bootstrap.receive(serializeNodeWorkerExecution({ ...frame, connectionId: 2 }));
    expect(f.runtime.application).toHaveBeenCalledTimes(2);
    f.receive({ type: 'node-worker-disconnect', version: 1, session, connectionId: 2 });
    f.bootstrap.receive(serializeNodeWorkerExecution({ ...frame, connectionId: 2 }));
    expect(f.runtime.application).toHaveBeenCalledTimes(2);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

test('execution received before readiness retires authority without dispatching', async () => {
  const f = fixture();
  try {
    f.receive(configureMessage());
    f.bootstrap.receive(serializeNodeWorkerExecution({ type: 'node-worker-execution', version: 1, session, connectionId: 1,
      instanceId: 'synthetic-instance', payload: '{}' }));
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.runtime.application).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

test('logical stream retirement still reaches a disconnected runtime', async () => {
  const f = fixture();
  try {
    f.receive(configureMessage()); f.started.resolve(f.runtime); await tick();
    f.receive({ type: 'node-worker-disconnect', version: 1, session, connectionId: 1 });
    const frame = { type: 'node-worker-output-retired', version: 1, instanceId: 'synthetic-instance',
      stream: { ...session, streamId: 'synthetic-stream' } } as const;
    const text = serializeNodeWorkerOutputRetirement(frame);
    f.bootstrap.receive(text);
    expect(f.runtime.application).toHaveBeenCalledWith(frame, text);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

test.each(['duplicate configuration', 'early admission', 'foreign session', 'stale pulse', 'malformed'])(
  '%s fails initialization closed without sending ready', async (cause) => {
    const f = fixture();
    f.receive(configureMessage());
    if (cause === 'duplicate configuration') f.receive(configureMessage());
    else if (cause === 'malformed') f.bootstrap.receive('{}');
    else f.receive({ type: cause === 'early admission' ? 'node-worker-admit' : 'node-worker-pulse', version: 1,
      session: cause === 'foreign session' ? { ...session, logicalSessionId: 'foreign' } : session,
      connectionId: cause === 'stale pulse' ? 2 : 1 });
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.lifeline.signal.aborted).toBe(true);
    f.started.resolve(f.runtime);
    await f.bootstrap.close();
    expect(f.runtime.close).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  },
);
