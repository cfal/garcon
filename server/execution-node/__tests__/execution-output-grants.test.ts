import { expect, mock, test } from 'bun:test';
import { AssistantMessage, BashToolUseMessage } from '../../../common/chat-types.js';
import { parseNodeOutputText, type AgentEmissionSink, type AgentProducerEvent } from '@garcon/server-agent-interface';
import { NodeExecutionOutputGrants } from '../execution-output-grants.js';
import { NodeOutputStream } from '../output-stream.js';
import { NodePermissionHandles } from '../permission-handles.js';
import { NodeReplayCache } from '../replay-cache.js';
import { executionWireFixture } from './execution-wire-fixture.js';

async function fixture(maxIdentities = 16) {
  const f = executionWireFixture(2);
  const parent = new AbortController();
  const grants = new NodeExecutionOutputGrants({ session: f.session, signal: parent.signal,
    maxStreams: maxIdentities, maxOperations: maxIdentities });
  const { stream } = f;
  const operation = (await f.prepare()).identity;
  const grant = new AbortController();
  const output = { emit: mock((_event: AgentProducerEvent) => {}) } satisfies AgentEmissionSink;
  const validate = mock(() => {});
  const ownership = f.table.capture(f.connection, operation);
  grants.install(stream, () => output, grant.signal, validate);
  return { parent, grants, stream, operation, grant, output, validate, ownership,
    async next() { return f.table.capture(f.connection, (await f.prepare()).identity); },
    async close() { parent.abort(); await f.dispose(); } };
}

const rows = (): AgentProducerEvent => ({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-09T00:00:00.000Z', 'synthetic output') }] });

test('output lookup requires both the installed stream and its exact operation', async () => {
  const f = await fixture();
  try {
    expect(() => f.grants.output(f.stream, f.operation)).toThrow();
    f.grants.bind(f.ownership, f.stream);
    expect(() => f.grants.output({ ...f.stream, streamId: 'synthetic-other' }, f.operation)).toThrow();
    expect(() => f.grants.output(f.stream, { ...f.operation, logicalSessionId: 'synthetic-foreign' })).toThrow();
    f.grants.output(f.stream, f.operation).emit(rows());
    expect(f.output.emit).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test('releasing an ended operation preserves late content on only its original open stream', async () => {
  const f = await fixture();
  try {
    f.grants.bind(f.ownership, f.stream);
    const captured = f.grants.output(f.stream, f.operation);
    f.grants.release(f.operation);
    expect(captured.signal.aborted).toBe(false);
    expect(() => f.grants.output(f.stream, f.operation)).toThrow();
    const successor = await f.next();
    f.grants.bind(successor, f.stream);
    captured.emit(rows());
    expect(f.grants.output(f.stream, successor.identity)).not.toBe(captured);
    expect(f.output.emit).toHaveBeenCalledTimes(1);
    f.grant.abort();
    expect(captured.signal.aborted).toBe(true);
    expect(() => captured.emit(rows())).toThrow();
    expect(f.output.emit).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test('released operation permission authority stays inert even when stream and run checks remain live', async () => {
  const f = executionWireFixture();
  const parent = new AbortController();
  const { session, connection, stream } = f;
  const handles = new NodePermissionHandles({ session, signal: parent.signal, supervisor: f.supervisor });
  const grants = new NodeExecutionOutputGrants({ session, signal: parent.signal });
  const operation = (await f.prepare()).identity;
  const ownership = f.table.capture(connection, operation);
  await f.table.dispatch(connection, operation, { prompt: 'synthetic', attachments: [], carriedContext: null }, { signal: connection.authoritySignal, emit() {} });
  const cache = new NodeReplayCache();
  const failure = mock((_error: unknown) => {});
  const output = new NodeOutputStream({ identity: stream, cache, permissionHandles: handles,
    onOutputFailure: failure, onTransportFailure: failure });
  try {
    handles.install(stream, parent.signal, () => true);
    grants.install(stream, (isRunLive) => output.forOperation(isRunLive), parent.signal, () => {});
    grants.bind(ownership, stream);
    const sink = grants.output(stream, operation);
    const respond = mock(async () => {});
    const references = [];
    for (let index = 1; index <= 2; index += 1) {
      if (index === 2) grants.release(operation);
      const permissionOccurrenceId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      sink.emit({ type: 'permission', runId: 'synthetic-run', decision: { permissionOccurrenceId, respond },
        lifecycle: { kind: 'requested', permissionOccurrenceId,
          requestedTool: new BashToolUseMessage('2026-09-09T00:00:00.000Z', 'synthetic-tool', 'pwd'), options: [{ id: 'allow', label: 'Allow' }] } });
      const retained = cache.read(stream, index, index);
      if (!('kind' in retained) || retained.kind !== 'record') throw new Error('Missing synthetic permission');
      const frame = parseNodeOutputText(retained.serialized);
      if (frame?.event.type !== 'permission' || frame.event.decisionHandle === undefined) throw new Error('Invalid synthetic permission');
      references.push({ stream, handle: frame.event.decisionHandle, runId: frame.event.runId, permissionOccurrenceId });
    }
    for (const permission of references) {
      expect(await handles.execute(connection, { method: 'permission-respond', permission, decision: { allow: true } }, parent.signal))
        .toMatchObject({ kind: 'permission', receipt: { phase: 'expired' } });
    }
    expect(respond).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  } finally { output.retire(); cache.clear(); parent.abort(); await f.dispose(); }
});

test('a fresh binding never redirects callbacks captured before retirement', async () => {
  const f = await fixture();
  try {
    f.grants.bind(f.ownership, f.stream);
    const old = f.grants.output(f.stream, f.operation);
    f.grants.retire(f.stream);
    const stream = { ...f.stream, streamId: 'synthetic-next' };
    const next = await f.next();
    const output = { emit: mock((_event: AgentProducerEvent) => {}) } satisfies AgentEmissionSink;
    f.grants.install(stream, () => output, f.parent.signal, () => {});
    f.grants.bind(next, stream);
    expect(() => old.emit(rows())).toThrow();
    expect(output.emit).not.toHaveBeenCalled();
    f.grants.output(stream, next.identity).emit(rows());
    expect(output.emit).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test('stream and operation identities remain retired rather than rebinding after release', async () => {
  const f = await fixture();
  try {
    f.grants.bind(f.ownership, f.stream);
    f.grants.release(f.operation);
    expect(() => f.grants.bind(f.ownership, f.stream)).toThrow('cannot be rebound');
    f.grants.retire(f.stream);
    expect(() => f.grants.install(f.stream, () => f.output, f.parent.signal, () => {})).toThrow('cannot be rebound');
  } finally { await f.close(); }
});

test('authority validation immediately before emission can revoke the stream without leaking output', async () => {
  const f = await fixture();
  try {
    f.grants.bind(f.ownership, f.stream);
    const output = f.grants.output(f.stream, f.operation);
    f.validate.mockImplementationOnce(() => f.grant.abort());
    expect(() => output.emit(rows())).toThrow();
    expect(f.output.emit).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('identity capacity rejects new grants without evicting existing publishers', async () => {
  const f = await fixture(1);
  try {
    f.grants.bind(f.ownership, f.stream);
    const next = await f.next();
    expect(() => f.grants.bind(next, f.stream)).toThrow('capacity');
    expect(() => f.grants.install({ ...f.stream, streamId: 'synthetic-next' }, () => f.output, f.parent.signal, () => {})).toThrow('fresh execution session');
    f.grants.output(f.stream, f.operation).emit(rows());
    expect(f.output.emit).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test('releasing output lookup frees capacity while the same live grant remains consumed', async () => {
  const f = await fixture(1);
  try {
    expect(() => f.grants.bind({ ...f.ownership }, f.stream)).toThrow('issued operation grant');
    f.grants.bind(f.ownership, f.stream);
    const old = f.grants.output(f.stream, f.operation);
    f.grants.release(f.operation);
    expect(() => f.grants.bind(f.ownership, f.stream)).toThrow('cannot be rebound');
    const next = await f.next();
    f.grants.bind(next, f.stream);
    old.emit(rows());
    f.grants.output(f.stream, next.identity).emit(rows());
    expect(f.output.emit).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});

test('a publisher factory cannot install an operation after retiring its own stream', async () => {
  const f = await fixture();
  try {
    const stream = { ...f.stream, streamId: 'synthetic-reentrant' };
    f.grants.install(stream, () => { f.grants.retire(stream); return f.output; }, f.parent.signal, () => {});
    expect(() => f.grants.bind(f.ownership, stream)).toThrow();
    expect(() => f.grants.output(stream, f.operation)).toThrow();
    expect(f.output.emit).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
