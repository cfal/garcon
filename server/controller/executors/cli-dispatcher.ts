import type { CliContext } from '../../../common/server-runtime.js';
import type { JsonValue } from '../../../common/json.js';
import { DomainError } from '../../common/domain-error.js';
import { readTextStreamWithLimit } from '../../common/bounded-text-stream.js';
import { invokeRawRouteHandler, unhandledRouteErrorResponse } from '../lib/http-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { ExecutorRpc, GuardRpcReply } from '../../remote/transport/rpc.js';
import { CliAdmission } from '../../remote/transport/cli-admission.js';
import { CLI_ENVELOPE_BYTES, CLI_REPLY_BYTES, CLI_SMALL_REPLY_BYTES, cliPolicy, parseControllerCliRequest, type CliHttpResponse } from '../../remote/transport/cli-protocol.js';

export interface CliDispatchAccess {
  readonly executorId: string;
  readonly rpc: ExecutorRpc;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

export class ControllerCliDispatcher {
  readonly #admission = new CliAdmission();

  constructor(private readonly options: {
    readonly routes: RouteMap;
    readonly serverInstanceId: string;
    readonly workspaceName: string | null;
    readonly isShuttingDown: () => boolean;
  }) {}

  describe(access: CliDispatchAccess, guardReply: GuardRpcReply): CliContext {
    this.#assertAdmission(access);
    guardReply(() => this.#assertAdmission(access));
    const release = this.#admission.acquire(access.executorId, 'short');
    try {
      return { serverInstanceId: this.options.serverInstanceId, defaultExecutorId: access.executorId, workspaceName: this.options.workspaceName };
    } finally { release(); }
  }

  async request(value: unknown, access: CliDispatchAccess, guardReply: GuardRpcReply): Promise<CliHttpResponse> {
    this.#assertAdmission(access);
    const request = parseControllerCliRequest(value);
    if (request.expectedServerInstanceId !== this.options.serverInstanceId) {
      throw new DomainError('CLI_CONTROLLER_CHANGED', 'Garcon restarted; start a new CLI invocation', 409);
    }
    const policy = cliPolicy(request.http);
    const release = this.#admission.acquire(access.executorId, policy.pool);
    const signal = policy.timeoutMs === null ? access.signal : AbortSignal.any([access.signal, AbortSignal.timeout(policy.timeoutMs)]);
    const interrupted = () => policy.mutation
      ? new DomainError('CLI_OUTCOME_UNKNOWN', 'The CLI operation may have reached Garcon; its outcome is unknown', 503)
      : new DomainError('CLI_CONTROLLER_UNAVAILABLE', 'The controller CLI request was interrupted', 503, true);
    const oversized = () => policy.mutation ? interrupted()
      : new DomainError('CLI_RESULT_TOO_LARGE', 'CLI result exceeds 8 MiB; narrow the requested result', 413);
    const assertPublication = () => {
      if (signal.aborted) throw interrupted();
      try { this.#assertAdmission(access); }
      catch (error) { throw policy.mutation ? interrupted() : error; }
    };
    guardReply((bytes) => {
      assertPublication();
      if (bytes <= CLI_SMALL_REPLY_BYTES || access.rpc.transport.channel.queuedBytes + bytes <= CLI_REPLY_BYTES) return;
      if (policy.mutation) throw interrupted();
      throw new DomainError('CLI_SERVICE_BUSY', 'Executor channel is busy; retry the read later', 503, true);
    });
    const cancelled = Promise.withResolvers<never>();
    const onAbort = () => cancelled.reject(interrupted());
    signal.addEventListener('abort', onAbort, { once: true });
    const work = (async (): Promise<CliHttpResponse> => {
      const [method, pathname] = request.http.operation.split(' ') as [string, string];
      const handler = this.options.routes[pathname]?.[method];
      if (!handler) throw new DomainError('CLI_CONTROLLER_UNAVAILABLE', 'Controller CLI services are not initialized', 503, true);
      const url = new URL(pathname, 'http://controller.invalid');
      for (const [key, value] of request.http.query) url.searchParams.append(key, value);
      const body = request.http.body === null ? undefined : JSON.stringify(request.http.body);
      const req = new Request(url, { method, signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body });
      let response: Response;
      try {
        response = await invokeRawRouteHandler(handler, req, undefined, { principal: {
          mode: 'executor', key: access.executorId, executorId: access.executorId, expiresAtMs: null,
        } });
      } catch (error) { response = unhandledRouteErrorResponse(error); }
      try { assertPublication(); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
      let bodyValue: JsonValue;
      try {
        bodyValue = JSON.parse(await readTextStreamWithLimit(response.body, CLI_REPLY_BYTES - CLI_ENVELOPE_BYTES, oversized)) as JsonValue;
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        if (error instanceof DomainError && error.code === 'CLI_RESULT_TOO_LARGE') throw error;
        throw interrupted();
      }
      assertPublication();
      const retryAfter = response.headers.get('Retry-After');
      const reply: CliHttpResponse = { status: response.status, body: bodyValue,
        ...(retryAfter && /^\d{1,5}$/.test(retryAfter) ? { retryAfter } : {}) };
      const bytes = Buffer.byteLength(JSON.stringify(reply)) + CLI_ENVELOPE_BYTES;
      if (bytes > CLI_REPLY_BYTES) throw oversized();
      return reply;
    })().finally(release);
    // Reservations follow actual handler settlement, not the lifetime of its cancelled waiter or RPC.
    try { return await Promise.race([work, cancelled.promise]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  #assertAdmission(access: CliDispatchAccess): void {
    access.assertCurrent();
    if (this.options.isShuttingDown()) throw new DomainError('SERVER_SHUTTING_DOWN', 'The server is shutting down', 503, true);
    if (access.signal.aborted) throw new DomainError('CLI_CONTROLLER_UNAVAILABLE', 'Controller CLI request cancelled before dispatch', 503, true);
  }
}
