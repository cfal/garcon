import { createHash } from 'node:crypto';
import { producerStreamKey, type AgentPermissionResponseCapability, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import { stableJsonStringify } from '../../common/json.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../common/node-operation.js';
import { NodeWorkerServiceReplyError, type NodeWorkerServiceClient } from '../execution-node/worker/service-channel.js';
import type { NodeWorkerServiceResult } from '../execution-node/worker/service-protocol.js';
import { DomainError } from '../lib/domain-error.js';
import { parseNodePermissionDecision, parseNodePermissionReference, type NodePermissionReceipt, type NodePermissionReference,
  type NodePermissionResult } from './transport/permission-wire.js';

export interface NodePermissionConnection {
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly signal: AbortSignal;
  readonly service: Pick<NodeWorkerServiceClient, 'call'>;
  validate(): void;
}

export interface NodePermissionReconciliationOptions {
  readonly session: NodeSessionIdentity;
  readonly signal: AbortSignal;
  readonly maxIdentities?: number;
  readonly maxResponses?: number;
  readonly responseTimeoutMs?: number;
  readonly now?: () => number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  validate(): void;
  assertAdmission(): void;
}

interface ResponseWaiter {
  readonly completion: PromiseWithResolvers<void>;
  readonly startedAt: number;
  readonly cancellation: AbortController;
  timer: { cancel(): void } | null;
  polling: PhysicalConnection | null;
}

interface PermissionOwner {
  readonly permission: NodePermissionReference;
  readonly signal: AbortSignal;
  readonly isRunLive: () => boolean;
  readonly detach: () => void;
  readonly cancellation: AbortController;
  phase: NodePermissionReceipt['phase'] | null;
  fingerprint: string | null;
  response: ResponseWaiter | null;
  readVersion: number;
}

interface PhysicalConnection {
  readonly connection: NodePermissionConnection;
  readonly detach: () => void;
  reconciled: boolean;
}

/** Reconciles exact native receipts while keeping unknown decisions out of the mutation path. */
export class NodePermissionReconciliation {
  readonly #session: NodeSessionIdentity;
  readonly #owners = new Map<string, PermissionOwner | null>();
  readonly #occurrences = new Set<string>();
  readonly #responses = new Set<PermissionOwner>();
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  readonly #maxIdentities: number;
  readonly #maxResponses: number;
  readonly #responseTimeoutMs: number;
  #physical: PhysicalConnection | null = null;
  #lastConnectionId = 0;
  #timer: { cancel(): void } | null = null;

  constructor(private readonly options: NodePermissionReconciliationOptions) {
    const session = parseNodeSessionIdentity(options.session);
    this.#maxIdentities = options.maxIdentities ?? 16_384;
    this.#maxResponses = options.maxResponses ?? 8;
    this.#responseTimeoutMs = options.responseTimeoutMs ?? 30_000;
    if (!session || ![this.#maxIdentities, this.#maxResponses, this.#responseTimeoutMs].every((n) => Number.isSafeInteger(n) && n > 0)
      || this.#maxIdentities > 65_536 || this.#maxResponses > 8 || this.#responseTimeoutMs > 30_000) throw invalid();
    this.#session = Object.freeze(session);
    this.options = Object.freeze({ ...options });
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  capture(value: NodePermissionReference, signal: AbortSignal, isRunLive: () => boolean): AgentPermissionResponseCapability {
    this.#validate();
    const permission = parseNodePermissionReference(value);
    if (!permission || !sameNodeSession(permission.stream, this.#session)) throw invalid();
    if (this.#owners.has(permission.handle) || this.#occurrences.has(permission.permissionOccurrenceId)) throw new TypeError('Permission occurrence cannot be rebound');
    if (this.#owners.size >= this.#maxIdentities) throw capacity();
    const retire = () => this.#retire(owner);
    const owner: PermissionOwner = { permission, signal, isRunLive, cancellation: new AbortController(),
      detach: () => signal.removeEventListener('abort', retire), phase: null, fingerprint: null, response: null, readVersion: 0 };
    this.#owners.set(permission.handle, owner); this.#occurrences.add(permission.permissionOccurrenceId);
    signal.addEventListener('abort', retire, { once: true });
    if (!this.#live(owner)) this.#retire(owner);
    return Object.freeze({ permissionOccurrenceId: permission.permissionOccurrenceId, respond: (decision: PermissionDecisionPayload) => this.#respond(owner, decision) });
  }

  attach(connection: NodePermissionConnection): void {
    this.#validate();
    const previous = this.#physical; const previousId = this.#lastConnectionId;
    if (!sameNodeSession(connection.session, this.#session) || !Number.isSafeInteger(connection.connectionId)
      || connection.connectionId <= previousId) throw invalid();
    connection.signal.throwIfAborted(); connection.validate(); this.#validate();
    if (this.#physical !== previous || this.#lastConnectionId !== previousId) throw unavailable();
    const { service, validate } = connection;
    const call = service.call;
    const physical: PhysicalConnection = { reconciled: false, connection: Object.freeze({
      session: this.#session, connectionId: connection.connectionId, signal: connection.signal,
      service: Object.freeze({ call: (...args: Parameters<NodeWorkerServiceClient['call']>) => Reflect.apply(call, service, args) }),
      validate: () => Reflect.apply(validate, connection, []),
    }), detach: () => connection.signal.removeEventListener('abort', disconnect) };
    const disconnect = () => { if (this.#physical === physical) { this.#cancelPoll(); physical.detach(); this.#physical = null; } };
    this.#cancelPoll(); previous?.detach(); this.#physical = physical; this.#lastConnectionId = connection.connectionId;
    connection.signal.addEventListener('abort', disconnect, { once: true });
    if (connection.signal.aborted) disconnect();
  }

  async reconcile(connectionId: number, signal: AbortSignal): Promise<void> {
    this.#validate(); signal.throwIfAborted();
    const physical = this.#physical;
    if (!physical || physical.connection.connectionId !== connectionId) throw unavailable();
    physical.reconciled = false; this.#cancelPoll();
    for (const owner of this.#owners.values()) {
      this.#validatePhysical(physical); signal.throwIfAborted();
      if (!owner) continue;
      if (!this.#live(owner)) { this.#retire(owner); continue; }
      await this.#read(owner, physical, signal);
    }
    this.#validatePhysical(physical); signal.throwIfAborted();
    physical.reconciled = true; this.#schedulePoll();
  }

  retireRun(stream: ProducerStreamIdentity, runId: string): void {
    for (const owner of this.#owners.values()) if (owner && producerStreamKey(owner.permission.stream) === producerStreamKey(stream)
      && owner.permission.runId === runId) this.#retire(owner);
  }

  retireOccurrence(stream: ProducerStreamIdentity, runId: string, occurrenceId: string): void {
    for (const owner of this.#owners.values()) if (owner && producerStreamKey(owner.permission.stream) === producerStreamKey(stream)
      && owner.permission.runId === runId && owner.permission.permissionOccurrenceId === occurrenceId) this.#retire(owner);
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(new DomainError('NODE_UNAVAILABLE', 'Permission authority is closed', 409));
    this.#detach(); this.#cancelPoll(); this.#physical?.detach(); this.#physical = null;
    for (const owner of this.#owners.values()) if (owner) this.#retire(owner);
    this.#owners.clear(); this.#occurrences.clear();
  }

  async #respond(owner: PermissionOwner, value: PermissionDecisionPayload): Promise<void> {
    this.#validateOwner(owner); this.options.assertAdmission(); this.#validateOwner(owner);
    const physical = this.#physical;
    if (!physical || !physical.reconciled) throw unavailable();
    this.#validatePhysical(physical);
    const decision = parseNodePermissionDecision(value);
    if (!decision) throw new DomainError('VALIDATION_FAILED', 'Invalid permission decision');
    const fingerprint = createHash('sha256').update(stableJsonStringify(decision)).digest('hex');
    if (owner.fingerprint !== null && owner.fingerprint !== fingerprint) throw new DomainError('VALIDATION_FAILED', 'A different decision was already submitted');
    if (owner.response) return owner.response.completion.promise;
    if (owner.phase === 'expired' || owner.phase === 'unknown' || owner.phase === 'resolved' && owner.fingerprint === null) throw notActionable();
    if (owner.fingerprint !== null && owner.phase === 'resolved') return;
    if (this.#responses.size >= this.#maxResponses) throw capacity();
    const response: ResponseWaiter = {
      completion: Promise.withResolvers<void>(), startedAt: this.#now(), cancellation: new AbortController(), timer: null, polling: null,
    };
    owner.response = response; this.#responses.add(owner);
    void response.completion.promise.catch(() => {});
    response.timer = this.#schedule(() => this.#settle(owner, response, unknown()), this.#responseTimeoutMs);
    if (owner.fingerprint === null) {
      owner.fingerprint = fingerprint;
      void this.#submit(owner, response, physical, decision);
    } else this.#schedulePoll();
    return response.completion.promise;
  }

  async #submit(owner: PermissionOwner, response: ResponseWaiter, physical: PhysicalConnection, decision: PermissionDecisionPayload): Promise<void> {
    try {
      this.#validateOwner(owner); this.#validatePhysical(physical);
      if (!this.#currentResponse(owner, response)) return;
      const result = await physical.connection.service.call({ method: 'permission', command: { method: 'permission-respond', permission: owner.permission, decision } },
        AbortSignal.any([physical.connection.signal, owner.cancellation.signal, response.cancellation.signal]));
      this.#validatePhysical(physical); this.#validateOwner(owner);
      if (!this.#currentResponse(owner, response)) return;
      const reply = result.kind === 'permission-result' ? result.result : result;
      if (reply.kind === 'rejected') {
        owner.fingerprint = null;
        const code = reply.code === 'NODE_OUTPUT_RETIRED' ? 'PERMISSION_NOT_ACTIONABLE'
          : reply.code === 'NODE_STREAM_IDENTITIES_EXHAUSTED' ? 'NODE_CAPACITY' : reply.code;
        this.#settle(owner, response, new DomainError(code, 'Permission decision was refused', 409));
      } else if (reply.kind === 'permission') this.#apply(owner, reply);
    } catch { /* Receipt reads reconcile submission uncertainty without repeating the decision. */ }
    finally { this.#schedulePoll(); }
  }

  async #read(owner: PermissionOwner, physical: PhysicalConnection, signal: AbortSignal): Promise<void> {
    this.#validateOwner(owner); this.#validatePhysical(physical); signal.throwIfAborted();
    const version = ++owner.readVersion;
    let result: NodeWorkerServiceResult;
    try {
      result = await physical.connection.service.call({ method: 'permission', command: { method: 'permission-status', permission: owner.permission } },
        AbortSignal.any([signal, physical.connection.signal, owner.cancellation.signal]));
    } catch (error) {
      // Correlated protocol failures arrive after their physical channel has already closed.
      if (error instanceof NodeWorkerServiceReplyError && this.#lastConnectionId === physical.connection.connectionId) this.#retire(owner);
      throw error;
    }
    this.#validatePhysical(physical); signal.throwIfAborted();
    if (!this.#live(owner)) { this.#retire(owner); return; }
    if (owner.readVersion !== version) return;
    // Transport refusals and timeouts carry no evidence about the native occurrence's lifetime.
    if (result.kind === 'unknown' || result.kind === 'rejected') throw unavailable();
    if (result.kind !== 'permission-result') {
      this.#retire(owner);
      throw invalid();
    }
    if (result.result.kind !== 'permission') {
      if (result.result.kind === 'rejected'
        && (result.result.code === 'VALIDATION_FAILED' || result.result.code === 'NODE_SESSION_EXPIRED')) this.#retire(owner);
      throw unavailable();
    }
    this.#apply(owner, result.result);
  }

  #apply(owner: PermissionOwner, result: Extract<NodePermissionResult, { kind: 'permission' }>): void {
    const receipt = result.receipt;
    if (receipt && !samePermission(receipt.permission, owner.permission)) {
      this.#retire(owner);
      throw invalid();
    }
    if (owner.phase === 'resolved' || owner.phase === 'expired' || owner.phase === 'unknown'
      || owner.phase === 'pending' && receipt?.phase === 'available') return;
    owner.phase = receipt?.phase ?? 'unknown';
    const response = owner.response;
    if (owner.phase === 'available' && owner.fingerprint !== null) {
      owner.fingerprint = null;
      if (response && this.#currentResponse(owner, response)) this.#settle(owner, response, notDelivered());
      return;
    }
    if (response && this.#currentResponse(owner, response)) {
      if (owner.phase === 'resolved') this.#settle(owner, response);
      else if (owner.phase === 'expired') this.#settle(owner, response, notActionable());
      else if (owner.phase !== 'pending') this.#settle(owner, response, unknown());
    }
    if (owner.phase === 'expired' || owner.phase === 'unknown') this.#retire(owner);
  }

  #schedulePoll(): void {
    if (this.#timer || !this.#physical?.reconciled) return;
    const physical = this.#physical;
    if (![...this.#responses].some((owner) => owner.response && owner.response.polling !== physical)) return;
    this.#timer = this.#schedule(() => { this.#timer = null; this.#poll(physical); }, 250);
  }

  #poll(physical: PhysicalConnection): void {
    try {
      for (const owner of this.#responses) {
        this.#validatePhysical(physical);
        if (!physical.reconciled) return;
        if (!this.#live(owner)) { this.#retire(owner); continue; }
        const response = owner.response;
        if (!response || response.polling === physical) continue;
        response.polling = physical;
        void this.#read(owner, physical, response.cancellation.signal)
          .catch(() => { /* A failed receipt read cannot block an independent response. */ })
          .finally(() => {
            if (response.polling === physical) response.polling = null;
            this.#schedulePoll();
          });
      }
    } catch { /* A retired connection cannot admit more receipt reads. */ }
  }

  #cancelPoll(): void { this.#timer?.cancel(); this.#timer = null; }

  #currentResponse(owner: PermissionOwner, response: ResponseWaiter): boolean {
    if (owner.response !== response) return false;
    const elapsed = this.#now() - response.startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= this.#responseTimeoutMs) { this.#settle(owner, response, unknown()); return false; }
    return true;
  }

  #settle(owner: PermissionOwner, response: ResponseWaiter, error?: unknown): void {
    if (owner.response !== response) return;
    owner.response = null; this.#responses.delete(owner); response.timer?.cancel();
    if (error === undefined) response.completion.resolve(); else response.completion.reject(error);
    response.cancellation.abort(error ?? notActionable());
    if (!this.#responses.size) this.#cancelPoll();
  }

  #retire(owner: PermissionOwner): void {
    if (this.#owners.get(owner.permission.handle) !== owner) return;
    this.#owners.set(owner.permission.handle, null); owner.detach();
    if (owner.response) this.#settle(owner, owner.response, notActionable());
    owner.cancellation.abort(notActionable());
  }

  #live(owner: PermissionOwner): boolean {
    try { return this.#owners.get(owner.permission.handle) === owner && !owner.signal.aborted && owner.isRunLive()
      && this.#owners.get(owner.permission.handle) === owner && !owner.signal.aborted; }
    catch { return false; }
  }

  #validateOwner(owner: PermissionOwner): void {
    this.#validate();
    if (!this.#live(owner)) { this.#retire(owner); throw notActionable(); }
    this.#validate();
  }

  #validatePhysical(physical: PhysicalConnection): void {
    this.#validate(); physical.connection.signal.throwIfAborted(); physical.connection.validate(); this.#validate();
    if (this.#physical !== physical) throw unavailable();
  }

  #validate(): void { this.#closing.signal.throwIfAborted(); this.options.signal.throwIfAborted(); this.options.validate(); this.#closing.signal.throwIfAborted(); }
  #now(): number { return (this.options.now ?? (() => performance.now()))(); }
  #schedule(callback: () => void, delayMs: number) { return (this.options.scheduleTimeout ?? scheduleTimeout)(callback, delayMs); }
}

function samePermission(left: NodePermissionReference, right: NodePermissionReference): boolean {
  return producerStreamKey(left.stream) === producerStreamKey(right.stream) && left.handle === right.handle
    && left.runId === right.runId && left.permissionOccurrenceId === right.permissionOccurrenceId;
}
function invalid(): TypeError { return new TypeError('Invalid permission reconciliation identity'); }
function capacity(): DomainError { return new DomainError('NODE_CAPACITY', 'Permission reconciliation capacity exceeded', 429); }
function unavailable(): DomainError { return new DomainError('NODE_UNAVAILABLE', 'Permission authority is unavailable', 409, true); }
function notDelivered(): DomainError { return new DomainError('NODE_UNAVAILABLE', 'Permission decision was not delivered', 409, true); }
function notActionable(): DomainError { return new DomainError('PERMISSION_NOT_ACTIONABLE', 'Permission occurrence is no longer actionable', 409); }
function unknown(): DomainError { return new DomainError('PERMISSION_DECISION_OUTCOME_UNKNOWN', 'Permission delivery could not be confirmed', 409); }
function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs); timer.unref(); return { cancel: () => clearTimeout(timer) };
}
