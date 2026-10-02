import crypto from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { cliGatewayRuntimeFile } from '../../../common/cli-runtime-paths.js';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { AgentCallError } from '@garcon/server-agent-interface';
import { CLI_SERVER_INSTANCE_HEADER, parseCliContext, type CliGatewayDescriptor } from '../../../common/server-runtime.js';
import type { JsonValue } from '../../../common/json.js';
import { DomainError } from '../../common/domain-error.js';
import { getTokenFromRequest } from '../../common/http-body.js';
import { jsonError } from '../../common/http-error.js';
import { createServerRuntimeState, publishRuntimeDescriptor, removeServerRuntime } from '../../common/server-runtime.js';
import { runtimeProofResponse } from '../../common/runtime-proof.js';
import { CliAdmission } from '../transport/cli-admission.js';
import { CLI_OPERATIONS, cliRequestBytes, cliRequestTooLarge, cliRoute, cliPolicy, parseCliHttpResponse, parseControllerCliRequest } from '../transport/cli-protocol.js';
import type { ExecutorRpcConnection } from '../transport/rpc-connection.js';
import type { RpcLane } from '../transport/rpc-lane.js';

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
              const context = parseCliContext(await rpc.call('', 'controllerCli.describe', null, { signal: request.signal, timeoutMs: 5_000 }));
              if (context.defaultExecutorId !== rpc.transport.executorId) throw new Error('CLI context does not match the authenticated executor');
              if (expectedServerInstanceId !== null && context.serverInstanceId !== expectedServerInstanceId) {
                throw new DomainError('CLI_CONTROLLER_CHANGED', 'Garcon restarted; start a new CLI invocation', 409);
              }
              response = Response.json(context);
            } finally { release(); }
          } else {
            const route = cliRoute(request.method, url.pathname);
            const lane = CLI_OPERATIONS[route.operation].lane;
            reserveHttp(lane);
            if (expectedServerInstanceId === null) throw new DomainError('VALIDATION_FAILED', 'Expected controller instance is required', 400);
            const contentLength = incoming.headers['content-length'];
            const hasBody = incoming.headers['transfer-encoding'] !== undefined
              || contentLength !== undefined && contentLength !== '0';
            const body = hasBody ? await readBody(incoming, lane) : null;
            const call = parseControllerCliRequest({ expectedServerInstanceId, http: { ...route, query: [...url.searchParams], body } });
            const policy = cliPolicy(call.http);
            const release = admission.acquire('gateway', policy.pool, lane);
            // Native HTTP idle timeouts do not bound maintenance work; restore the drain deadline before replying.
            timeout(0);
            try {
              const held = await connection!.acquire(lane, { signal: request.signal, timeoutMs: policy.timeoutMs });
              const result = parseCliHttpResponse(await held.rpc.call('', 'controllerCli.request', call, {
                signal: request.signal, timeoutMs: held.timeoutMs,
              }));
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
