import { expect, test } from 'bun:test';
import { ExecutorRpc } from '../rpc.js';
import { SessionTransport } from '../session-transport.js';
import type { RpcLane } from '../rpc-lane.js';
import { PRIMARY_SMALL_RPC_BYTES } from '../limits.js';

function endpoint(lane: RpcLane) {
  const responses: Record<string, unknown>[] = [];
  const transport = new SessionTransport(crypto.randomUUID(), 'peer', () => {}, {}, 'synthetic-executor', lane);
  const channel = transport.attach({ send: (body) => responses.push(JSON.parse(body)), close() {} });
  const rpc = new ExecutorRpc(transport);
  return { rpc, transport, responses, receive: (frame: object) => channel.receive(JSON.stringify(frame)) };
}

test('wrong-lane calls reject on sender and receiver without executing a handler', async () => {
  for (const lane of ['primary', 'bulk'] as const) {
    const peer = endpoint(lane);
    let calls = 0;
    peer.rpc.handle(async () => { calls++; return null; });
    try {
      if (lane === 'primary') await expect(peer.rpc.call('', 'files.list', { projectPath: '/project' })).rejects.toMatchObject({ outcome: 'not-dispatched' });
      else await expect(peer.rpc.call('', 'projects.inspect', { projectPath: '/project' })).rejects.toMatchObject({ outcome: 'not-dispatched' });
      peer.receive({ type: 'request', id: crypto.randomUUID(), seq: 1, integrationId: '',
        method: lane === 'primary' ? 'files.list' : 'projects.inspect', request: { projectPath: '/project' } });
      expect(peer.responses).toHaveLength(1);
      expect(peer.responses[0]).toMatchObject({ type: 'error', error: { outcome: 'not-dispatched' } });
      expect(calls).toBe(0);
      expect(peer.transport.connected).toBe(true);
    } finally { peer.transport.close(); }
  }
});

test('primary small-call caps preserve Git and CLI mutation error contracts', async () => {
  const peer = endpoint('primary');
  const large = 'x'.repeat(PRIMARY_SMALL_RPC_BYTES);
  peer.rpc.handle(async () => ({ large }));
  try {
    await expect(peer.rpc.call('', 'git.getQuickSummary', { input: { projectPath: large }, budgetMs: 1000 }))
      .rejects.toMatchObject({ code: 'GIT_REQUEST_TOO_LARGE' });
    expect(peer.responses).toHaveLength(0);
    const requests = [
      { method: 'git.getQuickSummary', request: { input: { projectPath: '/project' }, budgetMs: 1000 }, code: 'GIT_RESULT_TOO_LARGE' },
      { method: 'controllerCli.request', request: { expectedServerInstanceId: 'synthetic',
        http: { operation: 'POST /api/v1/chats/stop', query: [], body: {} } }, code: 'CLI_OUTCOME_UNKNOWN' },
      { method: 'controllerCli.describe', request: null, code: 'CLI_RESULT_TOO_LARGE' },
    ];
    for (const [seq, { method, request, code }] of requests.entries()) {
      const id = crypto.randomUUID();
      peer.receive({ type: 'request', id, seq: seq + 1, integrationId: '', method, request });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(peer.responses.find((frame) => frame.id === id)).toMatchObject({ type: 'error', error: { code } });
    }
    expect(peer.transport.connected).toBe(true);
  } finally { peer.transport.close(); }
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
