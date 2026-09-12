import { expect, test } from 'bun:test';
import {
  MAX_NODE_PERMISSION_BYTES, parseNodePermissionCommandText, parseNodePermissionDecision, parseNodePermissionResultText,
  serializeNodePermissionCommand, serializeNodePermissionResult, type NodePermissionCommand, type NodePermissionResult,
} from '../permission-wire.js';

const permission = { stream: { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session', streamId: 'synthetic-stream' },
  handle: 'synthetic-handle', runId: 'synthetic-run', permissionOccurrenceId: '00000000-0000-4000-8000-000000000001' };

test('permission commands snapshot bounded private decisions and qualify every identity', () => {
  const command: NodePermissionCommand = { method: 'permission-respond', permission, decision: { allow: true, alwaysAllow: false, response: { answer: 'synthetic answer' } } };
  expect(parseNodePermissionCommandText(serializeNodePermissionCommand(command))).toEqual(command);
  const status: NodePermissionCommand = { method: 'permission-status', permission };
  expect(parseNodePermissionCommandText(serializeNodePermissionCommand(status))).toEqual(status);
  const decision = { allow: true, response: { answer: ['synthetic answer'] } };
  const captured = parseNodePermissionDecision(decision);
  decision.response.answer[0] = 'changed';
  expect(captured).toEqual({ allow: true, alwaysAllow: false, response: { answer: ['synthetic answer'] } });
});

test('permission wire rejects extra fields, unsupported versions, malformed references, and excessive bodies', () => {
  const command = { version: 1, method: 'permission-status', permission };
  for (const invalid of [
    { ...command, secret: 'synthetic' }, { ...command, version: 2 }, { ...command, decision: { allow: true } },
    { ...command, permission: { ...permission, handle: '' } }, { ...command, permission: { ...permission, permissionOccurrenceId: 'native-id' } },
    { ...command, permission: { ...permission, stream: { ...permission.stream, extra: true } } },
    { ...command, method: 'permission-respond', decision: { allow: 'yes' } },
    { ...command, method: 'permission-respond', decision: { allow: true, response: [] } },
    { ...command, method: 'permission-respond', decision: { allow: true, secret: 'synthetic' } },
    { ...command, method: 'permission-respond', decision: { allow: true, response: { answer: 'x'.repeat(MAX_NODE_PERMISSION_BYTES) } } },
  ]) expect(parseNodePermissionCommandText(JSON.stringify(invalid))).toBeNull();
  expect(parseNodePermissionDecision({ allow: true, response: { callback() {} } })).toBeNull();
});

test('permission replies contain only exact references and body-free outcomes', () => {
  const results: NodePermissionResult[] = [
    { kind: 'unknown' }, { kind: 'rejected', code: 'NODE_CAPACITY' }, { kind: 'permission', receipt: null },
    ...(['available', 'pending', 'resolved', 'unknown', 'expired'] as const).map((phase) => ({ kind: 'permission' as const, receipt: { permission, phase } })),
  ];
  for (const result of results) {
    expect(parseNodePermissionResultText(serializeNodePermissionResult(result))).toEqual(result);
    expect(parseNodePermissionResultText(JSON.stringify({ version: 1, ...result, message: 'synthetic private body' }))).toBeNull();
  }
  expect(parseNodePermissionResultText(JSON.stringify({ version: 1, kind: 'permission', receipt: { permission, phase: 'resolved', decision: { allow: true } } }))).toBeNull();
});
