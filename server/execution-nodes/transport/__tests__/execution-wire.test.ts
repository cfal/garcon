import { expect, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { parseNodeExecutionCallText, serializeNodeExecutionCall, type NodeExecutionCall, type NodeExecutionCommand } from '../execution-wire.js';
import { parseNodeExecutionReplyText, serializeNodeExecutionReply, type NodeExecutionReply, type NodeExecutionResult } from '../execution-receipt-wire.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const identity = { ...session, operationId: 'synthetic-operation' };
const body = { ...session, transferId: 'synthetic-transfer' };
const stream = { ...session, streamId: 'synthetic-stream' };
const location = { nodeId: 'synthetic-node', instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' };
const configuration = { model: 'synthetic-model', settings: null, endpoint: null };
const request = { kind: 'start' as const, chatId: '1789000000000001', runId: 'synthetic-run', configuration };
const ticket = { identity, location, runId: request.runId, projectPath: '/synthetic/project' };
const control = { identity, controlId: 'synthetic-control', runId: request.runId, kind: 'goal' as const };
const envelope = (command: NodeExecutionCommand): NodeExecutionCall => ({ type: 'node-execution-request', timeoutMs: 10_000,
  version: NODE_WIRE_VERSION, session, requestId: 1, command });

test.each<NodeExecutionCommand>([
  { method: 'prepare', location, request },
  { method: 'prepare', location, request: { ...request, kind: 'resume', agentSessionId: 'synthetic-native', nativeSession: null } },
  { method: 'prepare', location, request: { ...request, kind: 'compact', agentSessionId: 'synthetic-native',
    nativeSession: { ownerId: 'synthetic', schemaVersion: 1, value: { id: 'synthetic-native' } } } },
  { method: 'dispatch', identity, body, stream },
  { method: 'release', identity }, { method: 'abort', identity }, { method: 'status', identity }, { method: 'prepare-steer', identity },
  { method: 'abort-run', identity, runId: request.runId },
  { method: 'commit-steer', identity, body, controlId: control.controlId },
  { method: 'prepare-goal', identity, body, runId: 'synthetic-successor', configuration },
  { method: 'commit-goal', identity, controlId: control.controlId },
  { method: 'cancel-control', identity, controlId: control.controlId },
])('execution command round-trips its explicit schema: %j', (command) => {
  const call = envelope(command);
  expect(parseNodeExecutionCallText(serializeNodeExecutionCall(call))).toEqual(call);
});

test('execution preparation cannot inject a path, capability, native handle or malformed chat identity', () => {
  const call = envelope({ method: 'prepare', location, request });
  for (const invalid of [
    { ...request, projectPath: '/synthetic/ungranted' }, { ...request, chatId: 'not-a-chat' },
    { ...request, nativeSession: null }, { ...request, runId: 'invalid/run' },
    { ...request, configuration: { ...configuration, output: {} } },
    { ...request, kind: 'resume', agentSessionId: 'synthetic-native', nativeSession: { ownerId: 'synthetic', schemaVersion: 0, value: {} } },
  ]) expect(parseNodeExecutionCallText(JSON.stringify({ ...call, command: { method: 'prepare', location, request: invalid } }))).toBeNull();
});

test('run-scoped abort requires exactly one valid captured run identity', () => {
  const call = envelope({ method: 'abort-run', identity, runId: request.runId });
  for (const runId of [null, undefined, '', 'invalid/run', 12]) {
    expect(parseNodeExecutionCallText(JSON.stringify({ ...call, command: { ...call.command, runId } }))).toBeNull();
  }
  expect(parseNodeExecutionCallText(JSON.stringify({ ...call, command: { ...call.command, currentRun: true } }))).toBeNull();
});

test('every nested transport identity must match the authenticated logical session envelope', () => {
  const call = envelope({ method: 'dispatch', identity, body, stream });
  for (const field of ['identity', 'body', 'stream'] as const) {
    for (const key of ['controllerBootId', 'nodeBootId', 'logicalSessionId'] as const) {
      const command = { method: 'dispatch', identity, body, stream, [field]: { ...({ identity, body, stream }[field]), [key]: 'synthetic-foreign' } };
      expect(parseNodeExecutionCallText(JSON.stringify({ ...call, command }))).toBeNull();
    }
  }
});

test('executable configuration values never run during request serialization', () => {
  let invoked = false;
  const call = envelope({ method: 'prepare', location, request });
  const unsafe = { ...call, toJSON() { invoked = true; return call; } };
  expect(() => serializeNodeExecutionCall(unsafe)).toThrow('Invalid node execution request');
  expect(invoked).toBe(false);
});

test.each<NodeExecutionResult>([
  { kind: 'prepared', ticket }, { kind: 'dispatched' }, { kind: 'released' }, { kind: 'unknown' },
  { kind: 'abort-result', requested: true }, { kind: 'status', receipt: null },
  { kind: 'status', receipt: { identity, runId: request.runId, phase: 'dispatched', dispatch: 'pending', native: 'possible', containment: null, abort: 'pending', control: null } },
  { kind: 'control-prepared', preparation: { kind: 'ready', ticket: control } },
  { kind: 'control-prepared', preparation: { kind: 'unsupported' } }, { kind: 'control-prepared', preparation: { kind: 'unavailable' } },
  { kind: 'steer-result', outcome: { kind: 'failed', outcome: 'not-sent' }, deliveryPrepared: false },
  { kind: 'goal-result', outcome: { kind: 'failed', outcome: 'unknown' } },
  { kind: 'control-cancelled', cancelled: true }, { kind: 'rejected', code: 'NODE_CAPACITY' },
])('execution reply round-trips its body-free outcome: %j', (result) => {
  const reply = { type: 'node-execution-result', version: NODE_WIRE_VERSION, session, requestId: 1, result } satisfies NodeExecutionReply;
  expect(parseNodeExecutionReplyText(serializeNodeExecutionReply(reply))).toEqual(reply);
});

test('receipts reject private bodies, stale identities and inconsistent settled controls', () => {
  const receipt = { identity, runId: request.runId, phase: 'ended', dispatch: 'accepted', native: 'possible', containment: null, abort: null, control: null };
  const reply = { type: 'node-execution-result', version: NODE_WIRE_VERSION, session, requestId: 1 };
  for (const invalid of [
    { ...receipt, credential: 'synthetic-private' }, { ...receipt, prompt: 'synthetic-private' },
    { ...receipt, identity: { ...identity, logicalSessionId: 'synthetic-foreign' } },
    { ...receipt, control: { controlId: control.controlId, kind: 'goal', runId: request.runId,
      phase: 'settled', deliveryPrepared: true, outcome: null } },
    { ...receipt, control: { controlId: control.controlId, kind: 'goal', runId: request.runId,
      phase: 'settled', deliveryPrepared: true, outcome: { kind: 'accepted', target: {} } } },
  ]) expect(parseNodeExecutionReplyText(JSON.stringify({ ...reply, result: { kind: 'status', receipt: invalid } }))).toBeNull();
});

test('unsupported versions, fractional IDs and unknown error vocabularies cannot become valid results', () => {
  const reply = { type: 'node-execution-result', version: NODE_WIRE_VERSION, session, requestId: 1, result: { kind: 'released' } };
  for (const override of [{ version: 99 }, { requestId: 0 }, { requestId: 1.5 }, { extra: true },
    { result: { kind: 'rejected', code: 'arbitrary-provider-error' } }, { result: { kind: 'unknown', prompt: 'synthetic-private' } }]) {
    expect(parseNodeExecutionReplyText(JSON.stringify({ ...reply, ...override }))).toBeNull();
  }
});


test.each([
  { phase: 'prepared', dispatch: null, native: 'none', containment: null },
  { phase: 'failed', dispatch: 'rejected', native: 'none', containment: null },
  { phase: 'failed', dispatch: 'unknown', native: 'possible', containment: null },
  { phase: 'failed', dispatch: 'unknown', native: 'possible', containment: 'requested' },
  { phase: 'ended', dispatch: 'accepted', native: 'settled', containment: null },
] as const)('dispatch certainty and native occupancy round-trip independently: %j', (lifetime) => {
  const receipt = { identity, runId: request.runId, ...lifetime, abort: null, control: null };
  const reply: NodeExecutionReply = { type: 'node-execution-result', version: NODE_WIRE_VERSION, session, requestId: 1,
    result: { kind: 'status', receipt } };
  expect(parseNodeExecutionReplyText(serializeNodeExecutionReply(reply))).toEqual(reply);
  for (const field of ['native', 'containment', 'dispatch'] as const) {
    const missing = { ...receipt };
    Reflect.deleteProperty(missing, field);
    expect(parseNodeExecutionReplyText(JSON.stringify({ ...reply, result: { kind: 'status', receipt: missing } }))).toBeNull();
    expect(parseNodeExecutionReplyText(JSON.stringify({ ...reply, result: { kind: 'status', receipt: { ...receipt, [field]: 'unsupported' } } }))).toBeNull();
  }
});


test('execution request budgets are mandatory bounded integer durations', () => {
  const call = envelope({ method: 'status', identity });
  for (const timeoutMs of [undefined, null, 0, -1, 0.5, '1000', 300_001, Infinity]) {
    expect(parseNodeExecutionCallText(JSON.stringify({ ...call, timeoutMs }))).toBeNull();
  }
  expect(parseNodeExecutionCallText(JSON.stringify({ ...call, timeoutMs: 300_000 }))?.timeoutMs).toBe(300_000);
});
