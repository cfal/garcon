import { expect, test } from 'bun:test';
import { ControllerCliDispatcher, type CliDispatchAccess } from '../cli-dispatcher.js';
import type { GuardRpcReply } from '../rpc.js';
import { CLI_REPLY_BYTES, CLI_OPERATIONS, cliPolicy, parseControllerCliRequest, type CliOperation, type ControllerCliRequest } from '../cli-protocol.js';
import { DomainError } from '../../lib/domain-error.js';
import { cliPair, CLI_NODE_ID } from './cli-fixture.js';
import type { JsonValue } from '../../../common/json.js';
import type { RouteMap } from '../../lib/http-route-types.js';

function request(operation: CliOperation = 'GET /api/v1/chats', body: JsonValue | null = null): ControllerCliRequest {
  return { expectedServerInstanceId: 'controller', http: { operation, body, query: [] } };
}
function dispatcher(routes: RouteMap) {
  return new ControllerCliDispatcher({ routes, serverInstanceId: 'controller', workspaceName: null, isShuttingDown: () => false });
}

test('restricted envelope rejects unknown routes, implicit Local targets, privileged settings and encoded oversize', () => {
  for (const value of [
    { ...request(), principal: { mode: 'local' } },
    { ...request(), http: { ...request().http, operation: 'GET /api/v1/auth/token' } },
    request('PUT /api/v1/app/settings', { features: { transcriptSearch: { enabled: true }, tickets: { enabled: true } } }),
    request('PUT /api/v1/app/settings', { features: { transcriptSearch: { enabled: true } }, apiKeys: {} }),
    request('POST /api/v1/chats/start', { projectPath: '/same/path' }),
    request('GET /api/v1/models'),
    request('POST /api/v1/chats/run', { command: '\0'.repeat(200_000) }),
  ]) expect(() => parseControllerCliRequest(value)).toThrow();
  expect(parseControllerCliRequest(request('PUT /api/v1/app/settings', { features: { transcriptSearch: { enabled: false } } })).http.body)
    .toEqual({ features: { transcriptSearch: { enabled: false } } });
  expect(cliPolicy(request('POST /api/v1/chats/run', { handoff: {} }).http).timeoutMs).toBe(600_000);
  expect(CLI_OPERATIONS['POST /api/v1/chats/fork'].timeoutMs).toBeNull();
});

test('raw route parity preserves query multiplicity, JSON errors, node authority and restart fences', async () => {
  let calls = 0;
  const pair = cliPair(dispatcher({ '/api/v1/chats': { GET: (req, url, server, context) => {
    calls++;
    expect(server).toBeUndefined();
    expect(req.headers.get('Authorization')).toBeNull();
    expect(url.searchParams.getAll('exclude')).toEqual(['tools', 'reasoning']);
    expect(context?.principal).toEqual({ mode: 'execution-node', key: CLI_NODE_ID, nodeId: CLI_NODE_ID, expiresAtMs: null });
    return Response.json({ success: false, error: 'Synthetic rejection', errorCode: 'SESSION_BUSY' }, { status: 409, headers: { 'Retry-After': '2' } });
  } } }));
  try {
    const input = { ...request(), http: { ...request().http, query: [['exclude', 'tools'], ['exclude', 'reasoning']] as const } };
    expect(await pair.worker.call('', 'controllerCli.request', input)).toEqual({ status: 409, retryAfter: '2',
      body: { success: false, error: 'Synthetic rejection', errorCode: 'SESSION_BUSY' } });
    await expect(pair.worker.call('', 'controllerCli.request', { ...input, expectedServerInstanceId: 'old' }))
      .rejects.toMatchObject({ code: 'CLI_CONTROLLER_CHANGED' });
    expect(calls).toBe(1);
  } finally { pair.close(); }
});

test('nested controller-to-worker calls can finish while the reverse request is pending', async () => {
  const pair = cliPair(dispatcher({ '/api/v1/chats': { GET: async () => Response.json(
    await pair.controller.call('', 'projects.resolveFileMentions', { command: 'Synthetic', projectPath: '/worker' }),
  ) } }));
  pair.worker.handle(async () => 'worker result');
  try { expect((await pair.worker.call('', 'controllerCli.request', request())).body).toBe('worker result'); }
  finally { pair.close(); }
});

test('cancelled and retired sessions cannot release unsettled producer reservations or starve short reads', async () => {
  const entered = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const pendingSignals: AbortSignal[] = [];
  const service = dispatcher({
    '/api/v1/chats/fork': { POST: async (req) => { pendingSignals.push(req.signal); if (pendingSignals.length === 2) entered.resolve(); await settled.promise; return Response.json({ ok: true }); } },
    '/api/v1/chats': { GET: () => Response.json([]) },
  });
  const first = cliPair(service);
  const second = cliPair(service);
  const abort = new AbortController();
  const one = first.worker.call('', 'controllerCli.request', request('POST /api/v1/chats/fork', {}), { signal: abort.signal, timeoutMs: null });
  const two = first.worker.call('', 'controllerCli.request', request('POST /api/v1/chats/fork', {}), { signal: abort.signal, timeoutMs: null });
  const both = Promise.allSettled([one, two]);
  try {
    await entered.promise;
    abort.abort();
    expect(await both).toMatchObject([{ status: 'rejected', reason: { outcome: 'unknown' } }, { status: 'rejected', reason: { outcome: 'unknown' } }]);
    expect(pendingSignals.every((signal) => signal.aborted)).toBe(true);
    first.close();
    await expect(second.worker.call('', 'controllerCli.request', request('POST /api/v1/chats/fork', {})))
      .rejects.toMatchObject({ code: 'CLI_SERVICE_BUSY' });
    expect(await second.worker.call('', 'controllerCli.describe', null)).toMatchObject({ defaultNodeId: CLI_NODE_ID });
    expect((await second.worker.call('', 'controllerCli.request', request())).body).toEqual([]);
  } finally { settled.resolve(); first.close(); second.close(); }
});

test('revocation fences late mutation completion even after access is re-enabled', async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let generation = 1;
  const pair = cliPair(dispatcher({ '/api/v1/chats/run': { POST: async () => {
    entered.resolve(); await gate.promise; return Response.json({ secretResult: true });
  } } }), () => { if (generation !== 1) throw new DomainError('CLI_ACCESS_DENIED', 'Lease expired', 403); });
  const pending = pair.worker.call('', 'controllerCli.request', request('POST /api/v1/chats/run', {}));
  try {
    await entered.promise;
    generation = 2;
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'CLI_OUTCOME_UNKNOWN' });
  } finally { gate.resolve(); pair.close(); }
});

test.each([false, true])('revocation after handler settlement still fences RPC publication: mutation=%s', async (mutation) => {
  const lease = new AbortController();
  class RevokingDispatcher extends ControllerCliDispatcher {
    override async request(value: unknown, access: CliDispatchAccess, guardReply: GuardRpcReply) {
      const reply = await super.request(value, { ...access, signal: AbortSignal.any([access.signal, lease.signal]) }, guardReply);
      lease.abort();
      return reply;
    }
  }
  const pair = cliPair(new RevokingDispatcher({ serverInstanceId: 'controller', workspaceName: null, isShuttingDown: () => false,
    routes: { '/api/v1/chats': { GET: () => Response.json({ privateData: true }) },
      '/api/v1/chats/run': { POST: () => Response.json({ committed: true }) } } }));
  try {
    await expect(pair.worker.call('', 'controllerCli.request', request(mutation ? 'POST /api/v1/chats/run' : 'GET /api/v1/chats', mutation ? {} : null)))
      .rejects.toMatchObject({ code: mutation ? 'CLI_OUTCOME_UNKNOWN' : 'CLI_CONTROLLER_UNAVAILABLE' });
    expect(lease.signal.aborted).toBe(true);
  } finally { pair.close(); }
});

test.each([false, true])('oversize and queue-pressure replies preserve read/mutation classification: mutation=%s', async (mutation) => {
  let oversized = true;
  const operation = mutation ? 'POST /api/v1/chats/run' : 'GET /api/v1/chats';
  const route = () => Response.json({ output: oversized ? '\0'.repeat(1_500_000) : 'small' });
  const pair = cliPair(dispatcher({ '/api/v1/chats/run': { POST: route }, '/api/v1/chats': { GET: route } }));
  try {
    await expect(pair.worker.call('', 'controllerCli.request', request(operation, mutation ? {} : null)))
      .rejects.toMatchObject({ code: mutation ? 'CLI_OUTCOME_UNKNOWN' : 'CLI_RESULT_TOO_LARGE' });
    oversized = false;
    pair.block();
    pair.controller.transport.send(JSON.stringify({ type: 'result', id: 'unrelated', value: 'x'.repeat(CLI_REPLY_BYTES) }));
    const busy = pair.worker.call('', 'controllerCli.request', request(operation, mutation ? {} : null));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    pair.unblock();
    await expect(busy).rejects.toMatchObject({ code: mutation ? 'CLI_OUTCOME_UNKNOWN' : 'CLI_SERVICE_BUSY' });
    expect(pair.worker.transport.connected).toBe(true);
    expect((await pair.worker.call('', 'controllerCli.request', request(operation, mutation ? {} : null))).body).toEqual({ output: 'small' });
  } finally { pair.close(); }
});

test('simultaneous bulk completions cannot overbook the shared-channel reply budget', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let count = 0;
  const pair = cliPair(dispatcher({ '/api/v1/chats': { GET: async () => {
    if (++count === 3) entered.resolve();
    await release.promise;
    return Response.json({ data: 'x'.repeat(3 * 1024 * 1024) });
  } } }));
  try {
    const pending = Promise.allSettled(Array.from({ length: 3 }, () => pair.worker.call('', 'controllerCli.request', request())));
    await entered.promise;
    pair.block();
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(pair.controller.transport.channel.queuedBytes).toBeLessThan(CLI_REPLY_BYTES);
    expect(pair.controller.transport.connected).toBe(true);
    pair.unblock();
    const results = await pending;
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'CLI_SERVICE_BUSY' } });
  } finally { release.resolve(); pair.close(); }
});
