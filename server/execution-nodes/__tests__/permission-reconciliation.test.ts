import { afterEach, expect, mock, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { NodeWorkerTransportError } from '../../execution-node/worker/framing.js';
import { NodeWorkerServiceClient, NodeWorkerServiceReplyError } from '../../execution-node/worker/service-channel.js';
import { parseNodeWorkerServiceText, serializeNodeWorkerService, type NodeWorkerServiceCommand, type NodeWorkerServiceFrame,
  type NodeWorkerServiceResult } from '../../execution-node/worker/service-protocol.js';
import { NodePermissionReconciliation, type NodePermissionConnection, type NodePermissionReconciliationOptions } from '../permission-reconciliation.js';
import type { NodePermissionReceipt, NodePermissionReference } from '../transport/permission-wire.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const reference = (index = 1): NodePermissionReference => ({ stream: { ...session, streamId: 'synthetic-stream' },
  runId: 'synthetic-run', handle: `synthetic-handle-${index}`, permissionOccurrenceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` });
const receipt = (permission = reference(), phase: NodePermissionReceipt['phase'] = 'available'): NodeWorkerServiceResult =>
  ({ kind: 'permission-result', result: { kind: 'permission', receipt: { permission, phase } } });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture(overrides: Partial<NodePermissionReconciliationOptions> = {}) {
  const lifetime = new AbortController(); const source = new AbortController();
  let live = true; let admitting = true; let now = 0; let next = 0;
  const timers = new Set<{ callback(): void; delay: number }>();
  const manager = new NodePermissionReconciliation({ session, signal: lifetime.signal, validate() {},
    assertAdmission() { if (!admitting) throw new Error('synthetic recovery gate'); }, now: () => now,
    scheduleTimeout(callback, delay) { const timer = { callback, delay }; timers.add(timer); return { cancel() { timers.delete(timer); } }; }, ...overrides });
  cleanup.push(() => lifetime.abort());
  const calls: { connectionId: number; command: NodeWorkerServiceCommand; signal: AbortSignal }[] = [];
  const handler = mock(async (command: NodeWorkerServiceCommand, _signal: AbortSignal): Promise<NodeWorkerServiceResult> => {
    if (command.method !== 'permission') throw new Error('Unexpected fixture command');
    return receipt(command.command.permission, command.command.method === 'permission-respond' ? 'resolved' : 'available');
  });
  const connection = () => {
    const closing = new AbortController(); const connectionId = ++next;
    return { session, connectionId, signal: closing.signal, validate() { closing.signal.throwIfAborted(); },
      service: { async call(command, signal) { calls.push({ connectionId, command, signal }); return handler(command, signal); } },
      disconnect() { closing.abort(); },
    } satisfies NodePermissionConnection & { disconnect(): void };
  };
  const connect = async () => { const physical = connection(); manager.attach(physical); await manager.reconcile(physical.connectionId, physical.signal); return physical; };
  return { manager, lifetime, source, calls, handler, connection, connect, timers,
    capture: (index = 1) => manager.capture(reference(index), source.signal, () => live),
    setLive(value: boolean) { live = value; }, setAdmitting(value: boolean) { admitting = value; }, setTime(value: number) { now = value; },
    fire(delay: number) { const timer = [...timers].find((timer) => timer.delay === delay); if (!timer) throw new Error('Missing synthetic timer'); timers.delete(timer); timer.callback(); },
    responses: () => calls.filter(({ command }) => command.method === 'permission' && command.command.method === 'permission-respond'),
  };
}

test('a resolved exact receipt completes the captured decision and drops every response timer', async () => {
  const f = fixture(); const capability = f.capture(); await f.connect();
  await expect(capability.respond({ allow: true })).resolves.toBeUndefined();
  expect(f.responses()).toHaveLength(1); expect(f.timers.size).toBe(0);
  expect(f.responses()[0]?.command).toMatchObject({ command: { permission: reference(), decision: { allow: true } } });
});

test.each(['unavailable', 'stalled'] as const)('a %s status cannot stop a sibling from polling to resolution', async (mode) => {
  const f = fixture(); const first = f.capture(1); const second = f.capture(2);
  await f.connect();
  const stalled = Promise.withResolvers<NodeWorkerServiceResult>();
  let firstReads = 0; let secondReads = 0;
  f.handler.mockImplementation(async (command) => {
    if (command.method !== 'permission') throw new Error('Unexpected fixture command');
    const permission = command.command.permission;
    if (command.command.method === 'permission-respond') return receipt(permission, 'pending');
    if (permission.handle === reference(1).handle) {
      firstReads++;
      return mode === 'stalled' ? stalled.promise : { kind: 'unknown' };
    }
    secondReads++;
    return receipt(permission, secondReads === 1 ? 'pending' : 'resolved');
  });
  const firstResult = first.respond({ allow: true }); void firstResult.catch(() => {});
  const secondResult = second.respond({ allow: true }); void secondResult.catch(() => {});
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.fire(250);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondReads).toBe(1);
    f.fire(250);
    await secondResult;
    expect(secondReads).toBe(2);
    expect(firstReads).toBe(mode === 'stalled' ? 1 : 2);
    expect(f.responses()).toHaveLength(2);
    f.setTime(30_000); f.fire(30_000);
    await expect(firstResult).rejects.toMatchObject({ code: 'PERMISSION_DECISION_OUTCOME_UNKNOWN' });
    const reads = f.calls.filter(({ command }) => command.method === 'permission' && command.command.method === 'permission-status'
      && command.command.permission.handle === reference(1).handle);
    expect(reads.at(-1)!.signal.aborted).toBe(true);
  } finally {
    stalled.resolve(receipt(reference(1), 'resolved'));
    f.lifetime.abort();
    await Promise.allSettled([firstResult, secondResult]);
  }
});

test('lost decision replies reconcile over a new connection without another mutation', async () => {
  const f = fixture(); const capability = f.capture(); const old = await f.connect();
  const reply = Promise.withResolvers<NodeWorkerServiceResult>();
  f.handler.mockImplementationOnce(() => reply.promise);
  let resolved = false;
  const response = capability.respond({ allow: true }).then(() => { resolved = true; });
  old.disconnect();
  f.handler.mockImplementationOnce(async () => receipt(reference(), 'resolved'));
  await f.connect(); await response;
  expect(resolved).toBe(true); expect(f.responses()).toHaveLength(1);
  reply.resolve({ kind: 'rejected', code: 'NODE_CAPACITY' });
  await Promise.resolve(); await Promise.resolve();
  await expect(capability.respond({ allow: false })).rejects.toThrow('different decision');
  expect(f.responses()).toHaveLength(1);
});

test.each(['unknown', 'expired', null] as const)('a %s reconciliation receipt cannot claim successful delivery', async (phase) => {
  const f = fixture(); const capability = f.capture(); const physical = await f.connect();
  f.handler.mockImplementationOnce(async () => ({ kind: 'unknown' }));
  const response = capability.respond({ allow: true });
  void response.catch(() => {});
  f.handler.mockImplementationOnce(async () => phase === null ? { kind: 'permission-result', result: { kind: 'permission', receipt: null } } : receipt(reference(), phase));
  await f.manager.reconcile(physical.connectionId, physical.signal);
  await expect(response).rejects.toMatchObject({ code: phase === 'expired' ? 'PERMISSION_NOT_ACTIONABLE' : 'PERMISSION_DECISION_OUTCOME_UNKNOWN' });
  expect(f.responses()).toHaveLength(1);
  const calls = f.calls.length;
  await f.manager.reconcile(physical.connectionId, physical.signal);
  expect(f.calls).toHaveLength(calls);
  await expect(capability.respond({ allow: true })).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
});

test.each([false, true])('a never-delivered decision permits another explicit choice after recovery, timed out: %s', async (timedOut) => {
  const f = fixture(); const capability = f.capture(); const old = await f.connect();
  f.handler.mockImplementationOnce(async () => ({ kind: 'unknown' }));
  const response = capability.respond({ allow: true }); void response.catch(() => {});
  old.disconnect();
  if (timedOut) {
    f.fire(30_000);
    await expect(response).rejects.toMatchObject({ code: 'PERMISSION_DECISION_OUTCOME_UNKNOWN' });
  }
  await f.connect();
  if (!timedOut) await expect(response).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE', retryable: true });
  expect(f.responses()).toHaveLength(1);
  await expect(capability.respond({ allow: false })).resolves.toBeUndefined();
  expect(f.responses()).toHaveLength(2);
  expect(f.responses()[1]?.command).toMatchObject({ command: { decision: { allow: false } } });
});

test('a pending native response survives recovery and completes through bounded status polling', async () => {
  const f = fixture(); const capability = f.capture(); const physical = await f.connect();
  f.handler.mockImplementationOnce(async () => receipt(reference(), 'pending'));
  const response = capability.respond({ allow: true });
  await Promise.resolve(); await Promise.resolve();
  f.handler.mockImplementationOnce(async () => receipt(reference(), 'pending'));
  await f.manager.reconcile(physical.connectionId, physical.signal);
  expect(f.timers.size).toBe(2);
  f.handler.mockImplementationOnce(async () => receipt(reference(), 'resolved'));
  f.fire(250); await response;
  expect(f.responses()).toHaveLength(1); expect(f.timers.size).toBe(0);
});

test('an older available receipt cannot undo positive evidence that the decision was submitted', async () => {
  const f = fixture(); const capability = f.capture(); const physical = await f.connect();
  f.handler.mockImplementationOnce(async () => receipt(reference(), 'pending'));
  const response = capability.respond({ allow: true });
  await Promise.resolve(); await Promise.resolve();
  await f.manager.reconcile(physical.connectionId, physical.signal);
  await expect(capability.respond({ allow: false })).rejects.toThrow('different decision');
  f.handler.mockImplementationOnce(async () => receipt(reference(), 'resolved'));
  f.fire(250); await response;
  expect(f.responses()).toHaveLength(1);
});

test('definitive refusal permits a fresh explicit decision while unknown delivery never resends', async () => {
  const f = fixture(); const capability = f.capture(); const physical = await f.connect();
  f.handler.mockImplementationOnce(async () => ({ kind: 'rejected', code: 'NODE_CAPACITY' }));
  await expect(capability.respond({ allow: true })).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  await expect(capability.respond({ allow: false })).resolves.toBeUndefined();
  expect(f.responses()).toHaveLength(2);
  await f.manager.reconcile(physical.connectionId, physical.signal);
  await expect(capability.respond({ allow: true })).rejects.toThrow('different decision');
  expect(f.responses()).toHaveLength(2);
});

test('disconnected and recovering permissions cannot enqueue a decision', async () => {
  const f = fixture(); const capability = f.capture();
  await expect(capability.respond({ allow: true })).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE', retryable: true });
  const physical = f.connection(); f.manager.attach(physical);
  await expect(capability.respond({ allow: true })).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE', retryable: true });
  await f.manager.reconcile(physical.connectionId, physical.signal); f.setAdmitting(false);
  await expect(capability.respond({ allow: true })).rejects.toThrow('recovery gate');
  expect(f.responses()).toEqual([]);
});

test('a closed permission authority refuses decisions permanently', async () => {
  const f = fixture(); const capability = f.capture(); await f.connect();
  f.manager.close();
  await expect(capability.respond({ allow: true })).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE', retryable: false });
  expect(f.responses()).toEqual([]);
});

test.each(['source', 'run', 'logical'] as const)('%s retirement rejects an in-flight response and leaves late completion inert', async (kind) => {
  const f = fixture(); const capability = f.capture(); await f.connect();
  const reply = Promise.withResolvers<NodeWorkerServiceResult>(); f.handler.mockImplementationOnce(() => reply.promise);
  const response = capability.respond({ allow: true }); void response.catch(() => {});
  if (kind === 'source') f.source.abort();
  else if (kind === 'run') f.manager.retireRun(reference().stream, reference().runId);
  else f.lifetime.abort();
  await expect(response).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' }); reply.resolve(receipt(reference(), 'resolved'));
  expect(f.responses()[0]?.signal.aborted).toBe(true); expect(f.timers.size).toBe(0);
});

test('late historical permissions remain inert and consumed identities never rebind', async () => {
  const f = fixture({ maxIdentities: 1 }); f.setLive(false); const capability = f.capture(); await f.connect();
  await expect(capability.respond({ allow: true })).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
  expect(f.calls).toEqual([]);
  expect(() => f.capture()).toThrow('cannot be rebound'); expect(() => f.capture(2)).toThrow('capacity');
});

test('the response ceiling reserves service capacity and timeout cannot enable resubmission', async () => {
  const f = fixture({ maxResponses: 1 }); const first = f.capture(); const second = f.capture(2); await f.connect();
  f.handler.mockImplementationOnce(() => new Promise(() => {}));
  const response = first.respond({ allow: true }); void response.catch(() => {});
  await expect(second.respond({ allow: true })).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  f.fire(30_000); await expect(response).rejects.toMatchObject({ code: 'PERMISSION_DECISION_OUTCOME_UNKNOWN' });
  await expect(second.respond({ allow: true })).resolves.toBeUndefined();
  expect(f.responses()).toHaveLength(2);
});

test('a delayed timer cannot allow a late resolved receipt to finish the original response', async () => {
  const f = fixture(); const capability = f.capture(); await f.connect();
  const reply = Promise.withResolvers<NodeWorkerServiceResult>(); f.handler.mockImplementationOnce(() => reply.promise);
  const response = capability.respond({ allow: true }); void response.catch(() => {});
  f.setTime(30_000); reply.resolve(receipt(reference(), 'resolved'));
  await expect(response).rejects.toMatchObject({ code: 'PERMISSION_DECISION_OUTCOME_UNKNOWN' });
  expect(f.responses()).toHaveLength(1); expect(f.timers.size).toBe(0);
});

test('foreign receipt identity retires its owner before failing recovery and leaves siblings recoverable', async () => {
  const f = fixture(); const capability = f.capture(); const physical = await f.connect();
  f.handler.mockImplementationOnce(async () => ({ kind: 'unknown' }));
  const response = capability.respond({ allow: true }); void response.catch(() => {});
  f.handler.mockImplementationOnce(async () => receipt(reference(2), 'resolved'));
  await expect(f.manager.reconcile(physical.connectionId, physical.signal)).rejects.toThrow('identity');
  await expect(response).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
  const sibling = f.capture(2);
  await f.connect();
  await expect(sibling.respond({ allow: true })).resolves.toBeUndefined();
  expect(f.responses()).toHaveLength(2);
  await expect(capability.respond({ allow: true })).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
});

test.each(['rejected', 'unknown'] as const)('a transient %s status preserves an occurrence for the next recovery', async (kind) => {
  const f = fixture(); const capability = f.capture(); const physical = await f.connect();
  f.handler.mockImplementationOnce(async () => kind === 'rejected' ? { kind, code: 'NODE_UNAVAILABLE' } : { kind });
  await expect(f.manager.reconcile(physical.connectionId, physical.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  const sibling = f.capture(2);
  await f.connect();
  await expect(capability.respond({ allow: true })).resolves.toBeUndefined();
  await expect(sibling.respond({ allow: true })).resolves.toBeUndefined();
  expect(f.responses()).toHaveLength(2);
});

test.each(['NODE_UNAVAILABLE', 'NODE_CAPACITY', 'VALIDATION_FAILED', 'NODE_SESSION_EXPIRED'] as const)('a node status refusal retires only definitive authority failure: %s', async (code) => {
  const f = fixture(); const capability = f.capture(); const physical = await f.connect();
  f.handler.mockImplementationOnce(async () => ({ kind: 'permission-result', result: { kind: 'rejected', code } }));
  await expect(f.manager.reconcile(physical.connectionId, physical.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  const calls = f.calls.length; await f.connect();
  if (code === 'NODE_SESSION_EXPIRED' || code === 'VALIDATION_FAILED') {
    expect(f.calls).toHaveLength(calls);
    await expect(capability.respond({ allow: true })).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
  } else await expect(capability.respond({ allow: true })).resolves.toBeUndefined();
});

function channel(f: ReturnType<typeof fixture>, maxRequests = 16) {
  const physical = f.connection();
  const requests: Extract<NodeWorkerServiceFrame, { type: 'node-worker-service-request' }>[] = [];
  const timers = new Set<() => void>(); const failures: unknown[] = [];
  let saturated = false;
  const client = new NodeWorkerServiceClient({ submit(text, _priority, authority) {
    authority.signal.throwIfAborted(); authority.validate();
    const frame = parseNodeWorkerServiceText(materializeNodeFrameText(text));
    if (!frame) throw new Error('Invalid fixture request');
    if (frame.type === 'node-worker-service-request') {
      if (saturated) throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY');
      requests.push(frame);
    }
    return { submitted: true, drained: Promise.resolve() };
  } }, { session, connectionId: physical.connectionId, signal: physical.signal, maxRequests,
    validate: physical.validate, failed(error) { failures.push(error); physical.disconnect(); },
    scheduleTimeout(callback) { timers.add(callback); return { cancel() { timers.delete(callback); } }; },
  });
  cleanup.push(() => client.close());
  f.manager.attach({ ...physical, service: client });
  return { ...physical, client, requests, failures,
    setSaturated(value: boolean) { saturated = value; },
    expireRead() {
      const callback = [...timers].at(-1);
      if (!callback) throw new Error('Missing service timeout');
      callback();
    },
    reply(result: NodeWorkerServiceResult, request = requests.at(-1)) {
      if (!request) throw new Error('Missing service request');
      const parsed = parseNodeWorkerServiceText(serializeNodeWorkerService({ type: 'node-worker-service-result',
        version: NODE_WIRE_VERSION, session, connectionId: physical.connectionId, requestId: request.requestId, result }));
      if (!parsed) throw new Error('Invalid fixture reply');
      client.receive(parsed);
    },
  };
}

test.each(['timeout', 'writer-capacity', 'request-capacity'] as const)('a real service %s during status does not retire an in-flight decision', async (mode) => {
  const f = fixture(); const capability = f.capture(); const link = channel(f, 1);
  const initial = f.manager.reconcile(link.connectionId, link.signal); link.reply(receipt()); await initial;
  let settled = false;
  const response = capability.respond({ allow: true }).finally(() => { settled = true; }); void response.catch(() => {});
  link.reply({ kind: 'unknown' });
  let occupied: Promise<NodeWorkerServiceResult> | undefined;
  if (mode === 'request-capacity') occupied = link.client.call({ method: 'begin-output-recovery' }, link.signal);
  else if (mode === 'writer-capacity') link.setSaturated(true);
  const status = f.manager.reconcile(link.connectionId, link.signal);
  if (mode === 'timeout') link.expireRead();
  await expect(status).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  expect(settled).toBe(false); expect(link.signal.aborted).toBe(false); expect(link.failures).toEqual([]);
  if (occupied) { link.reply({ kind: 'output-recovery', generation: 1 }); await occupied; }
  link.setSaturated(false);
  const retry = f.manager.reconcile(link.connectionId, link.signal); link.reply(receipt(reference(), 'resolved')); await retry;
  await expect(response).resolves.toBeUndefined();
  expect(link.requests.filter(({ command }) => command.method === 'permission' && command.command.method === 'permission-respond')).toHaveLength(1);
});

test.each(['foreign-permission', 'wrong-result'] as const)('a real service %s reply retires only its correlated permission before recovery', async (mode) => {
  const f = fixture(); const capability = f.capture(); const link = channel(f);
  const initial = f.manager.reconcile(link.connectionId, link.signal); link.reply(receipt()); await initial;
  const response = capability.respond({ allow: true }); void response.catch(() => {}); link.reply({ kind: 'unknown' });
  const sibling = f.capture(2);
  const invalid = f.manager.reconcile(link.connectionId, link.signal);
  link.reply(mode === 'foreign-permission' ? receipt(reference(2), 'resolved') : { kind: 'output-live', live: true });
  await expect(invalid).rejects.toBeInstanceOf(NodeWorkerServiceReplyError);
  expect(link.signal.aborted).toBe(true); expect(link.failures).toHaveLength(1);
  await expect(response).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
  const next = channel(f);
  const recovery = f.manager.reconcile(next.connectionId, next.signal);
  expect(next.requests).toHaveLength(1);
  expect(next.requests[0]?.command).toMatchObject({ command: { permission: reference(2) } });
  next.reply(receipt(reference(2))); await recovery;
  await expect(capability.respond({ allow: true })).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
  const accepted = sibling.respond({ allow: true }); next.reply(receipt(reference(2), 'resolved'));
  await expect(accepted).resolves.toBeUndefined();
});

test('a correlated invalid reply from a replaced connection cannot retire the recovered occurrence', async () => {
  const f = fixture(); const capability = f.capture(); const old = channel(f);
  const initial = f.manager.reconcile(old.connectionId, old.signal); old.reply(receipt()); await initial;
  const response = capability.respond({ allow: true }); old.reply({ kind: 'unknown' });
  const obsolete = f.manager.reconcile(old.connectionId, old.signal); void obsolete.catch(() => {});
  old.reply(receipt(reference(2), 'resolved'));
  const next = channel(f);
  const recovered = f.manager.reconcile(next.connectionId, next.signal); next.reply(receipt(reference(), 'resolved'));
  await recovered; await response;
  await expect(obsolete).rejects.toBeInstanceOf(NodeWorkerServiceReplyError);
  await expect(capability.respond({ allow: true })).resolves.toBeUndefined();
  expect(next.requests).toHaveLength(1);
});

test('a same-connection recovery read cannot hide a correlated protocol failure from an in-flight poll', async () => {
  const scheduled = Promise.withResolvers<() => void>();
  const f = fixture({ scheduleTimeout(callback, delay) {
    if (delay === 250) scheduled.resolve(callback);
    return { cancel() {} };
  } });
  const capability = f.capture(); const link = channel(f);
  const initial = f.manager.reconcile(link.connectionId, link.signal); link.reply(receipt()); await initial;
  const response = capability.respond({ allow: true }); void response.catch(() => {}); link.reply({ kind: 'unknown' });
  const poll = await scheduled.promise; poll();
  const request = link.requests.at(-1)!;
  expect(request.command).toMatchObject({ command: { method: 'permission-status' } });
  const sibling = f.capture(2);
  const recovery = f.manager.reconcile(link.connectionId, link.signal);
  expect(link.requests.at(-1)?.requestId).toBeGreaterThan(request.requestId);
  link.reply(receipt(reference(2), 'resolved'), request);
  await expect(recovery).rejects.toThrow();
  expect(link.signal.aborted).toBe(true);
  expect(link.failures).toHaveLength(1);
  expect(link.failures[0]).toBeInstanceOf(NodeWorkerServiceReplyError);
  await expect(capability.respond({ allow: true })).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
  await expect(response).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
  const next = channel(f);
  const recovered = f.manager.reconcile(next.connectionId, next.signal);
  expect(next.requests).toHaveLength(1);
  expect(next.requests[0]?.command).toMatchObject({ command: { permission: reference(2) } });
  next.reply(receipt(reference(2))); await recovered;
  const accepted = sibling.respond({ allow: true }); next.reply(receipt(reference(2), 'resolved'));
  await expect(accepted).resolves.toBeUndefined();
});

test('default permission budgets bound consumed identities, pending responses and response lifetime', async () => {
  const f = fixture();
  const capabilities = Array.from({ length: 16_384 }, (_, index) => f.capture(index + 1));
  expect(() => f.capture(16_385)).toThrow('capacity');
  await f.connect();
  f.handler.mockImplementation(() => new Promise(() => {}));
  const responses = capabilities.slice(0, 8).map((capability) => {
    const response = capability.respond({ allow: true }); void response.catch(() => {}); return response;
  });
  await expect(capabilities[8]!.respond({ allow: true })).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  expect(f.responses()).toHaveLength(8);
  expect([...f.timers].map(({ delay }) => delay)).toEqual(Array(8).fill(30_000));
  f.lifetime.abort();
  expect((await Promise.allSettled(responses)).every((result) => result.status === 'rejected')).toBe(true);
  expect(f.timers.size).toBe(0);
});

test('permission reconciliation rejects invalid or excessive limit overrides', () => {
  for (const limits of [{ maxIdentities: 0 }, { maxIdentities: 65_537 }, { maxResponses: 0 }, { maxResponses: 9 },
    { responseTimeoutMs: 0 }, { responseTimeoutMs: 30_001 }, { maxResponses: 1.5 }, { responseTimeoutMs: NaN }]) {
    expect(() => fixture(limits)).toThrow('Invalid permission reconciliation identity');
  }
});

test('a superseded status reply cannot settle a response on the replacement connection', async () => {
  const f = fixture(); const capability = f.capture(); const old = await f.connect();
  f.handler.mockImplementationOnce(async () => ({ kind: 'unknown' }));
  let settled = false;
  const response = capability.respond({ allow: true }).then(() => { settled = true; });
  const delayed = Promise.withResolvers<NodeWorkerServiceResult>(); f.handler.mockImplementationOnce(() => delayed.promise);
  const obsolete = f.manager.reconcile(old.connectionId, old.signal); void obsolete.catch(() => {});
  old.disconnect(); f.handler.mockImplementationOnce(async () => receipt(reference(), 'pending'));
  await f.connect(); delayed.resolve(receipt(reference(), 'resolved'));
  await expect(obsolete).rejects.toThrow(); expect(settled).toBe(false);
  f.handler.mockImplementationOnce(async () => receipt(reference(), 'resolved'));
  f.fire(250); await response;
  expect(f.responses()).toHaveLength(1);
});

test('an exact occurrence cancellation does not retire a sibling on the same run', async () => {
  const f = fixture(); const first = f.capture(); const second = f.capture(2); await f.connect();
  f.manager.retireOccurrence(reference().stream, reference().runId, reference().permissionOccurrenceId);
  await expect(first.respond({ allow: true })).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
  await expect(second.respond({ allow: true })).resolves.toBeUndefined();
  expect(f.responses()).toHaveLength(1);
  expect(f.responses()[0]?.command).toMatchObject({ command: { permission: reference(2) } });
});

test('captured references and decisions remain fixed across caller mutation', async () => {
  const f = fixture(); const value = reference(); const capability = f.manager.capture(value, f.source.signal, () => true);
  Reflect.set(value, 'handle', 'synthetic-foreign'); Reflect.set(value.stream, 'streamId', 'synthetic-foreign');
  await f.connect();
  const reply = Promise.withResolvers<NodeWorkerServiceResult>(); f.handler.mockImplementationOnce(() => reply.promise);
  const decision = { allow: true, response: { answer: 'synthetic-original' } };
  const response = capability.respond(decision);
  decision.allow = false; decision.response.answer = 'synthetic-mutated';
  expect(f.responses()[0]?.command).toMatchObject({ command: { permission: reference(), decision: { allow: true, response: { answer: 'synthetic-original' } } } });
  reply.resolve(receipt(reference(), 'resolved')); await response;
});

test('reentrant connection validation cannot replace a newer attachment with the old channel', async () => {
  const f = fixture(); f.capture(); const old = f.connection(); const replacement = f.connection();
  expect(() => f.manager.attach({ ...old, validate() { f.manager.attach(replacement); } })).toThrow('unavailable');
  await f.manager.reconcile(replacement.connectionId, replacement.signal);
  expect(f.calls[0]?.connectionId).toBe(replacement.connectionId);
});
import { materializeNodeFrameText } from '../../execution-node/worker/frame-text.js';
