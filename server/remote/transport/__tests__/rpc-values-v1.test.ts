import { expect, test } from 'bun:test';
import type { ExecutorOperation } from '@garcon/common/executor-contracts';
import { parseRpcRequestV1, parseRpcResultV1 } from '../rpc-values-v1.js';

const reader = { executorId: 'local', instanceId: 'synthetic-instance', integrationId: 'synthetic', kind: 'history-reader', id: 'reader' };
const settings = { ownerId: 'synthetic', schemaVersion: 1, values: {}, extra: 'retained' };

test.each<{ method: ExecutorOperation; value: unknown }>([
  { method: 'executor.describe', value: null },
  { method: 'history.close', value: reader },
  { method: 'settings.migrate', value: settings },
  { method: 'catalog.snapshot', value: { strict: false, extra: 'retained' } },
  { method: 'history.next', value: { reader, page: 0 } },
])('$method validates its request without replacing the original value', ({ method, value }) => {
  expect(parseRpcRequestV1(method, value)).toBe(value);
});

test.each<{ method: ExecutorOperation; value: unknown }>([
  { method: 'execution.abort', value: false },
  { method: 'singleQuery.run', value: '' },
  { method: 'history.close', value: undefined },
  { method: 'history.close', value: null },
  { method: 'history.open', value: reader },
  { method: 'settings.migrate', value: settings },
  { method: 'steering.captureTarget', value: null },
  { method: 'commands.discover', value: [{ name: 'synthetic', source: 'command', extra: 'retained' }] },
  { method: 'execution.runningSessions', value: [{ agentSessionId: 'synthetic', status: null, startedAt: null }] },
  { method: 'history.next', value: { done: true, rows: [], extra: 'retained' } },
  { method: 'auth.loginStatus', value: { running: false, state: 'idle' } },
])('$method validates its result without replacing the original value', ({ method, value }) => {
  expect(parseRpcResultV1(method, value)).toBe(value);
});

test.each([null, undefined, false, 1, 'synthetic', []].map(value => ({ value })))(
  'record requests and results reject %j with the v1 error', ({ value }) => {
    expect(() => parseRpcRequestV1('catalog.snapshot', value)).toThrow(new SyntaxError('Invalid RPC v1 data'));
    expect(() => parseRpcResultV1('history.next', value)).toThrow(new SyntaxError('Invalid RPC v1 data'));
  });

test('non-record cases retain their shape checks', () => {
  expect(() => parseRpcRequestV1('executor.describe', {})).toThrow(new SyntaxError('Invalid RPC v1 data'));
  expect(() => parseRpcRequestV1('history.close', { ...reader, kind: 'execution' })).toThrow(new SyntaxError('Invalid RPC v1 data'));
  expect(() => parseRpcResultV1('history.close', {})).toThrow(new SyntaxError('Invalid RPC v1 data'));
  expect(() => parseRpcResultV1('singleQuery.run', null)).toThrow(new SyntaxError('Invalid RPC v1 data'));
  expect(() => parseRpcResultV1('execution.runningSessions', [null])).toThrow(new SyntaxError('Invalid RPC v1 data'));
});
