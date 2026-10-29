import type { CliOperation } from '@garcon/common/cli-contracts';
import { rpcWireV1 } from '../transport/rpc-wire-v1.js';
import { RPC_V1 } from '@garcon/common/executor-contracts';
import crypto from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { cliGatewayRuntimeFile } from '../../../common/cli-runtime-paths.js';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { AgentCallError } from '@garcon/server-agent-interface';
import { CLI_SERVER_INSTANCE_HEADER, parseCliIdentity, type CliContext, type CliGatewayDescriptor } from '../../../common/server-runtime.js';
import { CLI_BOOTSTRAP_VERSION } from '../../../common/cli-contracts.js';
import { supportsDefinition } from '../../../common/protocol-contracts.js';
import type { JsonValue } from '../../../common/json.js';
import { DomainError } from '../../common/domain-error.js';
import { getTokenFromRequest } from '../../common/http-body.js';
import { jsonError } from '../../common/http-error.js';
import { createServerRuntimeState, publishRuntimeDescriptor, removeServerRuntime } from '../../common/server-runtime.js';
import { runtimeProofResponse } from '../../common/runtime-proof.js';
import { CliAdmission } from '../transport/cli-admission.js';
import { cliRequestBytes, cliRequestTooLarge, cliRoute, cliWireV1, cliRequestContract, parseCliHttpResponse,
  resolveCliRequest, type CliForward } from '../transport/cli-protocol.js';
import type { ExecutorRpcConnection } from '../transport/rpc-connection.js';
import type { RpcLane } from '../transport/rpc-lane.js';
import { assertCliSupported } from '../transport/protocol-policy.js';

function gatewayError(error: unknown): Response {
  if (error instanceof DomainError) {
    const response = jsonError(error.message, error.status, error.code, error.retryable);
    if (error.code === 'CLI_SERVICE_BUSY') response.headers.set('Retry-After', '1');
    return response;
  }
  if (error instanceof AgentCallError && error.outcome === 'not-dispatched') {
    return jsonError('The executor controller is unavailable', 503, 'CLI_CONTROLLER_UNAVAILABLE', true);
  }
  return jsonError('The CLI request may have reached Garcon; its outcome could not be confirmed', 503, 'CLI_OUTCOME_UNKNOWN', false);
}

async function readBody(request: IncomingMessage, lane: RpcLane): Promise<JsonValue | null> {
  const limit = cliRequestBytes(lane);
  if (Number(request.headers['content-length']) > limit) throw cliRequestTooLarge(lane);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const error = (reason: Error) => { cleanup(); reject(reason); };
    const aborted = () => error(new DomainError('CLI_CONTROLLER_UNAVAILABLE', 'CLI upload aborted before dispatch', 503, true));
    const end = () => { cleanup(); resolve(); };
    const data = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > limit) {
        request.pause();
        error(cliRequestTooLarge(lane));
      } else chunks.push(chunk);
    };
    request.on('data', data).once('end', end).once('error', error).once('aborted', aborted);
  });
  if (bytes === 0) return null;
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new DomainError('VALIDATION_FAILED', 'CLI requests require application/json', 415);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as JsonValue; }
  catch { throw new DomainError('VALIDATION_FAILED', 'Malformed JSON', 400); }
}

export async function startCliGateway(options: {
  readonly dataDir: string;
  readonly currentConnection: () => Pick<ExecutorRpcConnection, 'primary' | 'acquire'> | null;
}): Promise<{ readonly runtimeFile: string; readonly descriptor: CliGatewayDescriptor; dispose(): Promise<void> }> {
  const runtime = createServerRuntimeState(options.dataDir);
  const admission = new CliAdmission();
  let stopped = false;
  let responses = 0;
  let bulkResponses = 0;
  const server = createServer({ maxHeaderSize: 32 * 1024, requestTimeout: 30_000, headersTimeout: 10_000 }, (incoming, outgoing) => {
    const abort = new AbortController();
    let httpLane: RpcLane | null = null;
    const reserveHttp = (lane: RpcLane) => {
      if (responses >= 16 || lane === 'bulk' && bulkResponses >= 12) {
        throw new DomainError('CLI_SERVICE_BUSY', 'CLI HTTP response budget exhausted', 503, true);
      }
      httpLane = lane;
      responses++;
      if (lane === 'bulk') bulkResponses++;
    };
    incoming.once('aborted', () => abort.abort());
    outgoing.once('close', () => {
      if (httpLane !== null) responses--;
      if (httpLane === 'bulk') bulkResponses--;
      abort.abort();
    });
    outgoing.on('error', () => abort.abort());
    const timeout = (ms: number) => outgoing.setTimeout(ms, () => outgoing.destroy());
    timeout(30_000);
    const dispatch = async () => {
      let response: Response;
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const request = new Request(new URL(incoming.url ?? '/', 'http://127.0.0.1'), {
          method: incoming.method, headers, signal: abort.signal,
        });
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/api/v1/runtime') {
          reserveHttp('primary');
          response = runtimeProofResponse(runtime, url);
        } else {
          const token = Buffer.from(getTokenFromRequest(request) ?? '');
          const capability = Buffer.from(runtime.localCapability);
          if (token.length !== capability.length || !crypto.timingSafeEqual(token, capability) || request.headers.has('Origin')) {
            throw new DomainError('CLI_ACCESS_DENIED', 'A local CLI gateway capability is required', 403);
          }
          const connection = stopped ? null : options.currentConnection();
          const rpc = connection?.primary;
          if (!rpc || !rpc.transport.connected) throw new AgentCallError('not-dispatched', 'Controller is disconnected');
          const expectedServerInstanceId = request.headers.get(CLI_SERVER_INSTANCE_HEADER);
          if (request.method === 'GET' && url.pathname === '/api/v1/cli/context') {
            reserveHttp('primary');
            const release = admission.acquire('gateway', 'short', 'primary');
            try {
              const identity = parseCliIdentity(await rpc.call('', RPC_V1['controllerCli.describe'], null, { signal: request.signal, timeoutMs: 5_000 }));
              const contracts = supportsDefinition(rpc.transport.profile.contracts, RPC_V1['controllerCli.request'])
                ? Object.fromEntries(Object.entries(rpc.transport.profile.contracts).filter(([name]) => name.startsWith('cli.'))) : {};
              const context: CliContext = { ...identity, protocol: { bootstrap: CLI_BOOTSTRAP_VERSION, contracts } };
              if (!rpc.transport.connected || options.currentConnection() !== connection) throw new AgentCallError('not-dispatched', 'Controller connection changed');
              if (context.defaultExecutorId !== rpc.transport.executorId) throw new Error('CLI context does not match the authenticated executor');
              if (expectedServerInstanceId !== null && context.serverInstanceId !== expectedServerInstanceId) {
                throw new DomainError('CLI_CONTROLLER_CHANGED', 'Garcon restarted; start a new CLI invocation', 409);
              }
              response = Response.json(context);
            } finally { release(); }
          } else {
            const route = cliRoute(request.method, url.pathname);
            const contract = cliRequestContract(request.headers, route.operation);
            const registered = rpc.transport.protocol.contracts.cliRegistration(route.operation, contract);
            if (registered.side !== 'forwarder') throw new Error('CLI forwarding implementation is unavailable');
            assertCliSupported(rpc.transport.profile, registered.definition);
            if (!supportsDefinition(rpc.transport.profile.contracts, RPC_V1['controllerCli.request'])) {
              throw new DomainError('OPERATION_UNSUPPORTED', 'This connection cannot forward CLI operations', 422);
            }
            const lane = registered.definition.lane;
            reserveHttp(lane);
            if (expectedServerInstanceId === null) throw new DomainError('VALIDATION_FAILED', 'Expected controller instance is required', 400);
            const contentLength = incoming.headers['content-length'];
            const hasBody = incoming.headers['transfer-encoding'] !== undefined
              || contentLength !== undefined && contentLength !== '0';
            const body = hasBody ? await readBody(incoming, lane) : null;
            const { request: call, policy } = resolveCliRequest({ expectedServerInstanceId, contract,
              http: { ...route, query: [...url.searchParams], body } }, rpc.transport.protocol.contracts.cliRegistration);
            const release = admission.acquire('gateway', policy.pool, lane);
            // Native HTTP idle timeouts do not bound maintenance work; restore the drain deadline before replying.
            timeout(0);
            try {
              const result = await registered.dispatch(connection!, call, policy, request.signal);
              response = Response.json(result.body, { status: result.status,
                headers: result.retryAfter ? { 'Retry-After': result.retryAfter } : {} });
            } finally { release(); timeout(30_000); }
          }
        }
      } catch (error) { response = gatewayError(error); }
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('Connection', 'close');
      const body = Buffer.from(await response.arrayBuffer());
      if (abort.signal.aborted) { outgoing.end(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (httpLane === null) {
        // Rejected uploads never wait for their body or hold a reserved response slot.
        timeout(1_000);
        outgoing.end(body, () => incoming.destroy());
        return;
      }
      for (let offset = 0; offset < body.byteLength; offset += 64 * 1024) {
        if (!outgoing.write(body.subarray(offset, offset + 64 * 1024))) {
          await once(outgoing, 'drain', { signal: abort.signal });
        }
      }
      outgoing.end();
    };
    void dispatch().catch(() => outgoing.destroy());
  });
  // Socket close covers pending handlers and slow response drains, unlike Bun's fetch request counters.
  server.maxConnections = 32;
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('CLI gateway has no loopback address');
  const stop = async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  };
  const runtimeFile = cliGatewayRuntimeFile(options.dataDir);
  const { workspaceDir: _workspaceDir, ...identity } = runtime.identity;
  const descriptor: CliGatewayDescriptor = { ...identity, kind: 'executor-cli', pid: process.pid,
    baseUrl: `http://127.0.0.1:${address.port}`, localCapability: runtime.localCapability };
  let publishing = false;
  try {
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    publishing = true;
    await publishRuntimeDescriptor(runtimeFile, descriptor);
  } catch (error) {
    await stop();
    if (publishing) await removeServerRuntime(runtimeFile, descriptor.instanceId).catch(() => {});
    throw error;
  }
  return { runtimeFile, descriptor, async dispose() {
    if (stopped) return;
    stopped = true;
    await stop();
    await removeServerRuntime(runtimeFile, descriptor.instanceId);
  } };
}

export const CLI_GATEWAY_RPC_CLIENTS = Object.freeze([
  rpcWireV1('controllerCli.describe'),
  rpcWireV1('controllerCli.request'),
] as const);

const forwardCliV1: CliForward = async (connection, request, policy, signal) => {
  const held = await connection.acquire(policy.lane, { signal, timeoutMs: policy.timeoutMs });
  return parseCliHttpResponse(await held.rpc.call('', RPC_V1['controllerCli.request'], request, { signal, timeoutMs: held.timeoutMs }));
};

const CLI_GATEWAY_V1 = [
  'GET /api/v1/scheduled-prompts',
  'POST /api/v1/scheduled-prompts',
  'PUT /api/v1/scheduled-prompts',
  'DELETE /api/v1/scheduled-prompts',
  'PUT /api/v1/scheduled-prompts/enabled',
  'GET /api/v1/executors',
  'POST /api/v1/executors',
  'PATCH /api/v1/executors/:executorId',
  'DELETE /api/v1/executors/:executorId',
  'GET /api/v1/executors/:executorId/connection',
  'GET /api/v1/api-provider-assignments',
  'PUT /api/v1/api-provider-assignments',
  'DELETE /api/v1/api-provider-assignments',
  'GET /api/v1/models',
  'GET /api/v1/app/settings',
  'GET /api/v1/preambles',
  'GET /api/v1/chats',
  'GET /api/v1/chats/messages',
  'GET /api/v1/chats/snapshot',
  'GET /api/v1/chats/turn-receipt',
  'GET /api/v1/chats/export',
  'GET /api/v1/chats/handoff-artifact',
  'POST /api/v1/chats/lookup-native-session',
  'POST /api/v1/chats/search',
  'GET /api/v1/chats/search/status',
  'POST /api/v1/chats/search/rebuild',
  'PUT /api/v1/app/settings',
  'POST /api/v1/chats/start',
  'POST /api/v1/chats/run',
  'POST /api/v1/chats/fork',
  'POST /api/v1/chats/fork-run',
  'POST /api/v1/chats/steer',
  'POST /api/v1/chats/stop',
  'POST /api/v1/chats/permissions/decision',
  'GET /api/v1/chats/rows',
  'POST /api/v1/chats/rows',
  'PUT /api/v1/app/session-name',
  'PUT /api/v1/chats/pin',
  'PUT /api/v1/chats/archive',
  'GET /api/v1/chats/tags',
  'PUT /api/v1/chats/tags',
  'GET /api/v1/tickets/bootstrap',
  'GET /api/v1/tickets',
  'GET /api/v1/tickets/detail',
  'GET /api/v1/tickets/history',
  'POST /api/v1/tickets/project-default',
  'POST /api/v1/tickets/mutate',
] as const satisfies readonly CliOperation[];

export const CLI_GATEWAY_REGISTRATIONS = Object.freeze(CLI_GATEWAY_V1.map(operation => Object.freeze({
  ...cliWireV1(operation), side: 'forwarder' as const, dispatch: forwardCliV1,
})));
