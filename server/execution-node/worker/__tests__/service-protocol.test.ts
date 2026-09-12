import { expect, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import {
  MAX_NODE_WORKER_REPLAY_CURSORS, MAX_NODE_WORKER_SERVICE_BYTES,
  parseNodeWorkerOutputAcknowledgementText, parseNodeWorkerServiceText,
  serializeNodeWorkerOutputAcknowledgement, serializeNodeWorkerService,
  parseNodeWorkerOutputSuspensionText, serializeNodeWorkerOutputSuspension,
  type NodeWorkerServiceCommand, type NodeWorkerServiceFrame, type NodeWorkerServiceResult,
} from '../service-protocol.js';
import { session } from './lifecycle-fixture.js';

const stream = { ...session, streamId: 'synthetic-stream' };
const identity = { ...session, operationId: 'synthetic-operation' };
const transfer = { ...session, transferId: 'synthetic-transfer' };
const instanceId = 'synthetic-instance';
const descriptor = { byteLength: 3, sha256: 'a'.repeat(64) };
const permission = { stream, handle: 'synthetic-handle', runId: 'synthetic-run', permissionOccurrenceId: '00000000-0000-4000-8000-000000000001' };
const envelope = { version: NODE_WIRE_VERSION, session, connectionId: 1, requestId: 1 } as const;
const settingsConfiguration = { model: 'synthetic-model', permissionMode: 'default' as const, thinkingMode: 'none' as const,
  endpoint: null, settings: { ownerId: 'synthetic', schemaVersion: 1, values: {} } };
const commands: readonly NodeWorkerServiceCommand[] = [
  { method: 'install-output', instanceId, stream },
  { method: 'reserve-body', instanceId, identity, kind: 'execution', controlId: null, descriptor },
  { method: 'reserve-body', instanceId, identity, kind: 'steer', controlId: 'synthetic-control', descriptor },
  { method: 'reserve-body', instanceId, identity, kind: 'goal', controlId: null, descriptor },
  { method: 'permission', command: { method: 'permission-status', permission } },
  { method: 'permission', command: { method: 'permission-respond', permission, decision: { allow: true, alwaysAllow: false } } },
  { method: 'begin-output-recovery' }, { method: 'replay-output', generation: 2, cursors: [{ stream, afterSequence: 1 }] },
  { method: 'resume-output', generation: 2 },
  { method: 'provider-catalog', instanceId, strict: true },
  { method: 'provider-auth', instanceId, operation: 'status' },
  { method: 'provider-auth', instanceId, operation: 'login-status', sessionId: null },
  { method: 'provider-auth', instanceId, operation: 'launch-login' },
  { method: 'provider-auth', instanceId, operation: 'complete-login', sessionId: 'synthetic-login', code: 'synthetic-code' },
  { method: 'provider-commands', instanceId, workspaceId: 'synthetic-workspace' },
  { method: 'provider-configuration', instanceId, operation: 'prepare-update', request: {
    previous: { model: 'synthetic-model', settings: null, endpoint: null }, next: { model: 'synthetic-next', endpoint: null }, patch: {} } },
];
const results: readonly NodeWorkerServiceResult[] = [
  { kind: 'provider-configuration-too-large', instanceId },
  { kind: 'provider-configuration-prepared', instanceId, configuration: { previous: settingsConfiguration, next: settingsConfiguration } },
  { kind: 'provider-configuration-rejected', instanceId, code: 'VALIDATION_FAILED' },
  { kind: 'provider-configuration-rejected', instanceId, code: 'INVALID_ENDPOINT' },
  { kind: 'provider-configuration-rejected', instanceId, code: 'INVALID_SETTINGS' },
  { kind: 'output-installed', instanceId, stream }, { kind: 'body-reserved', transfer },
  { kind: 'permission-result', result: { kind: 'permission', receipt: { permission, phase: 'available' } } },
  { kind: 'permission-result', result: { kind: 'permission', receipt: null } },
  { kind: 'permission-result', result: { kind: 'unknown' } },
  { kind: 'output-recovery', generation: 2 }, { kind: 'output-live', live: false }, { kind: 'unknown' },
  { kind: 'output-replayed', ranges: [{ type: 'node-replay-ready', stream, afterSequence: 1, throughSequence: 2 }] },
  { kind: 'output-replayed', ranges: [{ type: 'node-replay-gap', stream, requestedAfter: 1, firstRetainedSequence: 3, lastProducedSequence: 2 }] },
  { kind: 'rejected', code: 'NODE_STREAM_IDENTITIES_EXHAUSTED' },
  { kind: 'rejected', code: 'NODE_OUTPUT_RETIRED' },
  { kind: 'provider-catalog', instanceId, snapshot: { models: [{ value: 'synthetic', label: 'Synthetic' }],
    defaultModel: 'synthetic', requiresStrictModelDiscovery: true, generation: { priority: 10, model: 'synthetic' } } },
  { kind: 'provider-catalog-unavailable', instanceId, staleModels: [] },
  { kind: 'provider-auth-status', instanceId, status: null },
  { kind: 'provider-login-status', instanceId, status: { state: 'idle', running: false } },
  { kind: 'provider-login-launched', instanceId, result: { launched: true, alreadyRunning: false, sessionId: 'synthetic-login' } },
  { kind: 'provider-login-completed', instanceId, result: { submitted: true, sessionId: 'synthetic-login' } },
  { kind: 'provider-auth-rejected', instanceId, code: 'OPERATION_UNSUPPORTED' },
  { kind: 'provider-commands', instanceId, workspaceId: 'synthetic-workspace', commands: [{ name: 'review', source: 'skill' }] },
  { kind: 'provider-commands-unavailable', instanceId, workspaceId: 'synthetic-workspace', reason: 'permission-denied' },
];

test('private service frames round-trip typed installation, body grants, permissions, catalogs and output recovery', () => {
  const frames: NodeWorkerServiceFrame[] = [
    ...commands.map((command) => ({ ...envelope, type: 'node-worker-service-request' as const, command })),
    ...results.map((result) => ({ ...envelope, type: 'node-worker-service-result' as const, result })),
    { ...envelope, type: 'node-worker-service-cancel' },
  ];
  for (const frame of frames) {
    expect(parseNodeWorkerServiceText(serializeNodeWorkerService(frame))).toEqual(frame);
    expect(parseNodeWorkerServiceText(JSON.stringify({ ...frame, extra: true }))).toBeNull();
  }
});

test('service payload authorities cannot name a different session from their enclosing connection', () => {
  const foreign = { ...envelope, session: { ...session, logicalSessionId: 'foreign' } };
  for (const command of commands.filter((command) => command.method === 'install-output' || command.method === 'reserve-body' || command.method === 'permission')) {
    expect(parseNodeWorkerServiceText(JSON.stringify({ ...foreign, type: 'node-worker-service-request', command }))).toBeNull();
  }
  for (const result of results.filter((result) => result.kind === 'output-installed' || result.kind === 'body-reserved'
    || result.kind === 'permission-result' && result.result.kind === 'permission' && result.result.receipt !== null)) {
    expect(parseNodeWorkerServiceText(JSON.stringify({ ...foreign, type: 'node-worker-service-result', result }))).toBeNull();
  }
});

test('service parsing rejects malformed ownership, cursors, bodies and nested permission fields', () => {
  const invalid = [
    { ...commands[0], instanceId: '' }, { ...commands[0], stream: { ...stream, nodeBootId: 'foreign' } },
    { ...commands[1], controlId: 'unexpected' }, { ...commands[2], controlId: null },
    { ...commands[1], descriptor: { ...descriptor, byteLength: 0 } },
    { ...commands[1], identity: { ...identity, controllerBootId: 'foreign' } },
    { method: 'permission', command: { version: NODE_WIRE_VERSION, method: 'permission-status', permission } },
    { method: 'permission', command: { method: 'permission-respond', permission, decision: { allow: 'yes' } } },
    { method: 'replay-output', generation: 0, cursors: [] },
    { method: 'replay-output', generation: 1, cursors: [{ stream, afterSequence: -1 }] },
    { method: 'replay-output', generation: 1, cursors: [{ stream, afterSequence: 0 }, { stream, afterSequence: 0 }] },
    { method: 'replay-output', generation: 1, cursors: Array.from({ length: MAX_NODE_WORKER_REPLAY_CURSORS + 1 }, (_, i) => ({ stream: { ...stream, streamId: `s-${i}` }, afterSequence: 0 })) },
    { method: 'begin-output-recovery', generation: 1 },
    { method: 'provider-catalog', instanceId, strict: 'yes' },
    { method: 'provider-catalog', instanceId, strict: true, extra: true },
    { method: 'provider-catalog', instanceId: '', strict: true },
    { method: 'provider-catalog', instanceId },
    { method: 'provider-commands', instanceId, workspaceId: 'synthetic-workspace', projectPath: '/synthetic/ungranted' },
    { method: 'provider-commands', instanceId },
    { method: 'provider-commands', instanceId, workspaceId: '' },
    { method: 'provider-auth', instanceId, operation: 'status', workspaceId: 'synthetic-workspace' },
  ];
  for (const command of invalid) expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-request', command }))).toBeNull();
  for (const field of ['connectionId', 'requestId']) for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-request', command: commands[0], [field]: value }))).toBeNull();
  }
  expect(parseNodeWorkerServiceText(' '.repeat(MAX_NODE_WORKER_SERVICE_BYTES + 1))).toBeNull();
  expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-cancel', command: commands[0] }))).toBeNull();
  expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-result', result: {
    kind: 'permission-result', result: { version: NODE_WIRE_VERSION, kind: 'unknown' },
  } }))).toBeNull();
});

test('output acknowledgements carry exact stream, physical connection and attempt generation', () => {
  const frame = { type: 'node-worker-output-ack', version: NODE_WIRE_VERSION, connectionId: 1, generation: 2,
    ack: { type: 'node-output-ack', stream, throughSequence: 3 } } as const;
  expect(parseNodeWorkerOutputAcknowledgementText(serializeNodeWorkerOutputAcknowledgement(frame))).toEqual(frame);
  for (const bad of [{ ...frame, extra: true }, { ...frame, generation: 0 }, { ...frame, connectionId: 0 },
    { ...frame, ack: { ...frame.ack, throughSequence: -1 } }, { ...frame, ack: { ...frame.ack, extra: true } }]) {
    expect(parseNodeWorkerOutputAcknowledgementText(JSON.stringify(bad))).toBeNull();
  }
});

test('output suspension carries a strictly parsed logical session and physical recovery attempt', () => {
  const frame = { type: 'node-worker-output-suspended', version: NODE_WIRE_VERSION, session, connectionId: 1, generation: 2 } as const;
  expect(parseNodeWorkerOutputSuspensionText(serializeNodeWorkerOutputSuspension(frame))).toEqual(frame);
  for (const bad of [{ ...frame, extra: true }, { ...frame, generation: 0 }, { ...frame, connectionId: 0 },
    { ...frame, generation: Number.MAX_SAFE_INTEGER + 1 }, { ...frame, version: 2 }, { ...frame, session: {} }]) {
    expect(parseNodeWorkerOutputSuspensionText(JSON.stringify(bad))).toBeNull();
  }
});
