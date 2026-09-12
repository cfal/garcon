import { expect, mock, test } from 'bun:test';
import { BashToolUseMessage } from '../../../common/chat-types.js';
import type { PermissionDecisionPayload } from '../../../common/chat-command-contracts.js';
import { parseNodeOutputText } from '@garcon/server-agent-interface';
import { NodePermissionHandles, type NodePermissionHandlesOptions } from '../permission-handles.js';
import { NodeWorkerAuthority } from '../worker/authority.js';
import { NodeOutputStream } from '../output-stream.js';
import { NodeReplayCache } from '../replay-cache.js';
import type { NodePermissionReference } from '../../execution-nodes/transport/permission-wire.js';

const occurrence = '00000000-0000-4000-8000-000000000001';
const nextOccurrence = '00000000-0000-4000-8000-000000000002';

function fixture(limits: Pick<NodePermissionHandlesOptions, 'maxHandles' | 'maxPendingResponses' | 'maxReceipts' | 'receiptMs' | 'maxStreams'> = {}) {
  const parent = new AbortController();
  const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
  let now = 1;
  const authority = new NodeWorkerAuthority({ session, signal: parent.signal, poll: () => now });
  const connection = authority.attach(1);
  authority.openAdmissions(1);
  let activeRun: string | null = 'synthetic-run';
  const stream = { ...session, streamId: 'synthetic-stream' };
  const grant = new AbortController();
  const handles = new NodePermissionHandles({ session, signal: authority.signal, supervisor: authority, ...limits });
  handles.install(stream, grant.signal, (runId) => runId === activeRun);
  const respond = mock(async (_decision: PermissionDecisionPayload) => {});
  const reference: NodePermissionReference = { stream, handle: handles.createHandle(), runId: 'synthetic-run', permissionOccurrenceId: occurrence };
  const register = (permission = reference) => handles.register(permission.stream, permission.handle,
    { permissionOccurrenceId: permission.permissionOccurrenceId, respond }, permission.runId);
  const status = (permission = reference) => handles.execute(connection, { method: 'permission-status', permission }, parent.signal);
  const answer = (decision: PermissionDecisionPayload = { allow: true }, permission = reference, signal = parent.signal) =>
    handles.execute(connection, { method: 'permission-respond', permission, decision }, signal);
  return { handles, session, authority, parent, grant, stream, connection, respond, reference, register, status, answer,
    advance(ms: number) { now += ms; },
    setRun(runId: string | null) { activeRun = runId; }, close() { parent.abort(); } };
}

test('concurrent decisions claim the exact capability once and snapshot private response content', async () => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  try {
    f.respond.mockImplementationOnce(() => release.promise);
    f.register();
    const decision = { allow: true, response: { answer: 'synthetic private answer' } };
    const first = f.answer(decision);
    const second = f.answer(decision);
    decision.response.answer = 'mutated';
    expect(f.respond).toHaveBeenCalledTimes(1);
    expect(f.respond.mock.calls[0]![0]).toEqual({ allow: true, alwaysAllow: false, response: { answer: 'synthetic private answer' } });
    expect(await f.status()).toMatchObject({ kind: 'permission', receipt: { phase: 'pending' } });
    release.resolve();
    for (const result of await Promise.all([first, second])) expect(result).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(await f.answer({ allow: true, response: { answer: 'synthetic private answer' } })).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(await f.answer({ allow: false })).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(f.respond).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await f.status())).not.toContain('synthetic private answer');
  } finally { release.resolve(); f.close(); }
});

test.each(['stream', 'run', 'occurrence'] as const)('a valid handle cannot select a different %s', async (field) => {
  const f = fixture();
  try {
    f.register();
    const reference = { ...f.reference,
      ...(field === 'stream' ? { stream: { ...f.stream, streamId: 'synthetic-other' } }
        : field === 'run' ? { runId: 'synthetic-other' } : { permissionOccurrenceId: nextOccurrence }) };
    expect(await f.answer({ allow: true }, reference)).toEqual({ kind: 'permission', receipt: null });
    expect(f.respond).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('lost delivery reply reconciles through a new connection without invoking the occurrence again', async () => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  try {
    f.respond.mockImplementationOnce(() => release.promise);
    f.register();
    const first = f.answer();
    const replacement = f.authority.attach(2);
    expect(await first).toEqual({ kind: 'unknown' });
    expect(await f.status()).toEqual({ kind: 'rejected', code: 'NODE_SESSION_EXPIRED' });
    expect(await f.handles.execute(replacement, { method: 'permission-status', permission: f.reference }, f.parent.signal))
      .toMatchObject({ kind: 'permission', receipt: { phase: 'pending' } });
    expect(await f.handles.execute(replacement, { method: 'permission-respond', permission: f.reference, decision: { allow: true } }, f.parent.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await f.handles.execute(replacement, { method: 'permission-status', permission: f.reference }, f.parent.signal))
      .toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(f.respond).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); f.close(); }
});

test.each(['run', 'occurrence', 'stream'] as const)('retiring a %s makes old and late permissions inert', async (retirement) => {
  const f = fixture();
  try {
    f.register();
    if (retirement === 'stream') f.grant.abort();
    else if (retirement === 'occurrence') f.handles.retireOccurrence(f.stream, f.reference.runId, occurrence);
    else { f.setRun(null); f.handles.retireRun(f.stream, f.reference.runId); }
    expect(await f.answer()).toMatchObject({ kind: 'permission', receipt: { phase: 'expired' } });
    expect(f.respond).not.toHaveBeenCalled();
    if (retirement === 'run') {
      const late = { ...f.reference, handle: f.handles.createHandle(), permissionOccurrenceId: nextOccurrence };
      f.register(late);
      f.setRun(f.reference.runId);
      expect(await f.answer({ allow: true }, late)).toMatchObject({ kind: 'permission', receipt: { phase: 'expired' } });
    }
  } finally { f.close(); }
});

test('consumed handles never rebind and retained occurrences reject duplicate registration', async () => {
  const f = fixture();
  try {
    f.register();
    f.handles.retireRun(f.stream, f.reference.runId);
    expect(() => f.register({ ...f.reference, permissionOccurrenceId: nextOccurrence })).toThrow('cannot be rebound');
    expect(() => f.register({ ...f.reference, handle: f.handles.createHandle() })).toThrow('cannot be rebound');
    f.handles.retire(f.stream);
    expect(() => f.handles.install(f.stream, f.grant.signal, () => true)).toThrow('cannot be rebound');
    expect(f.respond).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('settled permission history does not consume live capacity and evicted receipts never replay a decision', async () => {
  const f = fixture({ maxHandles: 1, maxReceipts: 2, receiptMs: 100 });
  try {
    f.register();
    expect(await f.answer()).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    for (let index = 2; index <= 12; index += 1) {
      const permission = { ...f.reference, handle: f.handles.createHandle(),
        permissionOccurrenceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` };
      f.register(permission);
      expect(await f.answer({ allow: true }, permission)).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
      expect(await f.answer({ allow: false }, permission)).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
      expect(() => f.register(permission)).toThrow('cannot be rebound');
    }
    expect(await f.answer()).toEqual({ kind: 'permission', receipt: null });
    expect(() => f.register()).toThrow('cannot be rebound');
    expect(f.respond).toHaveBeenCalledTimes(12);
  } finally { f.close(); }
});

test('receipt expiry forgets reconciliation history while an old handle remains unusable', async () => {
  const f = fixture({ maxHandles: 1, receiptMs: 100 });
  try {
    f.register();
    await f.answer();
    f.advance(99);
    expect(await f.status()).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    f.advance(1);
    expect(await f.status()).toEqual({ kind: 'permission', receipt: null });
    const next = { ...f.reference, handle: f.handles.createHandle() };
    f.register(next);
    expect(await f.answer()).toEqual({ kind: 'permission', receipt: null });
    expect(f.respond).toHaveBeenCalledTimes(1);
    expect(await f.answer({ allow: false }, next)).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(f.respond).toHaveBeenCalledTimes(2);
  } finally { f.close(); }
});

test('live permissions outlast the receipt window but retired operation authority frees their slots', async () => {
  const f = fixture({ maxHandles: 1, receiptMs: 100 });
  let active = true;
  try {
    f.handles.register(f.stream, f.reference.handle, { permissionOccurrenceId: occurrence, respond: f.respond }, f.reference.runId, () => active);
    f.advance(1_000);
    expect(await f.status()).toMatchObject({ kind: 'permission', receipt: { phase: 'available' } });
    expect(() => f.handles.createHandle()).toThrow('capacity');
    active = false;
    const next = { ...f.reference, handle: f.handles.createHandle(), permissionOccurrenceId: nextOccurrence };
    f.register(next);
    expect(await f.answer()).toMatchObject({ kind: 'permission', receipt: { phase: 'expired' } });
    expect(await f.answer({ allow: true }, next)).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(f.respond).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('unregistered handle reservations expire without admitting fabricated or previously consumed handles', () => {
  const f = fixture({ maxHandles: 1, receiptMs: 100 });
  try {
    expect(() => f.register({ ...f.reference, handle: 'unissued-handle' })).toThrow('not minted');
    expect(() => f.handles.createHandle()).toThrow('capacity');
    f.advance(100);
    const next = { ...f.reference, handle: f.handles.createHandle() };
    expect(() => f.register()).toThrow('not minted');
    f.register(next);
    expect(() => f.register(next)).toThrow('cannot be rebound');
  } finally { f.close(); }
});

test('stream identity exhaustion requires a new session and retirement never rebinds a stream', () => {
  const f = fixture({ maxStreams: 1 });
  try {
    f.handles.retire(f.stream);
    expect(() => f.handles.install(f.stream, f.parent.signal, () => true)).toThrow('cannot be rebound');
    expect(() => f.handles.install({ ...f.stream, streamId: 'synthetic-next' }, f.parent.signal, () => true)).toThrow('fresh execution session');
  } finally { f.close(); }
});

test('registration capacity rejects atomically without evicting an existing capability', async () => {
  const f = fixture({ maxHandles: 1 });
  try {
    f.register();
    expect(() => f.register({ ...f.reference, handle: f.handles.createHandle(), permissionOccurrenceId: nextOccurrence })).toThrow('capacity');
    expect(await f.answer()).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(f.respond).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('a cancelled caller cannot release a noncooperative native response slot', async () => {
  const f = fixture({ maxPendingResponses: 1, receiptMs: 100 });
  const release = Promise.withResolvers<void>();
  try {
    f.respond.mockImplementationOnce(() => release.promise);
    f.register();
    const next = { ...f.reference, handle: f.handles.createHandle(), permissionOccurrenceId: nextOccurrence };
    f.register(next);
    const caller = new AbortController();
    const first = f.answer({ allow: true }, f.reference, caller.signal);
    caller.abort();
    expect(await first).toEqual({ kind: 'unknown' });
    f.advance(1_000);
    expect(await f.status()).toMatchObject({ receipt: { phase: 'pending' } });
    expect(await f.answer({ allow: true }, next)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(f.respond).toHaveBeenCalledTimes(1);
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await f.answer({ allow: true }, next)).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(f.respond).toHaveBeenCalledTimes(2);
  } finally { release.resolve(); f.close(); }
});

test('registration reserves its occurrence before invoking reentrant liveness callbacks', async () => {
  const f = fixture({ maxHandles: 2 });
  try {
    const nested = { ...f.reference, handle: f.handles.createHandle() };
    const isRunLive = mock(() => true).mockImplementationOnce(() => {
      expect(() => f.register(nested)).toThrow('cannot be rebound');
      return true;
    });
    f.handles.register(f.stream, f.reference.handle, { permissionOccurrenceId: occurrence, respond: f.respond }, f.reference.runId, isRunLive);
    expect(await f.status(nested)).toEqual({ kind: 'permission', receipt: null });
    expect(await f.answer()).toMatchObject({ receipt: { phase: 'resolved' } });
    expect(f.respond).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('registration retains its capacity reservation during a liveness callback', async () => {
  const f = fixture({ maxHandles: 1 });
  try {
    const isRunLive = mock(() => true).mockImplementationOnce(() => {
      expect(() => f.handles.createHandle()).toThrow('capacity');
      return true;
    });
    f.handles.register(f.stream, f.reference.handle, { permissionOccurrenceId: occurrence, respond: f.respond }, f.reference.runId, isRunLive);
    expect(await f.answer()).toMatchObject({ receipt: { phase: 'resolved' } });
  } finally { f.close(); }
});

test('failed registration relinquishes its occurrence and capacity without reissuing its handle', async () => {
  const f = fixture({ maxHandles: 1 });
  try {
    expect(() => f.handles.register(f.stream, f.reference.handle, { permissionOccurrenceId: occurrence, respond: f.respond }, f.reference.runId,
      () => { throw new Error('synthetic liveness failure'); })).toThrow('synthetic liveness failure');
    const next = { ...f.reference, handle: f.handles.createHandle() };
    f.register(next);
    expect(() => f.register()).toThrow('not minted');
    expect(await f.answer({ allow: true }, next)).toMatchObject({ receipt: { phase: 'resolved' } });
  } finally { f.close(); }
});

test('provider failures preserve uncertainty without leaking response bodies or allowing another effect', async () => {
  const f = fixture();
  try {
    f.respond.mockImplementationOnce(() => { throw new Error('synthetic private error'); });
    f.register();
    expect(await f.answer()).toMatchObject({ kind: 'permission', receipt: { phase: 'unknown' } });
    expect(await f.answer()).toMatchObject({ kind: 'permission', receipt: { phase: 'unknown' } });
    expect(f.respond).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await f.status())).not.toContain('synthetic private error');
  } finally { f.close(); }
});

test('closing the registry settles a blocked decision without waiting for the native callback', async () => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  try {
    f.respond.mockImplementationOnce(() => release.promise);
    f.register();
    const pending = f.answer();
    f.handles.close();
    expect(await pending).toEqual({ kind: 'unknown' });
    expect(() => f.register()).toThrow();
  } finally { release.resolve(); f.close(); }
});

test('normalized output registers the real occurrence before its serialized frame can be answered', async () => {
  const f = fixture();
  const cache = new NodeReplayCache();
  const output = new NodeOutputStream({ identity: f.stream, cache, permissionHandles: f.handles,
    onOutputFailure(error) { throw error; }, onTransportFailure(error) { throw error; } });
  try {
    output.emit({ type: 'permission', runId: f.reference.runId, decision: { permissionOccurrenceId: occurrence, respond: f.respond },
      lifecycle: { kind: 'requested', permissionOccurrenceId: occurrence,
        requestedTool: new BashToolUseMessage('2026-09-09T00:00:00.000Z', 'synthetic-tool', 'pwd'), options: [{ id: 'allow', label: 'Allow' }] } });
    const retained = cache.read(f.stream, 1, 1);
    if (!('kind' in retained) || retained.kind !== 'record') throw new Error('Missing synthetic permission output');
    const frame = parseNodeOutputText(retained.serialized);
    if (frame?.event.type !== 'permission' || frame.event.decisionHandle === undefined) throw new Error('Invalid synthetic permission frame');
    const permission = { stream: frame.stream, runId: frame.event.runId, handle: frame.event.decisionHandle, permissionOccurrenceId: occurrence };
    expect(await f.answer({ allow: true }, permission)).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(f.respond).toHaveBeenCalledTimes(1);
    output.retire();
    expect(() => f.register()).toThrow();
  } finally { output.retire(); cache.clear(); f.close(); }
});
