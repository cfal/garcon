import { expect, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { parseNodeWorkerServiceText } from '../../execution-node/worker/service-protocol.js';
import { MAX_NODE_SESSION_CONFIGURATION_BYTES, parseNodeSessionConfigurationCommand, parseNodeSessionConfigurationReply } from '../transport/provider-session-configuration-wire.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-boot', logicalSessionId: 'synthetic-session' };
const identity = { ...session, operationId: 'synthetic-configuration' };
const instanceId = 'synthetic-instance';
const snapshot = { model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'none',
  settings: { ownerId: 'synthetic', schemaVersion: 1, values: {} }, endpoint: null };
const request = { executionLocation: { nodeId: 'synthetic-node', instanceId, workspaceId: 'synthetic-workspace' },
  expected: { chatId: '1789000000000001', agentSessionId: 'synthetic-native', nativeSession: null, projectPath: '/synthetic/project' },
  permissionModeIntent: 'apply', previous: snapshot, next: { ...snapshot, permissionMode: 'manualBypass' } };
const envelope = { version: NODE_WIRE_VERSION, session, requestId: 1, connectionId: 1 };
const stream = { ...session, streamId: 'synthetic-source' };
const command = { method: 'provider-session-configuration', instanceId, operation: 'prepare', stream, request };

test('configuration commands and body-free receipts round-trip through the worker envelope', () => {
  for (const value of [command, { ...command, request: { ...request, permissionModeIntent: 'preserve' } },
    { ...command, stream: null }, ...['commit', 'status', 'cancel'].map(operation => ({ method: command.method, instanceId, operation, identity }))]) {
    expect(parseNodeSessionConfigurationCommand(value)).toEqual(value);
    expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-request', timeoutMs: 10_000, command: value })))
      .toMatchObject({ command: value });
  }
  const preparations = [{ kind: 'prepared', identity }, { kind: 'unsupported' }, { kind: 'not-required' }, { kind: 'rejected', reason: 'target-conflict' }];
  const results = [{ kind: 'applied' }, { kind: 'not-required' }, { kind: 'unknown' }, { kind: 'rejected', reason: 'target-changed' }];
  const receipts = [null, ...['prepared', 'committing', 'cancelling'].map(phase => ({ phase, result: null })), ...results.map(result => ({ phase: 'settled', result }))];
  for (const reply of [
    ...preparations.map(preparation => ({ kind: 'provider-session-configuration-prepared', instanceId, preparation })),
    ...receipts.map(receipt => ({ kind: 'provider-session-configuration-receipt', instanceId, identity, receipt })),
  ]) {
    expect(parseNodeSessionConfigurationReply(reply)).toEqual(reply);
    expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-result', result: reply }))).toMatchObject({ result: reply });
  }
});

test('rejects foreign authority, malformed identities, credentials and oversized settings without throwing', () => {
  for (const invalid of [
    { ...command, unexpected: true }, { ...command, instanceId: 'foreign' },
    { ...command, stream: undefined }, { ...command, stream: { ...stream, streamId: '' } },
    ...[undefined, null, true, 'inherit'].map(permissionModeIntent => ({ ...command, request: { ...request, permissionModeIntent } })),
    { ...command, request: { ...request, expected: { ...request.expected, chatId: 'invalid' } } },
    { ...command, request: { ...request, expected: { ...request.expected, nativeSession: { ownerId: 'synthetic', schemaVersion: 'invalid', value: {} } } } },
    { ...command, request: { ...request, next: { ...snapshot, endpoint: { credential: 'synthetic-secret' } } } },
    { ...command, request: { ...request, next: { ...snapshot, settings: { ...snapshot.settings, values: { huge: 'x'.repeat(MAX_NODE_SESSION_CONFIGURATION_BYTES) } } } } },
  ]) expect(parseNodeSessionConfigurationCommand(invalid)).toBeNull();
  expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-request', timeoutMs: 10_000,
    command: { ...command, stream: { ...stream, logicalSessionId: 'foreign' } } }))).toBeNull();
  for (const operation of ['commit', 'cancel', 'status']) {
    expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-request', timeoutMs: 10_000, command: {
      method: command.method, instanceId, operation, identity: { ...identity, nodeBootId: 'foreign' },
    } }))).toBeNull();
  }
  for (const result of [
    { kind: 'provider-session-configuration-prepared', instanceId, preparation: { kind: 'prepared', identity: { ...identity, logicalSessionId: 'foreign' } } },
    { kind: 'provider-session-configuration-receipt', instanceId, identity: { ...identity, controllerBootId: 'foreign' }, receipt: null },
  ]) expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-result', result }))).toBeNull();
});

test('receipt phase and outcome contracts cannot expose provider captures or invent confirmed success', () => {
  for (const receipt of [
    { phase: 'prepared', result: { kind: 'applied' } }, { phase: 'settled', result: null },
    { phase: 'settled', result: { kind: 'applied', nativeSession: {} } },
    { phase: 'settled', result: { kind: 'rejected', reason: 'unsupported' } },
    { phase: 'committing', result: null, settings: {} },
  ]) expect(parseNodeSessionConfigurationReply({ kind: 'provider-session-configuration-receipt', instanceId, identity, receipt })).toBeNull();
  const parsed = parseNodeSessionConfigurationCommand(command);
  expect(parsed?.operation).toBe('prepare');
  if (parsed?.operation !== 'prepare') throw new Error('Missing prepared command');
  expect(parsed.request).not.toBe(request);
  expect(parsed.request.next.settings).not.toBe(snapshot.settings);
});

test('known preparation refusals preserve only the closed code and retryability contract', () => {
  for (const code of ['INVALID_SETTINGS', 'INVALID_ENDPOINT', 'OPERATION_UNSUPPORTED', 'SESSION_BUSY']) {
    const preparation = { kind: 'refused', code, retryable: code === 'SESSION_BUSY' };
    const reply = { kind: 'provider-session-configuration-prepared', instanceId, preparation };
    expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-result', result: reply })))
      .toMatchObject({ result: reply });
    for (const invalid of [{ ...preparation, code: 'UNKNOWN_NATIVE_ERROR' }, { ...preparation, retryable: 'true' },
      { ...preparation, message: 'synthetic private native detail' }]) {
      expect(parseNodeSessionConfigurationReply({ ...reply, preparation: invalid })).toBeNull();
    }
    expect(parseNodeSessionConfigurationReply({ kind: 'provider-session-configuration-receipt', instanceId, identity,
      receipt: { phase: 'settled', result: preparation } })).toBeNull();
  }
});
