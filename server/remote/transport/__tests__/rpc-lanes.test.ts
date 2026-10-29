import { handleTestRpc } from '../../__tests__/test-session-transport.js';
import { CLI_OPERATIONS } from '@garcon/common/cli-contracts';
import { RPC_V1 } from '@garcon/common/executor-contracts';
import { expect, test } from 'bun:test';
import { ExecutorRpc } from '../rpc.js';
import { TestSessionTransport, WorkerSessionTransport } from '../../__tests__/test-session-transport.js';
import type { RpcLane } from '../rpc-lane.js';
import { PRIMARY_SMALL_RPC_BYTES } from '../limits.js';

function endpoint(lane: RpcLane, role: 'controller' | 'worker' = 'controller') {
  const responses: Record<string, unknown>[] = [];
  const replied = Promise.withResolvers<Record<string, unknown>>();
  const transport = new (role === 'controller' ? TestSessionTransport : WorkerSessionTransport)(crypto.randomUUID(), 'peer', () => {}, {}, 'synthetic-executor', lane);
  const channel = transport.attach({ send: (body) => { const frame = JSON.parse(body); responses.push(frame); replied.resolve(frame); }, close() {} });
  const rpc = new ExecutorRpc(transport);
  return { rpc, transport, responses, replied: replied.promise, receive: (frame: object) => channel.receive(JSON.stringify(frame)) };
}

test('wrong-lane calls reject on sender and receiver without executing a handler', async () => {
  for (const lane of ['primary', 'bulk'] as const) {
    const caller = endpoint(lane);
    const peer = endpoint(lane, 'worker');
    let calls = 0;
    handleTestRpc(peer.rpc, async () => { calls++; return null; });
    try {
      if (lane === 'primary') await expect(caller.rpc.call('', RPC_V1['files.list'], { projectPath: '/project' })).rejects.toMatchObject({ outcome: 'not-dispatched' });
      else await expect(caller.rpc.call('', RPC_V1['projects.inspect'], { projectPath: '/project' })).rejects.toMatchObject({ outcome: 'not-dispatched' });
      peer.receive({ version: 1, type: 'request', id: crypto.randomUUID(), seq: 1, integrationId: '',
        method: lane === 'primary' ? 'files.list' : 'projects.inspect', request: { projectPath: '/project' } });
      expect(peer.responses).toHaveLength(1);
      expect(peer.responses[0]).toMatchObject({ type: 'error', error: { outcome: 'not-dispatched' } });
      expect(calls).toBe(0);
      expect(peer.transport.connected).toBe(true);
    } finally { caller.transport.close(); peer.transport.close(); }
  }
});

test('primary small-call caps preserve Git and CLI mutation error contracts', async () => {
  const caller = endpoint('primary');
  const large = 'x'.repeat(PRIMARY_SMALL_RPC_BYTES);
  try {
    const oversized = { input: { projectPath: '/project' }, budgetMs: 1000, padding: large };
    await expect(caller.rpc.call('', RPC_V1['git.getQuickSummary'], oversized))
      .rejects.toMatchObject({ code: 'GIT_REQUEST_TOO_LARGE' });
    expect(caller.responses).toHaveLength(0);
    const requests = [
      { method: 'git.getQuickSummary', request: { input: { projectPath: '/project' }, budgetMs: 1000 }, code: 'GIT_RESULT_TOO_LARGE',
        value: { executorId: 'local', instanceId: 'synthetic', project: '/project', status: 'unknown', message: large } },
      { method: 'controllerCli.request', request: { contract: { name: CLI_OPERATIONS['POST /api/v1/chats/stop'][1].name, version: 1 }, expectedServerInstanceId: 'synthetic',
        http: { operation: 'POST /api/v1/chats/stop', query: [], body: {} } }, code: 'CLI_OUTCOME_UNKNOWN', value: { status: 200, body: { large } } },
      { method: 'controllerCli.describe', request: null, code: 'CLI_RESULT_TOO_LARGE',
        value: { serverInstanceId: 'synthetic', defaultExecutorId: 'local', workspaceName: large } },
    ];
    for (const [seq, { method, request, code, value }] of requests.entries()) {
      const peer = endpoint('primary', method === 'git.getQuickSummary' ? 'worker' : 'controller');
      handleTestRpc(peer.rpc, async () => value);
      try {
        const id = crypto.randomUUID();
        peer.receive({ type: 'request', version: 1, id, seq: seq + 1, integrationId: '', method, request });
        expect(await peer.replied).toMatchObject({ type: 'error', error: { code } });
        expect(peer.transport.connected).toBe(true);
      } finally { peer.transport.close(); }
    }
  } finally { caller.transport.close(); }
});

test('primary-only frames retire only the offending bulk endpoint', () => {
  const primary = endpoint('primary');
  const bulk = endpoint('bulk');
  try {
    bulk.receive({ type: 'producer-ack', acknowledgements: [] });
    expect(bulk.transport.connected).toBe(false);
    expect(primary.transport.connected).toBe(true);
  } finally { primary.transport.close(); bulk.transport.close(); }
});
