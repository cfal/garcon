import crypto from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { AgentCallError } from '@garcon/server-agent-interface';
import { CLI_SERVER_INSTANCE_HEADER, parseCliContext, type CliGatewayDescriptor } from '../../common/server-runtime.js';
import type { JsonValue } from '../../common/json.js';
import { DomainError } from '../lib/domain-error.js';
import { getTokenFromRequest } from '../lib/http-request.js';
import { jsonError } from '../lib/http-error.js';
import { createServerRuntimeState } from '../lib/server-runtime.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { createRuntimeRoutes } from '../routes/runtime.js';
import { CliAdmission } from './cli-admission.js';
import { CLI_REQUEST_BYTES, cliOperation, cliPolicy, parseCliHttpResponse, parseControllerCliRequest } from './cli-protocol.js';
import type { AgentRpc } from './rpc.js';

function gatewayError(error: unknown): Response {
  if (error instanceof DomainError) {
    const response = jsonError(error.message, error.status, error.code, error.retryable);
    if (error.code === 'CLI_SERVICE_BUSY') response.headers.set('Retry-After', '1');
    return response;
  }
  if (error instanceof AgentCallError && error.outcome === 'not-dispatched') {
    return jsonError('The execution-node controller is unavailable', 503, 'CLI_CONTROLLER_UNAVAILABLE', true);
  }
  return jsonError('The CLI request may have reached Garcon; its outcome could not be confirmed', 503, 'CLI_OUTCOME_UNKNOWN', false);
}

async function readBody(request: IncomingMessage): Promise<JsonValue | null> {
  if (Number(request.headers['content-length']) > CLI_REQUEST_BYTES) {
    throw new DomainError('CLI_REQUEST_TOO_LARGE', 'CLI request exceeds 1 MiB', 413);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const error = (reason: Error) => { cleanup(); reject(reason); };
    const aborted = () => error(new DomainError('CLI_CONTROLLER_UNAVAILABLE', 'CLI upload aborted before dispatch', 503, true));
    const end = () => { cleanup(); resolve(); };
    const data = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > CLI_REQUEST_BYTES) {
        request.pause();
        error(new DomainError('CLI_REQUEST_TOO_LARGE', 'CLI request exceeds 1 MiB', 413));
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
  readonly workspaceDir: string;
  readonly runtimeId: string;
  readonly currentRpc: () => AgentRpc | null;
}): Promise<{ readonly runtimeFile: string; readonly descriptor: CliGatewayDescriptor; dispose(): Promise<void> }> {
  const runtime = createServerRuntimeState(options.workspaceDir);
  const proof = createRuntimeRoutes(runtime)['/api/v1/runtime']!.GET!;
  const admission = new CliAdmission();
  let stopped = false;
  let responses = 0;
  const server = createServer({ maxHeaderSize: 32 * 1024, requestTimeout: 30_000, headersTimeout: 10_000 }, (incoming, outgoing) => {
    const abort = new AbortController();
    responses++;
    outgoing.once('close', () => { responses--; abort.abort(); });
    outgoing.on('error', () => abort.abort());
    const timeout = (ms: number) => outgoing.setTimeout(ms, () => outgoing.destroy());
    timeout(30_000);
    const dispatch = async () => {
      let response: Response;
      try {
        if (responses > 16) throw new DomainError('CLI_SERVICE_BUSY', 'CLI HTTP response budget exhausted', 503, true);
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
          response = await proof(request, url);
        } else {
          const token = Buffer.from(getTokenFromRequest(request) ?? '');
          const capability = Buffer.from(runtime.localCapability);
          if (token.length !== capability.length || !crypto.timingSafeEqual(token, capability) || request.headers.has('Origin')) {
            throw new DomainError('CLI_ACCESS_DENIED', 'A local CLI gateway capability is required', 403);
          }
          const rpc = stopped ? null : options.currentRpc();
          if (!rpc || !rpc.transport.connected) throw new AgentCallError('not-dispatched', 'Controller is disconnected');
          const expectedServerInstanceId = request.headers.get(CLI_SERVER_INSTANCE_HEADER);
          if (request.method === 'GET' && url.pathname === '/api/v1/cli/context') {
            const release = admission.acquire('gateway', 'short');
            try {
              const context = parseCliContext(await rpc.call('', 'controllerCli.describe', null, { signal: request.signal, timeoutMs: 5_000 }));
              if (context.defaultNodeId !== rpc.transport.nodeId) throw new Error('CLI context does not match the authenticated node');
              if (expectedServerInstanceId !== null && context.serverInstanceId !== expectedServerInstanceId) {
                throw new DomainError('CLI_CONTROLLER_CHANGED', 'Garcon restarted; start a new CLI invocation', 409);
              }
              response = Response.json(context);
            } finally { release(); }
          } else {
            const operation = cliOperation(request.method, url.pathname);
            if (expectedServerInstanceId === null) throw new DomainError('VALIDATION_FAILED', 'Expected controller instance is required', 400);
            const body = await readBody(incoming);
            const call = parseControllerCliRequest({ expectedServerInstanceId, http: { operation, query: [...url.searchParams], body } });
            const policy = cliPolicy(call.http);
            const release = admission.acquire('gateway', policy.pool);
            // Native HTTP idle timeouts do not bound maintenance work; restore the drain deadline before replying.
            timeout(0);
            try {
              const result = parseCliHttpResponse(await rpc.call('', 'controllerCli.request', call, {
                signal: request.signal, timeoutMs: policy.timeoutMs,
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
  const runDir = join(options.workspaceDir, 'run');
  const runtimeFile = join(runDir, `cli-${options.runtimeId}.json`);
  const { workspaceDir: _workspaceDir, ...identity } = runtime.identity;
  const descriptor: CliGatewayDescriptor = { ...identity, kind: 'execution-node-cli', pid: process.pid,
    baseUrl: `http://127.0.0.1:${address.port}`, localCapability: runtime.localCapability };
  let publishing = false;
  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const metadata = await lstat(runDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || process.platform !== 'win32' && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.())) {
      throw new Error('CLI runtime directory must be private to the worker OS account');
    }
    publishing = true;
    await writeJsonFileAtomic(runtimeFile, descriptor, { mode: 0o600 });
  } catch (error) {
    await stop();
    if (publishing) await rm(runtimeFile, { force: true }).catch(() => {});
    throw error;
  }
  return { runtimeFile, descriptor, async dispose() {
    if (stopped) return;
    stopped = true;
    await stop();
    await rm(runtimeFile, { force: true });
  } };
}
