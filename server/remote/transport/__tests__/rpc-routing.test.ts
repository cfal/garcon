import { expect, test } from 'bun:test';
import { CLI_OPERATIONS, cliPolicy, type CliOperation } from '../cli-protocol.js';
import { rpcLane } from '../rpc-routing.js';
import { parseBulkControl } from '../rpc-lane.js';
import { RPC_V1 } from '@garcon/common/executor-contracts';
import { resolveRpc } from '../rpc-registrations.js';
import { testSessionProtocol } from '../../__tests__/test-session-transport.js';

test('bulk routing preserves quick summaries and primary lifecycle', () => {
  for (const method of ['git.getQuickSummary', 'files.identity', 'files.revision', 'execution.abort', 'permissions.respond', 'credentials.resolve', 'forking.fork'] as const) {
    expect(rpcLane(RPC_V1[method], null)).toBe('primary');
  }
  for (const method of ['git.getStatus', 'gh.getStatus', 'gh.getPullRequestReviewTarget', 'gh.createPullRequestComment', 'gh.minimizePullRequestComment', 'files.read', 'files.save', 'files.tree', 'files.browse', 'files.list', 'files.createDirectory', 'history.open', 'history.next', 'history.close'] as const) {
    expect(rpcLane(RPC_V1[method], null)).toBe('bulk');
  }
  expect(rpcLane(RPC_V1['calls.reconcile'], null, 'bulk')).toBe('bulk');
  for (const name of ['git.unknown', 'gh.unknown', 'files.unknown']) {
    expect(() => resolveRpc(testSessionProtocol(), { name, version: 1 }, 'send')).toThrow('does not support this operation');
  }
});

test('only explicit small CLI controls use primary', () => {
  const primary: CliOperation[] = ['GET /api/v1/chats/turn-receipt', 'POST /api/v1/chats/stop', 'POST /api/v1/chats/permissions/decision'];
  for (const [operation, versions] of Object.entries(CLI_OPERATIONS)) {
    expect(versions[1].lane).toBe(primary.includes(operation as CliOperation) ? 'primary' : 'bulk');
  }
  expect(cliPolicy({ contract: CLI_OPERATIONS['POST /api/v1/chats/run'][1],
    http: { operation: 'POST /api/v1/chats/run', query: [], body: { handoff: true } } })).toMatchObject({ lane: 'bulk', pool: 'long' });
  const lookup = testSessionProtocol().contracts.cliRegistration;
  expect(rpcLane(RPC_V1['controllerCli.request'], {
    contract: { name: CLI_OPERATIONS['POST /api/v1/chats/stop'][1].name, version: 1 },
    expectedServerInstanceId: 'controller', http: { operation: primary[1], query: [], body: {} },
  }, 'primary', lookup)).toBe('primary');
  expect(() => rpcLane(RPC_V1['controllerCli.request'], {}, 'primary', lookup)).toThrow();
});

test('lifecycle controls have exact bounded identities', () => {
  const frame = { type: 'bulk-activate', sessionId: crypto.randomUUID() };
  expect(parseBulkControl(frame)).toEqual(frame);
  expect(() => parseBulkControl({ ...frame, extra: true })).toThrow();
  expect(() => parseBulkControl({ ...frame, sessionId: 'stale' })).toThrow();
  expect(() => parseBulkControl({ ...frame, type: 'bulk-unknown' })).toThrow();
});
