import { randomUUID } from 'node:crypto';
import { isExecutionIdentity, type ExecutionLocation } from '../../common/execution-location.js';
import {
  parseNodeOperationIdentity, sameNodeSession, type NodeOperationIdentity, type NodeOperationResult,
} from '../../common/node-operation.js';
import type { AgentProducerEvent, AgentGoalControlHandoff, AgentSteerResult, AgentExecutionAdmission } from '@garcon/server-agent-interface';
import type {
  ProviderExecutionInput, ProviderExecutionOperation, ProviderExecutionOutput, ProviderExecutionRequest,
  ProviderGoalControlInput, ProviderSteerInput, ProviderSteerTarget,
} from '../execution-nodes/provider-execution.js';
import { DomainError } from '../lib/domain-error.js';
import type { NodeConnectionLease, NodeSupervisor } from './supervisor.js';
import type { NodeExecutionResources, NodeExecutionSourceTarget, PreparedNodeExecutionResource } from './execution-resources.js';
import type { NodeExecutionBody } from '../execution-nodes/transport/execution-body-wire.js';

export interface NodeOperationLimits {
  readonly maxOperations: number;
  readonly maxReceipts: number;
  readonly preparationMs: number;
  readonly receiptMs: number;
}

export const DEFAULT_NODE_OPERATIONS: NodeOperationLimits = Object.freeze({
  maxOperations: 128, maxReceipts: 1_024, preparationMs: 30_000, receiptMs: 300_000,
});

export type NodeExecutionRequest =
  | Omit<Extract<ProviderExecutionRequest, { kind: 'start' }>, 'projectPath'>
  | Omit<Exclude<ProviderExecutionRequest, { kind: 'start' }>, 'projectPath'>;

export interface NodeExecutionTicket {
  readonly identity: NodeOperationIdentity;
  readonly location: ExecutionLocation;
  readonly projectPath: string;
  readonly runId: string;
}

export interface NodeOperationGrant {
  readonly identity: NodeOperationIdentity;
  readonly signal: AbortSignal;
  readonly source: NodeExecutionSourceTarget;
  readonly resourceSignal: AbortSignal;
  bodySignal(kind: NodeExecutionBody['kind'], controlId: string | null): AbortSignal;
  isRunLive(runId: string): boolean;
  ownsRun(runId: string): boolean;
  abort(): Promise<boolean>;
}

const issuedGrants = new WeakSet<object>();

export function isNodeOperationGrant(value: unknown): value is NodeOperationGrant {
  return typeof value === 'object' && value !== null && issuedGrants.has(value);
}

export interface NodeExecutionReceipt {
  readonly identity: NodeOperationIdentity;
  readonly runId: string;
  readonly phase: 'preparing' | 'prepared' | 'dispatched' | 'ended' | 'failed' | 'released' | 'expired';
  readonly dispatch: 'pending' | 'completed' | 'failed' | null;
  /** A requested abort is not proof of process termination. */
  readonly abort: 'pending' | 'requested' | 'unconfirmed' | null;
  readonly control: NodeControlReceipt | null;
}

export interface NodeControlTicket {
  readonly identity: NodeOperationIdentity;
  readonly controlId: string;
  readonly kind: 'steer' | 'goal';
  readonly runId: string;
}

export type NodeControlPreparation =
  | { readonly kind: 'ready'; readonly ticket: NodeControlTicket }
  | { readonly kind: 'unavailable' | 'unsupported' };

export type NodeControlOutcome =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly reason: Extract<AgentSteerResult, { kind: 'rejected' }>['reason'] | 'unavailable' | 'unsupported' }
  | { readonly kind: 'failed'; readonly outcome: 'not-sent' | 'unknown' };

export interface NodeControlReceipt {
  readonly controlId: string;
  readonly kind: 'steer' | 'goal';
  readonly runId: string;
  readonly phase: 'preparing' | 'prepared' | 'committing' | 'settled';
  readonly deliveryPrepared: boolean;
  readonly outcome: NodeControlOutcome | null;
}

export interface NodeSteerDelivery {
  readonly result: AgentSteerResult;
  readonly deliveryPrepared: boolean;
}

type ControlPhase =
  | { readonly kind: 'steer-preparing' }
  | { readonly kind: 'steer-prepared'; readonly target: ProviderSteerTarget }
  | { readonly kind: 'steer-committing' }
  | { readonly kind: 'goal-capturing'; readonly decision: PromiseWithResolvers<void> }
  | { readonly kind: 'goal-prepared'; readonly decision: PromiseWithResolvers<void>; readonly handoff: AgentGoalControlHandoff }
  | { readonly kind: 'goal-committing' }
  | { readonly kind: 'settled'; readonly outcome: NodeControlOutcome };

interface Control {
  readonly ticket: NodeControlTicket;
  readonly cancellation: AbortController;
  readonly expiresAt: number;
  readonly ready: PromiseWithResolvers<NodeControlPreparation>;
  readonly done: PromiseWithResolvers<NodeControlOutcome>;
  phase: ControlPhase;
  pending: boolean;
  deliveryPrepared: boolean;
  timer: { cancel(): void } | null;
  detachCaller: (() => void) | null;
}

interface Operation {
  readonly identity: NodeOperationIdentity;
  readonly chatId: string;
  runId: string;
  readonly runs: Set<string>;
  capability: NodeOperationGrant | null;
  readonly cancellation: AbortController;
  readonly grant: AbortController;
  readonly expiresAt: number;
  phase: NodeExecutionReceipt['phase'];
  dispatch: NodeExecutionReceipt['dispatch'];
  abort: NodeExecutionReceipt['abort'];
  pending: number;
  resource: PreparedNodeExecutionResource | null;
  provider: ProviderExecutionOperation | null;
  abortTask: Promise<boolean> | null;
  timer: { cancel(): void } | null;
  detachGrant: (() => void) | null;
  publication: ExecutionPublication | null;
  control: Control | null;
}

export interface NodeOperationTableOptions {
  readonly connection: NodeConnectionLease;
  readonly supervisor: Pick<NodeSupervisor, 'assertConnection' | 'assertAdmission' | 'poll'>;
  readonly resources: Pick<NodeExecutionResources, 'prepare'>;
  readonly limits?: Partial<NodeOperationLimits>;
  readonly scheduleTimeout?: (callback: () => void, delay: number) => { cancel(): void };
}

/** Node-local execution ownership; neither capabilities nor this API are wire payloads. */
export class NodeOperationTable {
  readonly #operations = new Map<string, Operation>();
  readonly #receipts = new Map<string, { receipt: NodeExecutionReceipt; expiresAt: number }>();
  readonly #limits: NodeOperationLimits;
  readonly #detachAuthority: () => void;
  #closed = false;

  constructor(private readonly options: NodeOperationTableOptions) {
    this.#limits = { ...DEFAULT_NODE_OPERATIONS, ...options.limits };
    for (const limit of Object.values(this.#limits)) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Node operation limits must be positive integers');
    }
    const retire = () => this.close();
    options.connection.authoritySignal.addEventListener('abort', retire, { once: true });
    this.#detachAuthority = () => options.connection.authoritySignal.removeEventListener('abort', retire);
    if (options.connection.authoritySignal.aborted) this.close();
  }

  async prepare(connection: NodeConnectionLease, location: ExecutionLocation, input: NodeExecutionRequest, signal: AbortSignal): Promise<NodeExecutionTicket> {
    this.#connection(connection);
    this.options.supervisor.assertAdmission(connection);
    signal.throwIfAborted();
    const now = this.#pollLive();
    if (this.#operations.size >= this.#limits.maxOperations) {
      throw new DomainError('NODE_CAPACITY', 'Execution capacity is reserved by other operations', 429);
    }
    const request = structuredClone(input);
    if (!isExecutionIdentity(request.runId)) throw new DomainError('VALIDATION_FAILED', 'Invalid execution run identity', 400);
    const identity = Object.freeze({ ...connection.session, operationId: randomUUID() });
    const operation: Operation = {
      identity, chatId: request.chatId, runId: request.runId, runs: new Set([request.runId]), capability: null,
      cancellation: new AbortController(), grant: new AbortController(),
      expiresAt: now + this.#limits.preparationMs,
      phase: 'preparing', dispatch: null, abort: null, pending: 1,
      resource: null, provider: null, abortTask: null, timer: null, detachGrant: null, publication: null, control: null,
    };
    this.#operations.set(identity.operationId, operation);
    operation.timer = (this.options.scheduleTimeout ?? scheduleTimeout)(() => this.poll(), this.#limits.preparationMs);
    const admissionSignal = AbortSignal.any([signal, connection.signal, connection.authoritySignal, operation.cancellation.signal]);
    const preparation = (async () => {
      try {
        const resource = await this.options.resources.prepare(location, admissionSignal);
        operation.resource = resource;
        this.#pollLive();
        admissionSignal.throwIfAborted();
        const revoked = () => { void this.#abort(operation).catch(() => {}); };
        resource.signal.addEventListener('abort', revoked, { once: true });
        operation.detachGrant = () => resource.signal.removeEventListener('abort', revoked);
        resource.signal.throwIfAborted();
        const prepareSignal = AbortSignal.any([admissionSignal, resource.signal]);
        operation.provider = await resource.execution.prepare({ ...request, projectPath: resource.projectPath }, prepareSignal);
        this.#pollLive();
        prepareSignal.throwIfAborted();
        this.#connection(connection);
        this.options.supervisor.assertAdmission(connection);
        resource.validate();
        operation.phase = 'prepared';
        return Object.freeze({ identity, location: resource.location, projectPath: resource.projectPath, runId: request.runId });
      } catch (error) {
        if (operation.phase === 'preparing') operation.phase = 'failed';
        try { this.#releaseProvider(operation); }
        catch (releaseError) { throw new AggregateError([error, releaseError], 'Execution preparation and release failed'); }
        throw error;
      } finally {
        operation.pending -= 1;
        this.#retireSettled(operation);
      }
    })();
    return awaitPreparation(preparation, admissionSignal);
  }

  async dispatch(connection: NodeConnectionLease, identity: NodeOperationIdentity, input: ProviderExecutionInput, output: ProviderExecutionOutput): Promise<void> {
    this.#connection(connection);
    this.options.supervisor.assertAdmission(connection);
    const operation = this.#require(identity);
    const { resource, provider } = operation;
    if (operation.phase !== 'prepared' || !resource || !provider) throw consumed();
    resource.validate();
    operation.cancellation.signal.throwIfAborted();
    operation.phase = 'dispatched';
    operation.dispatch = 'pending';
    operation.pending += 1;
    operation.timer?.cancel();
    operation.timer = null;
    const signal = AbortSignal.any([this.options.connection.authoritySignal, resource.signal, operation.cancellation.signal]);
    const publication = executionOutput(output, operation.runId, (outcome) => {
      if (operation.phase !== 'dispatched') return;
      if (outcome === 'failed') void this.#abort(operation).catch(() => {});
      operation.phase = outcome;
      this.#cancelControl(operation, new Error('Execution ended before control delivery'));
      operation.detachGrant?.();
      operation.detachGrant = null;
      this.#retireSettled(operation);
    }, this.options.supervisor, signal);
    operation.publication = publication;
    try {
      await resource.execution.dispatch(provider, input, {
        output: publication.sink, admission: publication.admission,
      });
      operation.dispatch = 'completed';
    } catch (error) {
      operation.dispatch = 'failed';
      if (operation.phase === 'dispatched') operation.phase = 'failed';
      publication.detachOccurrence();
      this.#cancelControl(operation, error);
      throw error;
    } finally {
      operation.pending -= 1;
      this.#retireSettled(operation);
    }
  }

  /** Captures byte and permission authority independently of a replaceable physical connection. */
  capture(connection: NodeConnectionLease, identity: NodeOperationIdentity): NodeOperationGrant {
    this.#connection(connection);
    const operation = this.#require(identity);
    if ((operation.phase !== 'prepared' && operation.phase !== 'dispatched') || !operation.resource) throw consumed();
    if (operation.capability) return operation.capability;
    const signal = AbortSignal.any([operation.grant.signal, operation.cancellation.signal,
      operation.resource.signal, this.options.connection.authoritySignal]);
    const capability: NodeOperationGrant = Object.freeze({ identity: operation.identity, signal,
      source: Object.freeze({ chatId: operation.chatId, location: operation.resource.location, projectPath: operation.resource.projectPath }),
      resourceSignal: operation.resource.signal,
      bodySignal: (kind: NodeExecutionBody['kind'], controlId: string | null) => {
        this.#pollLive();
        signal.throwIfAborted();
        if (kind === 'execution') {
          if (controlId !== null || operation.phase !== 'prepared') throw consumed();
          operation.resource!.validate();
        } else if (kind === 'steer') {
          const control = this.#requireControl(operation, controlId ?? '');
          this.#validateControl(operation, control);
          if (control.phase.kind !== 'steer-prepared') throw consumed();
          return control.cancellation.signal;
        } else if (kind === 'goal' && controlId === null) {
          this.#validateLive(operation);
          if (operation.control && (operation.control.phase.kind !== 'settled' || operation.control.pending)) throw consumed();
        } else throw consumed();
        return signal;
      },
      isRunLive: (runId: string) => {
        this.#pollLive();
        return !signal.aborted && operation.phase === 'dispatched' && operation.runId === runId;
      },
      abort: () => this.#abort(operation),
      ownsRun: (runId: string) => operation.runs.has(runId),
    });
    issuedGrants.add(capability);
    operation.capability = capability;
    return capability;
  }

  async prepareSteer(connection: NodeConnectionLease, identity: NodeOperationIdentity, signal: AbortSignal): Promise<NodeControlPreparation> {
    this.#connection(connection);
    this.options.supervisor.assertAdmission(connection);
    const operation = this.#require(identity);
    const control = this.#reserveControl(connection, operation, 'steer', operation.runId, signal);
    const { resource, provider } = operation;
    control.pending = true;
    operation.pending += 1;
    void (async () => {
      try {
        const result = await resource!.execution.prepareSteer(provider!, this.#controlSignal(operation, control));
        this.#validatePreparation(connection, operation, control);
        if (result.kind === 'ready') {
          control.phase = { kind: 'steer-prepared', target: result.target };
          control.ready.resolve({ kind: 'ready', ticket: control.ticket });
        } else {
          this.#settleControl(control, { kind: 'rejected', reason: result.kind });
          control.ready.resolve(result);
        }
      } catch (error) {
        this.#settleControl(control, { kind: 'failed', outcome: 'not-sent' });
        control.ready.reject(error);
      } finally {
        control.pending = false;
        operation.pending -= 1;
        this.#retireSettled(operation);
      }
    })();
    return control.ready.promise;
  }

  async commitSteer(
    connection: NodeConnectionLease, identity: NodeOperationIdentity, controlId: string,
    input: Omit<ProviderSteerInput, 'prepareDelivery'>,
  ): Promise<NodeSteerDelivery> {
    this.#connection(connection);
    this.options.supervisor.assertAdmission(connection);
    const operation = this.#require(identity);
    const control = this.#requireControl(operation, controlId);
    this.#validateControl(operation, control);
    if (control.phase.kind !== 'steer-prepared') throw consumed();
    const { target } = control.phase;
    const content = structuredClone(input);
    control.phase = { kind: 'steer-committing' };
    this.#disarmControl(control);
    control.pending = true;
    operation.pending += 1;
    const delivery = onceDelivery<void>(async () => {
      this.#validateControl(operation, control);
      if (control.phase.kind !== 'steer-committing') throw consumed();
      control.deliveryPrepared = true;
    });
    let result: AgentSteerResult;
    try {
      result = await operation.resource!.execution.steer(operation.provider!, target, { ...content, prepareDelivery: delivery.invoke });
    } catch {
      result = { kind: 'failed', outcome: control.deliveryPrepared ? 'unknown' : 'not-sent', message: 'Node steering delivery failed' };
    } finally {
      delivery.detach();
      control.pending = false;
      operation.pending -= 1;
    }
    this.#settleControl(control, controlOutcome(result));
    this.#retireSettled(operation);
    return { result, deliveryPrepared: control.deliveryPrepared };
  }

  async prepareGoalControl(
    connection: NodeConnectionLease, identity: NodeOperationIdentity,
    input: Omit<ProviderGoalControlInput, 'beforeDelivery'>, signal: AbortSignal,
  ): Promise<NodeControlPreparation> {
    this.#connection(connection);
    this.options.supervisor.assertAdmission(connection);
    const operation = this.#require(identity);
    if (!isExecutionIdentity(input.runId) || operation.runs.has(input.runId)) {
      throw new DomainError('VALIDATION_FAILED', 'A goal handoff requires a new run identity', 400);
    }
    const request = structuredClone(input);
    const control = this.#reserveControl(connection, operation, 'goal', request.runId, signal);
    if (control.phase.kind !== 'goal-capturing') throw consumed();
    const { decision } = control.phase;
    const { resource, provider } = operation;
    control.pending = true;
    operation.pending += 1;
    const delivery = onceDelivery<AgentGoalControlHandoff>(async (handoff) => {
      this.#validatePreparation(connection, operation, control);
      if (control.phase.kind !== 'goal-capturing') throw consumed();
      handoff.validate();
      control.phase = { kind: 'goal-prepared', handoff, decision };
      control.ready.resolve({ kind: 'ready', ticket: control.ticket });
      await decision.promise;
      this.#validateControl(operation, control);
      handoff.validate();
    });
    void (async () => {
      try {
        const submitted = await resource!.execution.submitGoalControl(provider!, {
          ...request, beforeDelivery: delivery.invoke,
        }, this.#controlSignal(operation, control));
        const committed = control.deliveryPrepared;
        this.#settleControl(control, submitted && committed ? { kind: 'accepted' }
          : committed || submitted ? { kind: 'failed', outcome: 'unknown' }
          : { kind: 'rejected', reason: 'unavailable' });
        if (submitted && !committed) control.ready.reject(new Error('Provider reported goal delivery without a committed handoff'));
        else control.ready.resolve({ kind: 'unavailable' });
      } catch (error) {
        this.#settleControl(control, { kind: 'failed', outcome: control.deliveryPrepared ? 'unknown' : 'not-sent' });
        control.ready.reject(error);
      } finally {
        delivery.detach();
        control.pending = false;
        operation.pending -= 1;
        this.#retireSettled(operation);
      }
    })();
    return control.ready.promise;
  }

  async commitGoalControl(connection: NodeConnectionLease, identity: NodeOperationIdentity, controlId: string): Promise<NodeControlOutcome> {
    this.#connection(connection);
    this.options.supervisor.assertAdmission(connection);
    const operation = this.#require(identity);
    const control = this.#requireControl(operation, controlId);
    this.#validateControl(operation, control);
    if (control.phase.kind !== 'goal-prepared') throw consumed();
    const { handoff, decision } = control.phase;
    try { handoff.validate(); }
    catch (error) { this.#cancelControl(operation, error); throw error; }
    control.phase = { kind: 'goal-committing' };
    control.deliveryPrepared = true;
    this.#disarmControl(control);
    const publication = operation.publication!;
    // Commit may synchronously emit successor output before returning control to the table.
    operation.runId = control.ticket.runId;
    operation.runs.add(operation.runId);
    publication.advanceRun(operation.runId);
    try {
      handoff.commit();
      decision.resolve();
    } catch (error) {
      decision.reject(error);
      control.cancellation.abort(error);
      this.#settleControl(control, { kind: 'failed', outcome: 'unknown' });
      void this.#abort(operation).catch(() => {});
    }
    return control.done.promise;
  }

  cancelControl(connection: NodeConnectionLease, identity: NodeOperationIdentity, controlId: string): boolean {
    this.#connection(connection);
    const operation = this.#find(identity);
    if (!operation) return false;
    this.#requireControl(operation, controlId);
    return this.#cancelControl(operation, new DOMException('Node execution control cancelled', 'AbortError'));
  }

  release(connection: NodeConnectionLease, identity: NodeOperationIdentity): void {
    this.#connection(connection);
    const operation = this.#find(identity);
    if (!operation || operation.phase !== 'prepared' && operation.phase !== 'preparing') return;
    this.#release(operation, 'released');
  }

  abort(connection: NodeConnectionLease, identity: NodeOperationIdentity): Promise<boolean> {
    try {
      this.#connection(connection);
      return this.#abort(this.#require(identity));
    } catch (error) { return Promise.reject(error); }
  }

  abortRun(connection: NodeConnectionLease, identity: NodeOperationIdentity, runId: string): Promise<boolean> {
    try {
      this.#connection(connection);
      if (!isExecutionIdentity(runId)) throw new TypeError('Invalid execution run');
      const operation = this.#find(identity);
      return operation?.runId === runId ? this.#abort(operation) : Promise.resolve(false);
    } catch (error) { return Promise.reject(error); }
  }

  status(connection: NodeConnectionLease, identity: NodeOperationIdentity): NodeOperationResult<NodeExecutionReceipt, never> {
    this.#connection(connection);
    const operation = this.#find(identity);
    const receipt = operation ? snapshot(operation) : this.#receipts.get(identity.operationId)?.receipt;
    return receipt ? { kind: 'completed', value: receipt } : { kind: 'unknown', operationId: identity.operationId };
  }

  poll(): number {
    const now = this.options.supervisor.poll();
    if (this.#closed) return now;
    for (const operation of this.#operations.values()) {
      if (operation.control && now >= operation.control.expiresAt) {
        this.#cancelControl(operation, new DOMException('Node execution control expired', 'TimeoutError'));
      }
      if ((operation.phase === 'preparing' || operation.phase === 'prepared') && now >= operation.expiresAt) {
        try { this.#release(operation, 'expired'); }
        catch { /* Expiry still retires a ticket whose provider release failed. */ }
      }
    }
    for (const [id, entry] of this.#receipts) {
      if (entry.expiresAt > now) break;
      this.#receipts.delete(id);
    }
    return now;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachAuthority();
    this.#receipts.clear();
    for (const operation of this.#operations.values()) {
      operation.timer?.cancel();
      operation.timer = null;
      operation.detachGrant?.();
      operation.detachGrant = null;
      operation.publication?.detachOccurrence();
      void this.#abort(operation).catch(() => {});
      this.#retireSettled(operation);
    }
    this.#operations.clear();
  }

  #reserveControl(connection: NodeConnectionLease, operation: Operation, kind: 'steer' | 'goal', runId: string, signal: AbortSignal): Control {
    this.#connection(connection);
    this.options.supervisor.assertAdmission(connection);
    signal.throwIfAborted();
    const now = this.#pollLive();
    this.#validateLive(operation);
    if (operation.control && (operation.control.phase.kind !== 'settled' || operation.control.pending)) {
      throw new DomainError('NODE_CAPACITY', 'An execution control is already outstanding', 429);
    }
    const decision = Promise.withResolvers<void>();
    void decision.promise.catch(() => {});
    const control: Control = {
      ticket: Object.freeze({ identity: operation.identity, controlId: randomUUID(), kind, runId }),
      expiresAt: now + this.#limits.preparationMs,
      cancellation: new AbortController(), ready: Promise.withResolvers<NodeControlPreparation>(), done: Promise.withResolvers<NodeControlOutcome>(),
      phase: kind === 'steer' ? { kind: 'steer-preparing' } : { kind: 'goal-capturing', decision },
      pending: false, deliveryPrepared: false, timer: null, detachCaller: null,
    };
    operation.control = control;
    control.timer = (this.options.scheduleTimeout ?? scheduleTimeout)(() => this.poll(), this.#limits.preparationMs);
    const caller = AbortSignal.any([signal, connection.signal]);
    const cancel = () => { this.#cancelControl(operation, caller.reason); };
    caller.addEventListener('abort', cancel, { once: true });
    control.detachCaller = () => caller.removeEventListener('abort', cancel);
    if (caller.aborted) cancel();
    return control;
  }

  #controlSignal(operation: Operation, control: Control): AbortSignal {
    return AbortSignal.any([this.options.connection.authoritySignal, operation.resource!.signal,
      operation.cancellation.signal, control.cancellation.signal]);
  }

  #validateLive(operation: Operation): void {
    this.options.connection.authoritySignal.throwIfAborted();
    if (this.#closed || operation.phase !== 'dispatched' || !operation.resource || !operation.provider) throw consumed();
    operation.cancellation.signal.throwIfAborted();
    operation.resource.validate();
  }

  #validateControl(operation: Operation, control: Control): void {
    this.#pollLive();
    this.#validateLive(operation);
    control.cancellation.signal.throwIfAborted();
    if (operation.control !== control || control.phase.kind === 'settled') throw consumed();
  }

  #validatePreparation(connection: NodeConnectionLease, operation: Operation, control: Control): void {
    this.#connection(connection);
    this.options.supervisor.assertAdmission(connection);
    this.#validateControl(operation, control);
  }

  #requireControl(operation: Operation, controlId: string): Control {
    const control = operation.control;
    if (!control || control.ticket.controlId !== controlId) throw consumed();
    return control;
  }

  #disarmControl(control: Control): void {
    control.timer?.cancel();
    control.timer = null;
    control.detachCaller?.();
    control.detachCaller = null;
  }

  #settleControl(control: Control, outcome: NodeControlOutcome): void {
    if (control.phase.kind === 'settled') return;
    this.#disarmControl(control);
    control.phase = { kind: 'settled', outcome: Object.freeze(outcome) };
    control.done.resolve(outcome);
  }

  #cancelControl(operation: Operation, error: unknown): boolean {
    const control = operation.control;
    if (!control || control.phase.kind === 'settled' || control.phase.kind === 'steer-committing' || control.phase.kind === 'goal-committing') return false;
    const decision = control.phase.kind === 'goal-capturing' || control.phase.kind === 'goal-prepared' ? control.phase.decision : null;
    this.#settleControl(control, { kind: 'failed', outcome: 'not-sent' });
    control.ready.reject(error);
    decision?.reject(error);
    control.cancellation.abort(error);
    return true;
  }

  #connection(connection: NodeConnectionLease): void {
    this.options.supervisor.assertConnection(connection);
    if (this.#closed || !sameNodeSession(connection.session, this.options.connection.session)) throw unavailable();
  }

  #find(identity: NodeOperationIdentity): Operation | null {
    const parsed = parseNodeOperationIdentity(identity);
    if (!parsed || !sameNodeSession(parsed, this.options.connection.session)) throw unavailable();
    this.#pollLive();
    return this.#operations.get(parsed.operationId) ?? null;
  }

  #require(identity: NodeOperationIdentity): Operation {
    const operation = this.#find(identity);
    if (!operation) throw consumed();
    return operation;
  }

  #release(operation: Operation, phase: 'released' | 'expired'): void {
    operation.phase = phase;
    operation.cancellation.abort(new DOMException('Node execution preparation is no longer active', 'AbortError'));
    try { this.#releaseProvider(operation); }
    finally { this.#retireSettled(operation); }
  }

  #releaseProvider(operation: Operation): void {
    const provider = operation.provider;
    operation.provider = null;
    if (provider) operation.resource!.execution.release(provider);
  }

  #pollLive(): number {
    const now = this.poll();
    if (this.#closed || this.options.connection.authoritySignal.aborted) throw unavailable();
    return now;
  }

  #abort(operation: Operation): Promise<boolean> {
    this.#cancelControl(operation, new DOMException('Execution cancellation requested', 'AbortError'));
    if (operation.abortTask) return operation.abortTask;
    if (operation.phase === 'prepared' || operation.phase === 'preparing') {
      try { this.#release(operation, 'released'); }
      catch (error) { return Promise.reject(error); }
      return Promise.resolve(false);
    }
    if (operation.phase !== 'dispatched' || !operation.resource || !operation.provider) return Promise.resolve(false);
    operation.abort = 'pending';
    operation.pending += 1;
    const { resource, provider } = operation;
    const result = Promise.resolve().then(() => resource.execution.abort(provider));
    operation.abortTask = result.then((attempted) => {
      operation.abort = attempted ? 'requested' : 'unconfirmed';
      return attempted;
    }, () => {
      operation.abort = 'unconfirmed';
      return false;
    }).finally(() => {
      operation.pending -= 1;
      this.#retireSettled(operation);
    });
    operation.cancellation.abort(new DOMException('Node execution cancellation requested', 'AbortError'));
    return operation.abortTask;
  }

  #retireSettled(operation: Operation): void {
    if (operation.pending || !this.#closed && (operation.phase === 'prepared' || operation.phase === 'dispatched' || operation.phase === 'preparing')) return;
    operation.grant.abort(new DOMException('Node operation retired', 'AbortError'));
    operation.timer?.cancel();
    operation.timer = null;
    operation.detachGrant?.();
    operation.detachGrant = null;
    operation.publication?.detachOccurrence();
    operation.publication = null;
    operation.provider = null;
    operation.resource = null;
    if (!this.#operations.delete(operation.identity.operationId) || this.#closed) return;
    const now = this.options.supervisor.poll();
    if (this.#closed) return;
    this.#receipts.set(operation.identity.operationId, {
      receipt: snapshot(operation), expiresAt: now + this.#limits.receiptMs,
    });
    while (this.#receipts.size > this.#limits.maxReceipts) this.#receipts.delete(this.#receipts.keys().next().value!);
  }
}

// Late output retains its captured sink without retaining the operation owner after a terminal.
interface ExecutionPublication {
  readonly sink: ProviderExecutionOutput;
  readonly admission: AgentExecutionAdmission;
  advanceRun(runId: string): void;
  detachOccurrence(): void;
}

function executionOutput(
  output: ProviderExecutionOutput, runId: string, finish: ((outcome: 'ended' | 'failed') => void) | null,
  supervisor: Pick<NodeSupervisor, 'poll'>, signal: AbortSignal,
): ExecutionPublication {
  const complete = (outcome: 'ended' | 'failed') => {
    const observer = finish;
    finish = null;
    observer?.(outcome);
  };
  return {
    sink: Object.freeze({
      signal: output.signal,
      emit(event: AgentProducerEvent) {
        try { output.emit(event); }
        catch { complete('failed'); return; }
        if (event.type === 'run-ended' && event.runId === runId) complete('ended');
      },
    }),
    admission: {
      signal,
      async markStarted() {
        supervisor.poll();
        signal.throwIfAborted();
        if (!finish) throw consumed();
      },
    },
    advanceRun(nextRunId) { runId = nextRunId; },
    detachOccurrence() { finish = null; },
  };
}

function snapshot(operation: Operation): NodeExecutionReceipt {
  return Object.freeze({ identity: operation.identity, runId: operation.runId,
    phase: operation.phase, dispatch: operation.dispatch, abort: operation.abort, control: operation.control ? controlSnapshot(operation.control) : null });
}

function controlSnapshot(control: Control): NodeControlReceipt {
  const { ticket, phase } = control;
  return Object.freeze({
    controlId: ticket.controlId, kind: ticket.kind, runId: ticket.runId, deliveryPrepared: control.deliveryPrepared,
    phase: phase.kind === 'steer-preparing' || phase.kind === 'goal-capturing' ? 'preparing'
      : phase.kind === 'steer-prepared' || phase.kind === 'goal-prepared' ? 'prepared'
      : phase.kind === 'settled' ? 'settled' : 'committing',
    outcome: phase.kind === 'settled' ? phase.outcome : null,
  });
}

function controlOutcome(result: AgentSteerResult): NodeControlOutcome {
  return result.kind === 'accepted' ? { kind: 'accepted' }
    : result.kind === 'rejected' ? { kind: 'rejected', reason: result.reason }
    : { kind: 'failed', outcome: result.outcome };
}

function consumed(): DomainError {
  return new DomainError('NODE_OPERATION_UNKNOWN', 'The execution ticket is unavailable or already consumed', 409);
}

function unavailable(): DomainError {
  return new DomainError('NODE_SESSION_EXPIRED', 'The execution operation belongs to an unavailable node session', 409);
}

function scheduleTimeout(callback: () => void, delay: number): { cancel(): void } {
  const timer = setTimeout(callback, delay);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

function awaitPreparation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function onceDelivery<T>(deliver: (value: T) => Promise<void>) {
  let callback: typeof deliver | null = deliver;
  return {
    invoke(value: T): Promise<void> {
      const current = callback;
      callback = null;
      return current ? current(value) : Promise.reject(consumed());
    },
    detach() { callback = null; },
  };
}
