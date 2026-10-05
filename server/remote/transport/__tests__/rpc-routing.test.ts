import { expect, test } from 'bun:test';
import { CLI_OPERATIONS, cliPolicy, type CliOperation } from '../cli-protocol.js';
import { rpcLane } from '../rpc-routing.js';
import { parseBulkControl } from '../rpc-lane.js';

test('bulk routing preserves quick summaries and primary lifecycle', () => {
  for (const method of ['git.getQuickSummary', 'files.identity', 'files.revision', 'execution.abort', 'permissions.respond', 'credentials.resolve', 'forking.fork']) {
    expect(rpcLane(method, null)).toBe('primary');
  }
  for (const method of ['git.getStatus', 'gh.getStatus', 'files.read', 'files.save', 'files.tree', 'files.browse', 'files.list', 'files.createDirectory', 'history.open', 'history.next', 'history.close']) {
    expect(rpcLane(method, null)).toBe('bulk');
  }
  expect(rpcLane('calls.reconcile', null, 'bulk')).toBe('bulk');
  expect(() => rpcLane('git.unknown', null)).toThrow('Unknown executor RPC method');
  expect(() => rpcLane('files.unknown', null)).toThrow('Unknown executor RPC method');
});

test('only explicit small CLI controls use primary', () => {
  const primary: CliOperation[] = ['GET /api/v1/chats/turn-receipt', 'POST /api/v1/chats/stop', 'POST /api/v1/chats/permissions/decision'];
  for (const [operation, policy] of Object.entries(CLI_OPERATIONS)) {
    expect(policy.lane).toBe(primary.includes(operation as CliOperation) ? 'primary' : 'bulk');
  }
  expect(cliPolicy({ operation: 'POST /api/v1/chats/run', query: [], body: { handoff: true } })).toMatchObject({ lane: 'bulk', pool: 'long' });
  expect(rpcLane('controllerCli.request', {
    expectedServerInstanceId: 'controller', http: { operation: primary[1], query: [], body: {} },
  })).toBe('primary');
  expect(() => rpcLane('controllerCli.request', {})).toThrow();
});

test('lifecycle controls have exact bounded identities', () => {
  const frame = { type: 'bulk-activate', sessionId: crypto.randomUUID() };
  expect(parseBulkControl(frame)).toEqual(frame);
  expect(() => parseBulkControl({ ...frame, extra: true })).toThrow();
  expect(() => parseBulkControl({ ...frame, sessionId: 'stale' })).toThrow();
  expect(() => parseBulkControl({ ...frame, type: 'bulk-unknown' })).toThrow();
});
