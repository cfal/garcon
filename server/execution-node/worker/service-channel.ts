import { NODE_WIRE_VERSION, producerStreamKey } from '@garcon/server-agent-interface';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { NodeWorkerTransportError } from './framing.js';
import { NODE_WORKER_SERVICE_LIMITS } from './limits.js';
import { NodeProviderCapacity, type NodeProviderRequestClass } from '../provider-capacity.js';
import {
  parseNodeWorkerServiceText, serializeNodeWorkerService, type NodeWorkerServiceCommand, type NodeWorkerServiceFrame, type NodeWorkerServiceResult,
} from './service-protocol.js';
import type { NodeFrameSubmission, NodeFrameWriter } from './writer.js';
import type { NodeReplyAuthority, NodeReplyPort } from '../../execution-nodes/transport/reply-port.js';
import { isNodeRequestTimeout, NodeDeadline } from '../../execution-nodes/deadline.js';
import type { LeaseClock } from '../lease-clock.js';
import { DeferredNodeFrameText } from './frame-text.js';

export interface NodeWorkerServiceChannelOptions {
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly signal: AbortSignal;
  readonly maxRequests?: number;
  readonly maxProviderRequests?: number;
  readonly requestTimeoutMs?: number;
  readonly providerRequestTimeoutMs?: number;
  readonly createClock?: () => LeaseClock;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  validate(): void;
  failed(error: unknown): void;
}

interface PendingService {
  readonly deadline: NodeDeadline;
  readonly cancel: () => void;
  readonly releaseProvider: (() => void) | null;
  readonly completion: PromiseWithResolvers<NodeWorkerServiceResult>;
  readonly cancellation: AbortController;
  readonly accepts: (result: NodeWorkerServiceResult) => boolean;
  readonly detach: () => void;
  timer: { cancel(): void } | null;
  submission: NodeFrameSubmission | null;
  submitted: boolean;
  submitting: boolean;
  cancelled: boolean;
}

/** Identifies a received reply that violates its captured request's result contract. */
export class NodeWorkerServiceReplyError extends NodeWorkerTransportError {
  constructor(readonly requestId: number) {
    super('NODE_WORKER_PROTOCOL');
    this.name = 'NodeWorkerServiceReplyError';
  }
}

/** Correlates physical service requests without replaying effects when a reply or caller disappears. */
export class NodeWorkerServiceClient {
  readonly #options: ReturnType<typeof configuration>;
  readonly #providerCapacity: NodeProviderCapacity;
  readonly #pending = new Map<number, PendingService>();
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  #sent = 0;

  constructor(private readonly writer: NodeFrameWriter, private readonly options: NodeWorkerServiceChannelOptions) {
    this.#options = configuration(options);
    this.#providerCapacity = new NodeProviderCapacity(this.#options.maxProviderRequests);
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  async call(command: NodeWorkerServiceCommand, signal: AbortSignal, inheritedDeadline?: NodeDeadline): Promise<NodeWorkerServiceResult> {
    signal.throwIfAborted();
    if (inheritedDeadline?.remainingMs === 0) return { kind: 'unknown' };
    if (!this.#validate()) return unavailable();
    if (this.#pending.size >= this.#options.maxRequests) return { kind: 'rejected', code: 'NODE_CAPACITY' };
    if (this.#sent === Number.MAX_SAFE_INTEGER) { this.#fail(protocol()); return unavailable(); }
    const requestId = ++this.#sent;
    let text: string;
    let accepts: PendingService['accepts'];
    let providerRequest: NodeProviderRequestClass | null;
    let usesApplicationReserve: boolean;
    let deadline: NodeDeadline;
    try {
      deadline = inheritedDeadline ?? new NodeDeadline(requestTimeout(command, this.#options), this.options.createClock?.());
      const timeoutMs = deadline.remainingMs;
      if (timeoutMs === 0) return { kind: 'unknown' };
      text = serializeNodeWorkerService({ ...this.#envelope(requestId), type: 'node-worker-service-request', timeoutMs, command });
      const snapshot = parseNodeWorkerServiceText(text);
      if (snapshot?.type !== 'node-worker-service-request') throw protocol();
      accepts = expectedResult(snapshot.command);
      providerRequest = providerRequestClass(snapshot.command);
      usesApplicationReserve = providerRequest === 'status' || snapshot.command.method === 'retire-output';
    }
    catch { return { kind: 'rejected', code: 'VALIDATION_FAILED' }; }
    const releaseProvider = providerRequest ? this.#providerCapacity.reserve(providerRequest) : null;
    if (providerRequest && !releaseProvider) {
      return { kind: 'rejected', code: 'NODE_CAPACITY' };
    }
    const cancel = () => {
      if (!this.#pending.has(requestId)) return;
      pending.cancelled = true;
      pending.cancellation.abort(new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
      const submitted = pending.submitted || pending.submission?.submitted === true;
      this.#settle(requestId, submitted || pending.submitting ? { kind: 'unknown' } : unavailable());
      if (submitted) this.#cancel(requestId);
    };
    const pending: PendingService = { deadline, cancel, completion: Promise.withResolvers<NodeWorkerServiceResult>(), cancellation: new AbortController(),
      accepts, releaseProvider, detach: () => signal.removeEventListener('abort', cancel), timer: null,
      submission: null, submitted: false, submitting: false, cancelled: false };
    this.#pending.set(requestId, pending);
    signal.addEventListener('abort', cancel, { once: true });
    const authority = AbortSignal.any([this.#closing.signal, pending.cancellation.signal]);
    try {
      pending.timer = (this.options.scheduleTimeout ?? scheduleTimeout)(cancel, deadline.remainingMs);
      signal.throwIfAborted();
      if (deadline.remainingMs === 0) cancel();
      if (!this.#pending.has(requestId)) return pending.completion.promise;
      pending.submitting = true;
      const source = new DeferredNodeFrameText(text, (captured) => {
        const timeoutMs = deadline.remainingMs;
        if (timeoutMs === 0) cancel();
        authority.throwIfAborted();
        const frame = parseNodeWorkerServiceText(captured);
        if (frame?.type !== 'node-worker-service-request') throw protocol();
        return serializeNodeWorkerService({ ...frame, timeoutMs });
      });
      const submission = this.writer.submit(source, 'data', { signal: authority, validate: () => {
        if (deadline.remainingMs === 0) cancel();
        authority.throwIfAborted();
        if (!this.#validate()) throw protocol();
      } },
        usesApplicationReserve ? 'application' : 'data');
      pending.submission = submission; pending.submitting = false;
      if (pending.cancelled && submission.submitted) this.#cancel(requestId);
      const release = () => {
        pending.submitted = submission.submitted; pending.submission = null;
      };
      if (submission.drained) void submission.drained.catch((error) => { if (!authority.aborted) this.#fail(error); }).finally(release);
      else release();
    } catch (error) {
      pending.submitting = false;
      this.#settle(requestId, error instanceof NodeWorkerTransportError && error.code === 'NODE_WORKER_CAPACITY'
        ? { kind: 'rejected', code: 'NODE_CAPACITY' } : unavailable());
      if (!authority.aborted && !(error instanceof NodeWorkerTransportError && error.code === 'NODE_WORKER_CAPACITY')) this.#fail(error);
    }
    return pending.completion.promise;
  }

  receive(frame: NodeWorkerServiceFrame): void {
    if (!this.#validate()) return;
    if (!matches(frame, this.#options) || frame.type !== 'node-worker-service-result' || frame.requestId > this.#sent) { this.#fail(protocol()); return; }
    const pending = this.#pending.get(frame.requestId);
    if (!pending) return;
    if (pending.deadline.remainingMs === 0) { pending.cancel(); return; }
    if (!pending.accepts(frame.result)) {
      const error = new NodeWorkerServiceReplyError(frame.requestId);
      this.#take(frame.requestId)?.completion.reject(error);
      this.#fail(error);
      return;
    }
    this.#settle(frame.requestId, frame.result);
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#detach(); this.#closing.abort(protocol());
    for (const [id, pending] of this.#pending) this.#settle(id, pending.submitting || pending.submitted || pending.submission?.submitted ? { kind: 'unknown' } : unavailable());
  }

  #envelope(requestId: number) { return { version: NODE_WIRE_VERSION, session: this.#options.session, connectionId: this.#options.connectionId, requestId } as const; }

  #settle(requestId: number, result: NodeWorkerServiceResult): void {
    this.#take(requestId)?.completion.resolve(result);
  }

  #take(requestId: number): PendingService | undefined {
    const pending = this.#pending.get(requestId);
    if (pending) { this.#pending.delete(requestId); pending.releaseProvider?.(); pending.detach(); pending.timer?.cancel(); }
    return pending;
  }

  #cancel(requestId: number): void {
    if (!this.#validate()) return;
    try {
      const text = serializeNodeWorkerService({ ...this.#envelope(requestId), type: 'node-worker-service-cancel' });
      const submitted = this.writer.submit(text, 'urgent', { signal: this.#closing.signal, validate: () => { if (!this.#validate()) throw protocol(); } }, 'application');
      void submitted.drained?.catch((error) => { if (!this.#closing.signal.aborted) this.#fail(error); });
    } catch (error) {
      if (!(error instanceof NodeWorkerTransportError && error.code === 'NODE_WORKER_CAPACITY')) this.#fail(error);
    }
  }

  #validate(): boolean {
    if (this.#closing.signal.aborted) return false;
    try { this.options.signal.throwIfAborted(); this.options.validate(); this.options.signal.throwIfAborted(); }
    catch (error) { this.#fail(error); }
    return !this.#closing.signal.aborted;
  }

  #fail(error: unknown): void {
    if (this.#closing.signal.aborted) return;
    this.close();
    try { this.options.failed(error); } catch { /* A failed physical channel remains closed. */ }
  }
}

/** Keeps cancelled handler slots until settlement and never silently discards a completed mutation's reply. */
export class NodeWorkerServiceServer {
  readonly #options: ReturnType<typeof configuration>;
  readonly #providerCapacity: NodeProviderCapacity;
  readonly #pending = new Map<number, { readonly cancellation: AbortController; readonly releaseProvider: (() => void) | null }>();
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  readonly #replyAuthority: NodeReplyAuthority;
  #received = 0;

  constructor(private readonly replies: NodeReplyPort,
    private readonly execute: (command: NodeWorkerServiceCommand, signal: AbortSignal, deadline: NodeDeadline) => Promise<NodeWorkerServiceResult>,
    private readonly options: NodeWorkerServiceChannelOptions) {
    this.#options = configuration(options);
    this.#replyAuthority = { signal: this.#closing.signal, validate: () => { if (!this.#validate()) throw protocol(); }, failed: (error) => this.#fail(error) };
    this.#providerCapacity = new NodeProviderCapacity(this.#options.maxProviderRequests);
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  receive(frame: NodeWorkerServiceFrame): void {
    if (!this.#validate()) return;
    if (!matches(frame, this.#options) || frame.type === 'node-worker-service-result') { this.#fail(protocol()); return; }
    if (frame.type === 'node-worker-service-cancel') {
      if (frame.requestId > this.#received) this.#fail(protocol());
      else {
        this.#pending.get(frame.requestId)?.cancellation.abort(protocol());
        this.replies.cancel(frame.requestId);
      }
      return;
    }
    if (frame.requestId <= this.#received) { this.#fail(protocol()); return; }
    this.#received = frame.requestId;
    if (this.#pending.size >= this.#options.maxRequests) { this.#reply(frame.requestId, { kind: 'rejected', code: 'NODE_CAPACITY' }); return; }
    const providerRequest = providerRequestClass(frame.command);
    const releaseProvider = providerRequest ? this.#providerCapacity.reserve(providerRequest) : null;
    if (providerRequest && !releaseProvider) {
      this.#reply(frame.requestId, { kind: 'rejected', code: 'NODE_CAPACITY' }); return;
    }
    const cancellation = new AbortController();
    this.#pending.set(frame.requestId, { cancellation, releaseProvider });
    void this.#execute(frame, cancellation);
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#detach(); this.#closing.abort(protocol());
    this.replies.close();
  }

  async #execute(frame: Extract<NodeWorkerServiceFrame, { type: 'node-worker-service-request' }>, cancellation: AbortController): Promise<void> {
    const deadline = NodeDeadline.receive(frame.timeoutMs, this.options.createClock?.());
    const signal = AbortSignal.any([cancellation.signal, this.#closing.signal]);
    let completed = false;
    const expire = () => {
      if (completed || signal.aborted) return;
      this.#reply(frame.requestId, { kind: 'unknown' });
      cancellation.abort(new DOMException('Node service request timed out', 'TimeoutError'));
    };
    const timer = (this.options.scheduleTimeout ?? scheduleTimeout)(expire, deadline.remainingMs);
    try {
      let result: NodeWorkerServiceResult;
      try {
        if (deadline.remainingMs === 0) expire();
        signal.throwIfAborted();
        result = await this.execute(frame.command, signal, deadline);
      }
      catch { result = { kind: 'unknown' }; }
      if (deadline.remainingMs === 0) expire();
      if (!signal.aborted) this.#reply(frame.requestId, result, signal);
    } finally {
      completed = true;
      timer.cancel();
      this.#pending.get(frame.requestId)?.releaseProvider?.();
      this.#pending.delete(frame.requestId);
    }
  }

  #reply(requestId: number, result: NodeWorkerServiceResult, signal = this.#closing.signal): void {
    if (!this.#validate()) return;
    const envelope = { type: 'node-worker-service-result', version: NODE_WIRE_VERSION,
      session: this.#options.session, connectionId: this.#options.connectionId, requestId } as const;
    try {
      let text: string;
      try { text = serializeNodeWorkerService({ ...envelope, result }); }
      catch { text = serializeNodeWorkerService({ ...envelope, result: { kind: 'unknown' } }); }
      this.replies.enqueue(requestId, text, { ...this.#replyAuthority, signal });
    } catch (error) { if (!signal.aborted) this.#fail(error); }
  }

  #validate(): boolean {
    if (this.#closing.signal.aborted) return false;
    try { this.options.signal.throwIfAborted(); this.options.validate(); this.options.signal.throwIfAborted(); }
    catch (error) { this.#fail(error); }
    return !this.#closing.signal.aborted;
  }

  #fail(error: unknown): void {
    if (this.#closing.signal.aborted) return;
    this.close();
    try { this.options.failed(error); } catch { /* A failed physical channel remains closed. */ }
  }
}

function configuration(options: NodeWorkerServiceChannelOptions) {
  const session = parseNodeSessionIdentity(options.session);
  const maxRequests = options.maxRequests ?? NODE_WORKER_SERVICE_LIMITS.maxRequests;
  const maxProviderRequests = options.maxProviderRequests ?? Math.min(maxRequests, NODE_WORKER_SERVICE_LIMITS.maxProviderRequests);
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const providerRequestTimeoutMs = options.providerRequestTimeoutMs ?? NODE_WORKER_SERVICE_LIMITS.providerRequestTimeoutMs;
  if (!session || maxProviderRequests > maxRequests || !isNodeRequestTimeout(requestTimeoutMs) || !isNodeRequestTimeout(providerRequestTimeoutMs)
    || ![options.connectionId, maxRequests, maxProviderRequests, requestTimeoutMs, providerRequestTimeoutMs].every((n) => Number.isSafeInteger(n) && n > 0)) throw protocol();
  return Object.freeze({ session: Object.freeze(session), connectionId: options.connectionId, maxRequests, maxProviderRequests, requestTimeoutMs, providerRequestTimeoutMs });
}

function requestTimeout(command: NodeWorkerServiceCommand, options: ReturnType<typeof configuration>): number {
  if (command.method === 'provider-single-query' || command.method === 'provider-text-generation') return command.request.timeoutMs;
  return providerRequestClass(command) ? options.providerRequestTimeoutMs : options.requestTimeoutMs;
}

function providerRequestClass(command: NodeWorkerServiceCommand): NodeProviderRequestClass | null {
  switch (command.method) {
    case 'provider-session-configuration': return command.operation === 'prepare' || command.operation === 'commit' ? 'work' : 'status';
    case 'provider-auth': return command.operation === 'status' || command.operation === 'login-status' ? 'status' : 'work';
    case 'provider-catalog': case 'provider-commands': case 'provider-configuration':
    case 'provider-single-query': case 'provider-text-generation': return 'work';
    default: return null;
  }
}

function matches(frame: NodeWorkerServiceFrame, options: ReturnType<typeof configuration>): boolean {
  return sameNodeSession(frame.session, options.session) && frame.connectionId === options.connectionId;
}

function expectedResult(command: NodeWorkerServiceCommand): (result: NodeWorkerServiceResult) => boolean {
  const { method } = command;
  const stream = command.method === 'install-output' || command.method === 'retire-output' ? producerStreamKey(command.stream) : null;
  const instanceId = 'instanceId' in command ? command.instanceId : null;
  const permission = command.method === 'permission' ? { ...command.command.permission, stream: { ...command.command.permission.stream } } : null;
  const cursors = command.method === 'replay-output' ? new Map(command.cursors.map((cursor) => [producerStreamKey(cursor.stream), cursor.afterSequence])) : null;
  return (result) => {
    if (result.kind === 'unknown' || result.kind === 'rejected') return true;
    switch (method) {
      case 'provider-session-configuration': {
        if (command.operation === 'prepare') return result.kind === 'provider-session-configuration-prepared' && result.instanceId === instanceId;
        return result.kind === 'provider-session-configuration-receipt' && result.instanceId === instanceId
          && sameNodeSession(result.identity, command.identity) && result.identity.operationId === command.identity.operationId;
      }
      case 'provider-single-query': case 'provider-text-generation':
        return (result.kind === 'provider-auxiliary-result' || result.kind === 'provider-auxiliary-too-large')
          && result.instanceId === instanceId && sameNodeSession(result.identity, command.identity)
          && result.identity.operationId === command.identity.operationId;
      case 'provider-configuration': return (result.kind === 'provider-configuration-prepared' || result.kind === 'provider-configuration-rejected'
        || result.kind === 'provider-configuration-too-large')
        && result.instanceId === instanceId;
      case 'provider-commands': return (result.kind === 'provider-commands' || result.kind === 'provider-commands-unavailable')
        && result.instanceId === instanceId && result.workspaceId === command.workspaceId;
      case 'provider-auth': {
        if (!('instanceId' in result) || result.instanceId !== instanceId) return false;
        if (result.kind === 'provider-auth-rejected') return true;
        switch (command.operation) {
          case 'status': return result.kind === 'provider-auth-status';
          case 'launch-login': return result.kind === 'provider-login-launched';
          case 'complete-login': return result.kind === 'provider-login-completed' && result.result.sessionId === command.sessionId;
          case 'login-status': return result.kind === 'provider-login-status';
        }
        return unexpectedAuthCommand(command);
      }
      case 'provider-catalog': return (result.kind === 'provider-catalog' || result.kind === 'provider-catalog-unavailable') && result.instanceId === instanceId;
      case 'install-output': return result.kind === 'output-installed' && result.instanceId === instanceId && producerStreamKey(result.stream) === stream;
      case 'retire-output': return result.kind === 'output-fenced' && result.instanceId === instanceId && producerStreamKey(result.stream) === stream;
      case 'reserve-body': return result.kind === 'body-reserved';
      case 'permission': {
        if (result.kind !== 'permission-result') return false;
        const reference = result.result.kind === 'permission' ? result.result.receipt?.permission : null;
        return !reference || reference.handle === permission!.handle && reference.runId === permission!.runId
          && reference.permissionOccurrenceId === permission!.permissionOccurrenceId && producerStreamKey(reference.stream) === producerStreamKey(permission!.stream);
      }
      case 'begin-output-recovery': return result.kind === 'output-recovery';
      case 'replay-output': return result.kind === 'output-replayed' && result.ranges.every((range) => {
        const after = cursors!.get(producerStreamKey(range.stream));
        return after !== undefined && (range.type === 'node-replay-ready' ? range.afterSequence === after : range.requestedAfter >= after);
      });
      case 'resume-output': return result.kind === 'output-live';
    }
  };
}

function unexpectedAuthCommand(_command: never): false { return false; }

function unavailable(): NodeWorkerServiceResult { return { kind: 'rejected', code: 'NODE_UNAVAILABLE' }; }
function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs); timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
