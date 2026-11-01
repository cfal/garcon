import { expect, test } from 'bun:test';
import { CLI_OPERATIONS, resolveCliRequest, type CliOperation } from '../cli-protocol.js';
import { rpcLane, rpcPolicyV1 } from '../rpc-routing.js';
import { parseBulkControl } from '../rpc-lane.js';
import { RPC_V1 } from '@garcon/common/executor-contracts';
import { resolveRpc } from '../rpc-registrations.js';
import { testSessionProtocol } from '../../__tests__/test-session-transport.js';

test('bulk routing preserves quick summaries and primary lifecycle', () => {
  for (const method of ['git.getQuickSummary', 'files.identity', 'files.revision', 'execution.abort', 'permissions.respond', 'credentials.resolve', 'forking.fork'] as const) {
    expect(rpcLane(RPC_V1[method])).toBe('primary');
  }
  for (const method of ['git.getStatus', 'gh.getStatus', 'gh.getPullRequestReviewTarget', 'gh.createPullRequestComment', 'gh.minimizePullRequestComment', 'files.read', 'files.save', 'files.tree', 'files.browse', 'files.list', 'files.createDirectory', 'history.open', 'history.next', 'history.close', 'usageHistory.read'] as const) {
    expect(rpcLane(RPC_V1[method])).toBe('bulk');
  }
  for (const lane of ['primary', 'bulk'] as const) {
    expect(rpcPolicyV1(RPC_V1['calls.reconcile'], { calls: [] }, lane).lane).toBe(lane);
  }
  for (const name of ['git.unknown', 'gh.unknown', 'files.unknown']) {
    expect(() => resolveRpc(testSessionProtocol(), { name, version: 1 }, 'send')).toThrow('does not support this operation');
  }
});

test('static routing refuses request-dependent definitions', () => {
  for (const method of ['calls.reconcile', 'controllerCli.request'] as const) {
    expect(() => rpcLane(RPC_V1[method])).toThrow('Request-dependent routing requires a captured RPC policy');
  }
});

test('only explicit small CLI controls use primary', () => {
  const primary: CliOperation[] = ['GET /api/v1/chats/turn-receipt', 'POST /api/v1/chats/stop', 'POST /api/v1/chats/permissions/decision'];
  for (const [operation, versions] of Object.entries(CLI_OPERATIONS)) {
    expect(versions[1].lane).toBe(primary.includes(operation as CliOperation) ? 'primary' : 'bulk');
  }
  const lookup = testSessionProtocol().contracts.cliRegistration;
  expect(resolveCliRequest({ contract: { name: CLI_OPERATIONS['POST /api/v1/chats/run'][1].name, version: 1 },
    expectedServerInstanceId: 'synthetic-controller',
    http: { operation: 'POST /api/v1/chats/run', query: [], body: { handoff: true } } }, lookup).policy)
    .toMatchObject({ lane: 'bulk', pool: 'long' });
  const stop = {
    contract: { name: CLI_OPERATIONS['POST /api/v1/chats/stop'][1].name, version: 1 },
    expectedServerInstanceId: 'controller', http: { operation: primary[1], query: [], body: {} },
  };
  expect(rpcPolicyV1(RPC_V1['controllerCli.request'], stop, 'primary', lookup).lane).toBe('primary');
  expect(() => rpcPolicyV1(RPC_V1['controllerCli.request'], stop, 'bulk', lookup)).toThrow('wrong lane');
  expect(() => rpcPolicyV1(RPC_V1['controllerCli.request'], {}, 'primary', lookup)).toThrow();
  expect(() => rpcPolicyV1(RPC_V1['controllerCli.request'], stop, 'primary')).toThrow('registered operation codecs');
});

test('lifecycle controls have exact bounded identities', () => {
  const frame = { type: 'bulk-activate', sessionId: crypto.randomUUID() };
  expect(parseBulkControl(frame)).toEqual(frame);
  expect(() => parseBulkControl({ ...frame, extra: true })).toThrow();
  expect(() => parseBulkControl({ ...frame, sessionId: 'stale' })).toThrow();
  expect(() => parseBulkControl({ ...frame, type: 'bulk-unknown' })).toThrow();
});
