import { afterEach, expect, test } from 'bun:test';
import { executionWireFixture } from './execution-wire-fixture.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
function fixture() {
  const fixture = executionWireFixture();
  disposals.push(fixture.dispose);
  return fixture;
}

test('wire preparation never dispatches, and verified input reaches only the owning native operation', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  expect(f.execution.start).not.toHaveBeenCalled();
  const input = { prompt: 'synthetic private input', attachments: [], carriedContext: null };
  expect(await f.call({ method: 'dispatch', identity: ticket.identity, stream: f.stream, body: f.body(ticket.identity, { kind: 'execution', input }) }))
    .toEqual({ kind: 'dispatched' });
  expect(f.execution.start.mock.calls[0]![0]).toMatchObject({ prompt: input.prompt, projectPath: '/synthetic/project' });
  expect(f.transfers.reservedBytes).toBe(0);
  expect(await f.call({ method: 'status', identity: ticket.identity })).toMatchObject({ kind: 'status', receipt: { phase: 'dispatched', dispatch: 'completed' } });
  expect(await f.call({ method: 'dispatch', identity: ticket.identity, stream: f.stream, body: f.body(ticket.identity, { kind: 'execution', input }) }))
    .toMatchObject({ kind: 'rejected', code: 'NODE_OPERATION_UNKNOWN' });
  expect(f.execution.start).toHaveBeenCalledTimes(1);
});

test('lost physical replies reconcile the original ticket after reconnect without a replacement launch', async () => {
  const f = fixture();
  const ticket = await f.start();
  f.supervisor.disconnect(f.connection);
  const replacement = f.supervisor.attach(f.session);
  expect(await f.call({ method: 'status', identity: ticket.identity }, replacement)).toMatchObject({ kind: 'status', receipt: { dispatch: 'completed' } });
  expect(await f.call({ method: 'prepare', location: f.location, request: f.request }, replacement)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  expect(await f.call({ method: 'abort', identity: ticket.identity }, replacement)).toEqual({ kind: 'abort-result', requested: true });
  expect(f.execution.start).toHaveBeenCalledTimes(1);
  expect(f.execution.abort).toHaveBeenCalledTimes(1);
});

test('steering preserves the captured target and body-free delivery certainty', async () => {
  const f = fixture();
  const ticket = await f.start();
  const prepared = await f.call({ method: 'prepare-steer', identity: ticket.identity });
  if (prepared.kind !== 'control-prepared' || prepared.preparation.kind !== 'ready') throw new Error('Synthetic steering unavailable');
  const controlId = prepared.preparation.ticket.controlId;
  const content = { kind: 'steer' as const, input: 'synthetic guidance', clientMessageId: 'synthetic:message' };
  expect(await f.call({ method: 'commit-steer', identity: ticket.identity, controlId, body: f.body(ticket.identity, content, controlId) }))
    .toEqual({ kind: 'steer-result', outcome: { kind: 'accepted' }, deliveryPrepared: true });
  expect(f.steering.captureTarget).toHaveBeenCalledTimes(1);
  expect(f.steering.steer).toHaveBeenCalledTimes(1);
  const status = await f.call({ method: 'status', identity: ticket.identity });
  expect(JSON.stringify(status)).not.toContain(content.input);
  expect(JSON.stringify(status)).not.toContain(content.clientMessageId);
});

test('goal preparation parks one handoff and commit transfers the existing occurrence', async () => {
  const f = fixture();
  const ticket = await f.start();
  const prepared = await f.call({ method: 'prepare-goal', identity: ticket.identity, runId: 'synthetic-successor',
    configuration: f.request.configuration, body: f.body(ticket.identity, { kind: 'goal', prompt: '/goal pause', attachments: [] }) });
  if (prepared.kind !== 'control-prepared' || prepared.preparation.kind !== 'ready') throw new Error('Synthetic goal unavailable');
  expect(await f.call({ method: 'commit-goal', identity: ticket.identity, controlId: prepared.preparation.ticket.controlId }))
    .toEqual({ kind: 'goal-result', outcome: { kind: 'accepted' } });
  const output = f.execution.start.mock.calls[0]![0].output;
  output.emit({ type: 'run-ended', runId: 'synthetic-successor', outcome: 'finished' });
  expect(await f.call({ method: 'status', identity: ticket.identity })).toMatchObject({ kind: 'status', receipt: { phase: 'ended', runId: 'synthetic-successor' } });
  expect(f.execution.start).toHaveBeenCalledTimes(1);
  expect(f.goals.submitControl).toHaveBeenCalledTimes(1);
  expect((await f.prepare()).identity.operationId).not.toBe(ticket.identity.operationId);
});

test('cancelling a parked goal is definite non-delivery and leaves the predecessor authoritative', async () => {
  const f = fixture();
  const ticket = await f.start();
  const prepared = await f.call({ method: 'prepare-goal', identity: ticket.identity, runId: 'synthetic-successor',
    configuration: f.request.configuration, body: f.body(ticket.identity, { kind: 'goal', prompt: '/goal pause', attachments: [] }) });
  if (prepared.kind !== 'control-prepared' || prepared.preparation.kind !== 'ready') throw new Error('Synthetic goal unavailable');
  expect(await f.call({ method: 'cancel-control', identity: ticket.identity, controlId: prepared.preparation.ticket.controlId }))
    .toEqual({ kind: 'control-cancelled', cancelled: true });
  expect(await f.call({ method: 'status', identity: ticket.identity })).toMatchObject({ kind: 'status', receipt: { runId: 'synthetic-run',
    control: { outcome: { kind: 'failed', outcome: 'not-sent' } } } });
});

test('a delayed run-scoped Stop cannot abort a goal successor after its status was read', async () => {
  const f = fixture(); const ticket = await f.start();
  const status = await f.call({ method: 'status', identity: ticket.identity });
  if (status.kind !== 'status' || !status.receipt) throw new Error('Missing synthetic receipt');
  const prepared = await f.call({ method: 'prepare-goal', identity: ticket.identity, runId: 'synthetic-successor',
    configuration: f.request.configuration, body: f.body(ticket.identity, { kind: 'goal', prompt: '/goal pause', attachments: [] }) });
  if (prepared.kind !== 'control-prepared' || prepared.preparation.kind !== 'ready') throw new Error('Synthetic goal unavailable');
  expect(await f.call({ method: 'commit-goal', identity: ticket.identity, controlId: prepared.preparation.ticket.controlId }))
    .toEqual({ kind: 'goal-result', outcome: { kind: 'accepted' } });
  f.supervisor.beginRecovery(f.connection);
  expect(await f.call({ method: 'abort-run', identity: ticket.identity, runId: status.receipt.runId }))
    .toEqual({ kind: 'abort-result', requested: false });
  expect(f.execution.abort).not.toHaveBeenCalled();
  expect(await f.call({ method: 'status', identity: ticket.identity }))
    .toMatchObject({ kind: 'status', receipt: { runId: 'synthetic-successor', phase: 'dispatched', abort: null } });
  expect(await f.call({ method: 'abort-run', identity: ticket.identity, runId: 'synthetic-successor' }))
    .toEqual({ kind: 'abort-result', requested: true });
  expect(f.execution.abort).toHaveBeenCalledTimes(1);
});

test('provider failure text cannot expose private input in a reply or receipt', async () => {
  const f = fixture();
  f.execution.start.mockImplementationOnce(async () => { throw new Error('synthetic-private-credential'); });
  const ticket = await f.prepare();
  const result = await f.call({ method: 'dispatch', identity: ticket.identity, stream: f.stream,
    body: f.body(ticket.identity, { kind: 'execution', input: { prompt: 'synthetic-private-prompt', attachments: [], carriedContext: null } }) });
  expect(result).toEqual({ kind: 'rejected', code: 'NODE_EXECUTION_FAILED' });
  expect(JSON.stringify(await f.call({ method: 'status', identity: ticket.identity }))).not.toMatch(/private-(credential|prompt)/);
  expect((await f.prepare()).identity.operationId).not.toBe(ticket.identity.operationId);
});
