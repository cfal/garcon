import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { parseNodeOutputText, type AgentProducerEvent } from '@garcon/server-agent-interface';
import { AssistantMessage, BashToolUseMessage } from '../../../common/chat-types.js';
import type { NodeOperationIdentity } from '../../../common/node-operation.js';
import { serializeNodeExecutionBody, type NodeExecutionBody } from '../../execution-nodes/transport/execution-body-wire.js';
import type { NodePermissionReference } from '../../execution-nodes/transport/permission-wire.js';
import type { NodeExecutionCommand } from '../../execution-nodes/transport/execution-wire.js';
import { NodeExecutionHost } from '../execution-host.js';
import { NodeOutputStream } from '../output-stream.js';
import { NodeReplayCache } from '../replay-cache.js';
import { executionWireFixture } from './execution-wire-fixture.js';

async function fixture() {
  const f = executionWireFixture();
  const host = new NodeExecutionHost(f.connection, f.supervisor, f.table);
  const cache = new NodeReplayCache();
  const outputFailure = mock((_error: unknown) => {});
  const output = new NodeOutputStream({ identity: f.stream, cache, permissionHandles: host.permissions,
    onOutputFailure: outputFailure, onTransportFailure: outputFailure });
  host.installStream(f.stream, f.connection.authoritySignal, () => output);
  const call = (command: NodeExecutionCommand) => host.execute(f.connection, command, f.connection.signal);
  const body = (identity: NodeOperationIdentity, value: NodeExecutionBody, controlId: string | null = null) => {
    const bytes = serializeNodeExecutionBody(value);
    const transfer = host.bodies.reserve(identity, value.kind, controlId,
      { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, f.connection.signal);
    host.transfers.append(transfer, 0, bytes);
    host.transfers.complete(transfer);
    return transfer;
  };
  const prepare = async (runId = f.request.runId) => {
    const result = await call({ method: 'prepare', location: f.location, request: { ...f.request, runId } });
    if (result.kind !== 'prepared') throw new Error('Synthetic host preparation failed');
    host.bindOutput(f.connection, result.ticket.identity, f.stream);
    return result.ticket;
  };
  const start = async (runId = f.request.runId) => {
    const ticket = await prepare(runId);
    expect(await call({ method: 'dispatch', identity: ticket.identity, stream: f.stream,
      body: body(ticket.identity, { kind: 'execution', input: { prompt: 'synthetic input', attachments: [], carriedContext: null } }) }))
      .toEqual({ kind: 'dispatched' });
    return { ticket, sink: f.execution.start.mock.calls.at(-1)![0].output };
  };
  const lastFrame = () => {
    const retained = cache.read(f.stream, output.producedSequence, output.producedSequence);
    if (!('kind' in retained) || retained.kind !== 'record') throw new Error('Missing synthetic output');
    const frame = parseNodeOutputText(retained.serialized);
    if (!frame) throw new Error('Invalid synthetic output');
    return frame;
  };
  const answerLast = () => {
    const frame = lastFrame();
    if (frame.event.type !== 'permission' || frame.event.decisionHandle === undefined) throw new Error('Missing synthetic permission');
    const permission: NodePermissionReference = { stream: frame.stream, runId: frame.event.runId,
      handle: frame.event.decisionHandle, permissionOccurrenceId: frame.event.lifecycle.permissionOccurrenceId };
    return host.permissions.execute(f.connection, { method: 'permission-respond', permission, decision: { allow: true } }, f.connection.signal);
  };
  return { ...f, host, output, cache, outputFailure, call, body, prepare, start, lastFrame, answerLast,
    async dispose() { host.close(); output.retire(); cache.clear(); await f.dispose(); } };
}

function permission(runId: string, suffix: number, respond = mock(async () => {})): Extract<AgentProducerEvent, { type: 'permission' }> {
  const permissionOccurrenceId = `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  return { type: 'permission', runId, decision: { permissionOccurrenceId, respond }, lifecycle: { kind: 'requested', permissionOccurrenceId,
    requestedTool: new BashToolUseMessage('2026-09-09T00:00:00.000Z', 'synthetic-tool', 'pwd'), options: [{ id: 'allow', label: 'Allow' }] } };
}

test('a retired operation cannot give its native permission callback a successor run identity', async () => {
  const f = await fixture();
  try {
    const old = await f.start();
    old.sink.emit({ type: 'run-ended', runId: old.ticket.runId, outcome: 'finished' });
    const next = await f.start('synthetic-successor');
    const respond = mock(async () => {});
    const sequence = f.output.producedSequence;
    old.sink.emit(permission(next.ticket.runId, 1, respond));
    expect(f.output.producedSequence).toBe(sequence);
    expect(respond).not.toHaveBeenCalled();
    expect(await f.call({ method: 'status', identity: next.ticket.identity })).toMatchObject({ kind: 'status', receipt: { phase: 'dispatched' } });
    next.sink.emit(permission(next.ticket.runId, 2, respond));
    expect(await f.answerLast()).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(f.outputFailure).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

test('a released publisher still records late rows, session facts and inert permission history', async () => {
  const f = await fixture();
  try {
    const old = await f.start();
    old.sink.emit({ type: 'run-ended', runId: old.ticket.runId, outcome: 'finished' });
    await f.start('synthetic-successor');
    const respond = mock(async () => {});
    old.sink.emit(permission(old.ticket.runId, 1, respond));
    expect(await f.answerLast()).toMatchObject({ kind: 'permission', receipt: { phase: 'expired' } });
    expect(respond).not.toHaveBeenCalled();
    old.sink.emit({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-09T00:00:00.000Z', 'synthetic late output') }] });
    expect(f.lastFrame().event.type).toBe('rows');
    old.sink.emit({ type: 'session', session: { agentSessionId: 'synthetic-late-session', nativeSession: null, nativeSeedReceipt: null } });
    expect(f.lastFrame().event.type).toBe('session');
    expect(f.outputFailure).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

test('a committed goal handoff keeps earlier permission facts inert without failing the new run', async () => {
  const f = await fixture();
  try {
    const old = await f.start();
    const result = await f.call({ method: 'prepare-goal', identity: old.ticket.identity, runId: 'synthetic-goal', configuration: f.request.configuration,
      body: f.body(old.ticket.identity, { kind: 'goal', prompt: 'synthetic goal', attachments: [] }) });
    if (result.kind !== 'control-prepared' || result.preparation.kind !== 'ready') throw new Error('Synthetic goal preparation failed');
    expect(await f.call({ method: 'commit-goal', identity: old.ticket.identity, controlId: result.preparation.ticket.controlId }))
      .toEqual({ kind: 'goal-result', outcome: { kind: 'accepted' } });
    const respond = mock(async () => {});
    old.sink.emit(permission(old.ticket.runId, 1, respond));
    expect(await f.answerLast()).toMatchObject({ kind: 'permission', receipt: { phase: 'expired' } });
    expect(respond).not.toHaveBeenCalled();
    expect(await f.call({ method: 'status', identity: old.ticket.identity })).toMatchObject({ kind: 'status', receipt: { runId: 'synthetic-goal', phase: 'dispatched' } });
    old.sink.emit(permission('synthetic-goal', 2, respond));
    expect(await f.answerLast()).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(respond).toHaveBeenCalledTimes(1);
  } finally { await f.dispose(); }
});

test('body grants follow the prepared operation and exact prepared control through retirement', async () => {
  const f = await fixture();
  try {
    const { ticket } = await f.start();
    expect(() => f.body(ticket.identity, { kind: 'execution', input: { prompt: 'synthetic repeat', attachments: [], carriedContext: null } })).toThrow();
    expect(() => f.body(ticket.identity, { kind: 'steer', input: 'synthetic steer', clientMessageId: 'synthetic-message' }, 'synthetic-control')).toThrow();
    const result = await f.call({ method: 'prepare-steer', identity: ticket.identity });
    if (result.kind !== 'control-prepared' || result.preparation.kind !== 'ready') throw new Error('Synthetic steer preparation failed');
    const controlId = result.preparation.ticket.controlId;
    const body = f.body(ticket.identity, { kind: 'steer', input: 'synthetic steer', clientMessageId: 'synthetic-message' }, controlId);
    expect(await f.call({ method: 'commit-steer', identity: ticket.identity, controlId, body })).toMatchObject({ kind: 'steer-result', outcome: { kind: 'accepted' } });
    expect(() => f.body(ticket.identity, { kind: 'steer', input: 'synthetic repeat', clientMessageId: 'synthetic-next' }, controlId)).toThrow();
    const upload = f.body(ticket.identity, { kind: 'goal', prompt: 'synthetic future goal', attachments: [] });
    expect(f.host.transfers.status(upload)).not.toBeNull();
    f.host.retireStream(f.stream);
    expect(f.host.transfers.status(upload)).toBeNull();
    expect(() => f.body(ticket.identity, { kind: 'goal', prompt: 'synthetic retired goal', attachments: [] })).toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.execution.abort).toHaveBeenCalledTimes(1);
  } finally { await f.dispose(); }
});

test('late run controls cannot retire a successor that reused the same run label', async () => {
  const f = await fixture();
  try {
    const old = await f.start();
    old.sink.emit({ type: 'run-ended', runId: old.ticket.runId, outcome: 'finished' });
    const next = await f.start(old.ticket.runId);
    const respond = mock(async () => {});
    next.sink.emit(permission(next.ticket.runId, 1, respond));
    const sequence = f.output.producedSequence;
    old.sink.emit({ type: 'run-ended', runId: old.ticket.runId, outcome: 'finished' });
    old.sink.emit({ type: 'notice', runId: old.ticket.runId, content: 'synthetic late advisory' });
    expect(f.output.producedSequence).toBe(sequence);
    expect(await f.answerLast()).toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(respond).toHaveBeenCalledTimes(1);
    next.sink.emit(permission(next.ticket.runId, 2, respond));
    const frame = f.lastFrame();
    if (frame.event.type !== 'permission' || frame.event.decisionHandle === undefined) throw new Error('Missing permission');
    old.sink.emit({ type: 'permission', runId: old.ticket.runId,
      lifecycle: { kind: 'expired', permissionOccurrenceId: frame.event.lifecycle.permissionOccurrenceId } });
    expect(await f.host.permissions.execute(f.connection, { method: 'permission-respond', decision: { allow: true },
      permission: { stream: frame.stream, handle: frame.event.decisionHandle, runId: frame.event.runId,
        permissionOccurrenceId: frame.event.lifecycle.permissionOccurrenceId } }, f.connection.signal))
      .toMatchObject({ kind: 'permission', receipt: { phase: 'resolved' } });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(await f.call({ method: 'status', identity: next.ticket.identity })).toMatchObject({ receipt: { phase: 'dispatched' } });
  } finally { await f.dispose(); }
});

test.each(['retire', 'abort', 'close'] as const)('stream %s during output construction prevents installation', async (action) => {
  const f = executionWireFixture();
  const host = new NodeExecutionHost(f.connection, f.supervisor, f.table);
  const closing = new AbortController();
  const emit = mock((_event: AgentProducerEvent) => {});
  try {
    expect(() => host.installStream(f.stream, closing.signal, () => {
      if (action === 'retire') host.retireStream(f.stream);
      else if (action === 'abort') closing.abort();
      else host.close();
      return { forOperation: () => ({ emit }) };
    })).toThrow();
    expect(() => host.installStream(f.stream, new AbortController().signal, () => ({ forOperation: () => ({ emit }) }))).toThrow();
    expect(emit).not.toHaveBeenCalled();
  } finally { host.close(); await f.dispose(); }
});

test.each(['permission', 'terminal', 'throw'] as const)('goal commit observes synchronous successor %s under its captured operation', async (event) => {
  const f = await fixture();
  try {
    const { ticket } = await f.start();
    const runId = 'synthetic-goal';
    const respond = mock(async () => {});
    f.goals.submitControl.mockImplementationOnce(async (request) => {
      await request.beforeDelivery({ validate() {}, commit() {
        request.output.emit(permission(runId, 1, respond));
        if (event === 'terminal') request.output.emit({ type: 'run-ended', runId, outcome: 'finished' });
        if (event === 'throw') throw new Error('synthetic uncertain handoff');
      } });
      return true;
    });
    const prepared = await f.call({ method: 'prepare-goal', identity: ticket.identity, runId, configuration: f.request.configuration,
      body: f.body(ticket.identity, { kind: 'goal', prompt: 'synthetic goal', attachments: [] }) });
    if (prepared.kind !== 'control-prepared' || prepared.preparation.kind !== 'ready') throw new Error('Goal preparation failed');
    const result = await f.call({ method: 'commit-goal', identity: ticket.identity, controlId: prepared.preparation.ticket.controlId });
    expect(result).toEqual({ kind: 'goal-result', outcome: event === 'permission' ? { kind: 'accepted' } : { kind: 'failed', outcome: 'unknown' } });
    if (event === 'terminal') {
      expect(f.lastFrame().event).toEqual({ type: 'run-ended', runId, outcome: 'finished' });
      expect(await f.call({ method: 'status', identity: ticket.identity })).toMatchObject({ receipt: { runId, phase: 'ended' } });
    } else {
      expect(await f.answerLast()).toMatchObject({ kind: 'permission', receipt: { phase: event === 'permission' ? 'resolved' : 'expired' } });
      expect(respond).toHaveBeenCalledTimes(event === 'permission' ? 1 : 0);
    }
    expect(f.execution.abort).toHaveBeenCalledTimes(event === 'throw' ? 1 : 0);
    expect(f.outputFailure).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});
