import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { serializeNodeExecutionBody } from '../../execution-nodes/transport/execution-body-wire.js';
import { NodeExecutionHost } from '../execution-host.js';
import { executionWireFixture } from './execution-wire-fixture.js';

function fixture() {
  const f = executionWireFixture(2);
  const host = new NodeExecutionHost(f.connection, f.supervisor, f.table);
  host.installStream(f.stream, f.connection.authoritySignal, () => ({ forOperation: () => ({ emit() {} }) }));
  const target = { chatId: f.request.chatId, location: { ...f.location }, projectPath: '/synthetic/project' };
  const prepare = async (location = f.location, chatId = f.request.chatId) => {
    const result = await host.execute(f.connection, { method: 'prepare', location, request: { ...f.request, chatId } }, f.connection.signal);
    if (result.kind !== 'prepared') throw new Error('Synthetic preparation failed');
    return result.ticket.identity;
  };
  const start = async () => {
    const identity = await prepare();
    host.bindOutput(f.connection, identity, f.stream);
    const bytes = serializeNodeExecutionBody({ kind: 'execution', input: { prompt: 'synthetic input', attachments: [], carriedContext: null } });
    const body = host.bodies.reserve(identity, 'execution', null,
      { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, f.connection.signal);
    host.transfers.append(body, 0, bytes); host.transfers.complete(body);
    expect(await host.execute(f.connection, { method: 'dispatch', identity, stream: f.stream, body }, f.connection.signal)).toEqual({ kind: 'dispatched' });
    return { identity, sink: f.execution.start.mock.calls.at(-1)![0].output };
  };
  return { ...f, host, target, prepare, start, async dispose() { host.close(); await f.dispose(); } };
}

test('source capture keeps exact workspace identity through operation retirement and physical reconnect', async () => {
  const f = fixture();
  try {
    expect(f.host.captureSource(f.target, null)).toMatchObject({ kind: 'absent' });
    const started = await f.start();
    const captured = f.host.captureSource(f.target, f.stream);
    if (captured.kind !== 'captured') throw new Error('Synthetic source was not captured');
    started.sink.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
    await f.settleNative();
    const connection = f.supervisor.attach(f.session);
    f.supervisor.completeRecovery(connection, f.supervisor.beginRecovery(connection));
    expect(f.connection.signal.aborted).toBe(true);
    expect(captured.signal.aborted).toBe(false);
    expect(() => captured.validate()).not.toThrow();
    expect(f.host.captureSource(f.target, f.stream).kind).toBe('captured');
    expect(f.host.captureSource({ ...f.target, location: { ...f.location, workspaceId: 'synthetic-alias' } }, f.stream)).toEqual({ kind: 'conflict' });
    expect(f.host.captureSource({ ...f.target, projectPath: '/synthetic/foreign' }, f.stream)).toEqual({ kind: 'conflict' });
    expect(f.host.captureSource({ ...f.target, chatId: '1789000000000002' }, null)).toMatchObject({ kind: 'absent' });
    f.resources.revoke(f.location);
    expect(captured.signal.aborted).toBe(true);
    expect(() => captured.validate()).toThrow();
  } finally { await f.dispose(); }
});

test('an absent source cannot stay valid after native work binds its first publisher', async () => {
  const f = fixture();
  try {
    const absent = f.host.captureSource(f.target, null);
    if (absent.kind !== 'absent') throw new Error('Unexpected synthetic source');
    expect(() => absent.validate()).not.toThrow();
    await f.start();
    expect(() => absent.validate()).toThrow();
    expect(f.host.captureSource(f.target, null)).toEqual({ kind: 'conflict' });
  } finally { await f.dispose(); }
});

test.each(['workspace', 'chat'] as const)('one publisher cannot rebind its %s after the original operation ends', async (field) => {
  const f = fixture();
  try {
    const started = await f.start();
    started.sink.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
    await f.settleNative();
    const alias = { ...f.location, workspaceId: 'synthetic-alias' };
    f.resources.register({ location: alias, projectPath: f.target.projectPath, execution: f.service.retained,
      files: { inspectProject: async () => ({ kind: 'available', effectiveProjectKey: f.target.projectPath }) } });
    const identity = field === 'workspace' ? await f.prepare(alias) : await f.prepare(f.location, '1789000000000002');
    expect(() => f.host.bindOutput(f.connection, identity, f.stream)).toThrow();
    expect(f.host.captureSource(f.target, f.stream).kind).toBe('captured');
    expect(f.execution.start).toHaveBeenCalledTimes(1);
  } finally { await f.dispose(); }
});

test('a new publisher cannot supersede a live source and retirement cannot revive an old capture', async () => {
  const f = fixture();
  try {
    const started = await f.start();
    const captured = f.host.captureSource(f.target, f.stream);
    if (captured.kind !== 'captured') throw new Error('Synthetic source was not captured');
    started.sink.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
    await f.settleNative();
    const next = { ...f.stream, streamId: 'synthetic-successor' };
    f.host.installStream(next, f.connection.authoritySignal, () => ({ forOperation: () => ({ emit() {} }) }));
    const identity = await f.prepare();
    expect(() => f.host.bindOutput(f.connection, identity, next)).toThrow();
    f.host.retireStream(f.stream);
    expect(captured.signal.aborted).toBe(true);
    expect(f.host.captureSource(f.target, null)).toMatchObject({ kind: 'absent' });
    f.host.bindOutput(f.connection, identity, next);
    expect(f.host.captureSource(f.target, next).kind).toBe('captured');
    expect(f.host.captureSource(f.target, f.stream)).toEqual({ kind: 'conflict' });
    expect(f.host.captureSource(f.target, null)).toEqual({ kind: 'conflict' });
    expect(() => captured.validate()).toThrow();
  } finally { await f.dispose(); }
});
