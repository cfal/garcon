import { randomUUID } from 'node:crypto';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../common/execution-location.js';
import { sameNodeSession, type NodeOperationIdentity } from '../../common/node-operation.js';
import type { ProviderConfigurationService, ProviderSessionConfigurationOperation, ProviderSessionConfigurationResult } from '../execution-nodes/provider-configuration.js';
import { isNodeSessionConfigurationRefusalCode, parseNodeSessionConfigurationResult, type NodeSessionConfigurationCommand, type NodeSessionConfigurationPreparation,
  type NodeSessionConfigurationReceipt, type NodeSessionConfigurationReply } from '../execution-nodes/transport/provider-session-configuration-wire.js';
import type { NodeExecutionHost, NodeExecutionSourceCapture } from './execution-host.js';
import type { NodeExecutionResources, PreparedNodeExecutionResource } from './execution-resources.js';
import type { NodeProviderCapacity } from './provider-capacity.js';
import { NodeAuthorityError, type NodeConnectionLease, type NodeSupervisor } from './supervisor.js';
import type { NodeWorkerServiceResult } from './worker/service-protocol.js';

interface ConfigurationCapture {
  readonly identity: NodeOperationIdentity;
  readonly cancellation: AbortController;
  readonly release: () => void;
  readonly expiresAt: number;
  readonly detach: (() => void)[];
  phase: 'preparing' | 'prepared' | 'committing' | 'cancelling' | 'settled';
  issued: boolean;
  reason: 'cancelled' | 'target-changed';
  operation: ProviderSessionConfigurationOperation | null;
  resource: PreparedNodeExecutionResource | null;
  source: Exclude<NodeExecutionSourceCapture, { kind: 'conflict' }> | null;
  timer: { cancel(): void } | null;
  task: Promise<void> | null;
}

export interface NodeSessionConfigurationHostOptions {
  readonly instanceId: string;
  readonly connection: NodeConnectionLease;
  readonly supervisor: Pick<NodeSupervisor, 'assertConnection' | 'assertAdmission' | 'poll'>;
  readonly capacity: NodeProviderCapacity;
  readonly configuration: Pick<ProviderConfigurationService, 'prepareApply' | 'commit' | 'cancel'>;
  readonly resources: Pick<NodeExecutionResources, 'prepare'>;
  readonly execution: Pick<NodeExecutionHost, 'captureSource'>;
  readonly preparationMs?: number;
  readonly receiptMs?: number;
  readonly maxOperations?: number;
  readonly maxReceipts?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
}

/** Retains exact provider captures across physical reconnects until native commit or cancellation settles. */
export class NodeSessionConfigurationHost {
  readonly #operations = new Map<string, ConfigurationCapture>();
  readonly #receipts = new Map<string, { receipt: NodeSessionConfigurationReceipt; expiresAt: number }>();
  readonly #limits: { preparationMs: number; receiptMs: number; maxOperations: number; maxReceipts: number };
  readonly #detach: () => void;
  #closed = false;

  constructor(private readonly options: NodeSessionConfigurationHostOptions) {
    this.#limits = { preparationMs: options.preparationMs ?? 30_000, receiptMs: options.receiptMs ?? 300_000,
      maxOperations: options.maxOperations ?? 128, maxReceipts: options.maxReceipts ?? 1024 };
    if (!isExecutionIdentity(options.instanceId) || !Object.values(this.#limits).every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new TypeError('Invalid session configuration host');
    }
    this.options = Object.freeze({ ...options });
    const close = () => this.close();
    options.connection.authoritySignal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.connection.authoritySignal.removeEventListener('abort', close);
    if (options.connection.authoritySignal.aborted) this.close();
  }

  async execute(connection: NodeConnectionLease, command: NodeSessionConfigurationCommand, signal: AbortSignal): Promise<NodeWorkerServiceResult> {
    try {
      this.#poll(); this.options.supervisor.assertConnection(connection); signal.throwIfAborted();
      if (!sameNodeSession(connection.session, this.options.connection.session) || command.instanceId !== this.options.instanceId) {
        return { kind: 'rejected', code: 'VALIDATION_FAILED' };
      }
      if (command.operation === 'prepare') {
        this.options.supervisor.assertAdmission(connection);
        return await this.#prepare(connection, command, signal);
      }
      if (!sameNodeSession(command.identity, this.options.connection.session)) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
      if (command.operation === 'commit') this.options.supervisor.assertAdmission(connection);
      const capture = this.#operations.get(command.identity.operationId);
      if (capture && command.operation === 'cancel') this.#abort(capture, 'cancelled');
      if (capture && command.operation === 'commit' && capture.phase === 'prepared') await this.#commit(capture);
      return this.#receiptReply(command.identity);
    } catch (error) {
      if (error instanceof NodeAuthorityError || signal.aborted || this.#closed) return { kind: 'rejected', code: 'NODE_UNAVAILABLE' };
      return { kind: 'unknown' };
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#detach(); this.#receipts.clear();
    for (const capture of this.#operations.values()) this.#abort(capture, 'cancelled');
  }

  async #prepare(connection: NodeConnectionLease, command: Extract<NodeSessionConfigurationCommand, { operation: 'prepare' }>, signal: AbortSignal): Promise<NodeWorkerServiceResult> {
    if (command.request.executionLocation.instanceId !== this.options.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
    if (this.#operations.size >= this.#limits.maxOperations) return { kind: 'rejected', code: 'NODE_CAPACITY' };
    const release = this.options.capacity.reserve('work');
    if (!release) return { kind: 'rejected', code: 'NODE_CAPACITY' };
    const capture: ConfigurationCapture = { identity: Object.freeze({ ...connection.session, operationId: randomUUID() }),
      cancellation: new AbortController(), release, expiresAt: this.options.supervisor.poll() + this.#limits.preparationMs,
      detach: [], phase: 'preparing', issued: false, reason: 'target-changed', operation: null, resource: null, source: null,
      timer: null, task: null };
    this.#operations.set(capture.identity.operationId, capture);
    const caller = AbortSignal.any([signal, connection.signal]);
    const cancel = () => this.#abort(capture, 'cancelled');
    caller.addEventListener('abort', cancel, { once: true });
    try {
      capture.timer = (this.options.scheduleTimeout ?? scheduleTimeout)(cancel, this.#limits.preparationMs);
      caller.throwIfAborted();
      const request = structuredClone(command.request);
      const source = this.options.execution.captureSource({ chatId: request.expected.chatId,
        location: request.executionLocation, projectPath: request.expected.projectPath }, command.stream);
      if (source.kind === 'conflict') return this.#refuse(capture, 'target-conflict');
      capture.source = source;
      if (source.kind === 'captured') this.#link(capture, source.signal);
      this.#validate(capture);
      const resource = await this.options.resources.prepare(request.executionLocation, capture.cancellation.signal);
      capture.resource = resource;
      this.#link(capture, resource.signal);
      this.#validate(capture);
      if (resource.projectPath !== request.expected.projectPath) return this.#refuse(capture, 'target-conflict');
      const result = await this.options.configuration.prepareApply(request, capture.cancellation.signal);
      if (result.kind === 'prepared') capture.operation = result.operation;
      this.#validate(capture); caller.throwIfAborted(); this.options.supervisor.assertAdmission(connection);
      if (result.kind !== 'prepared') {
        this.#finish(capture, result.kind === 'unsupported' ? { kind: 'not-required' } : result);
        return this.#preparationReply(result);
      }
      if (capture.source.kind !== 'captured') {
        capture.reason = 'target-changed';
        await this.#cancelNative(capture);
        return this.#preparationReply({ kind: 'rejected', reason: 'target-changed' });
      }
      capture.phase = 'prepared'; capture.issued = true;
      return this.#preparationReply({ kind: 'prepared', identity: capture.identity });
    } catch (error) {
      const refusal = !capture.cancellation.signal.aborted && !capture.operation && error instanceof AgentIntegrationError
        && isNodeSessionConfigurationRefusalCode(error.code)
        ? { kind: 'refused', code: error.code, retryable: error.retryable } as const : null;
      if (capture.operation) await this.#cancelNative(capture);
      else this.#finish(capture, { kind: 'rejected', reason: capture.reason });
      return this.#preparationReply(refusal ?? { kind: 'rejected', reason: capture.reason });
    } finally { caller.removeEventListener('abort', cancel); }
  }

  async #commit(capture: ConfigurationCapture): Promise<void> {
    try { this.#validate(capture); }
    catch { await this.#cancelNative(capture); return; }
    const operation = capture.operation!;
    capture.operation = null; capture.phase = 'committing'; capture.timer?.cancel(); capture.timer = null;
    capture.task = (async () => {
      let result: ProviderSessionConfigurationResult;
      try { result = parseNodeSessionConfigurationResult(await this.options.configuration.commit(operation, capture.cancellation.signal)) ?? { kind: 'unknown' }; }
      catch { result = { kind: 'unknown' }; }
      this.#finish(capture, result);
    })();
    await capture.task;
  }

  #abort(capture: ConfigurationCapture, reason: ConfigurationCapture['reason']): void {
    if (capture.phase === 'settled') return;
    if (!capture.cancellation.signal.aborted) capture.reason = reason;
    capture.cancellation.abort();
    if (capture.phase === 'prepared') void this.#cancelNative(capture);
  }

  #cancelNative(capture: ConfigurationCapture): Promise<void> {
    const operation = capture.operation;
    if (!operation) return capture.task ?? Promise.resolve();
    capture.operation = null; capture.phase = 'cancelling'; capture.timer?.cancel(); capture.timer = null;
    capture.task = (async () => {
      try {
        await this.options.configuration.cancel(operation);
        this.#finish(capture, { kind: 'rejected', reason: capture.reason });
      } catch { this.#finish(capture, { kind: 'unknown' }); }
    })();
    return capture.task;
  }

  #link(capture: ConfigurationCapture, signal: AbortSignal): void {
    const cancel = () => this.#abort(capture, 'target-changed');
    signal.addEventListener('abort', cancel, { once: true });
    capture.detach.push(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  }

  #validate(capture: ConfigurationCapture): void {
    this.#poll(); capture.cancellation.signal.throwIfAborted();
    capture.resource?.validate(); capture.source?.validate();
  }

  #refuse(capture: ConfigurationCapture, reason: 'target-conflict'): NodeSessionConfigurationReply {
    this.#finish(capture, { kind: 'rejected', reason });
    return this.#preparationReply({ kind: 'rejected', reason });
  }

  #finish(capture: ConfigurationCapture, result: ProviderSessionConfigurationResult): void {
    if (capture.phase === 'settled') return;
    capture.phase = 'settled'; capture.operation = null;
    capture.timer?.cancel(); capture.timer = null;
    for (const detach of capture.detach) detach();
    capture.detach.length = 0; capture.resource = null; capture.source = null;
    this.#operations.delete(capture.identity.operationId); capture.release();
    const now = this.options.supervisor.poll();
    if (!capture.issued || this.#closed || !Number.isFinite(now)) return;
    if (this.#receipts.size >= this.#limits.maxReceipts) this.#receipts.delete(this.#receipts.keys().next().value!);
    this.#receipts.set(capture.identity.operationId, { receipt: { phase: 'settled', result },
      expiresAt: now + this.#limits.receiptMs });
  }

  #preparationReply(preparation: NodeSessionConfigurationPreparation): NodeSessionConfigurationReply {
    return { kind: 'provider-session-configuration-prepared', instanceId: this.options.instanceId, preparation };
  }

  #receiptReply(identity: NodeOperationIdentity): NodeSessionConfigurationReply {
    const capture = this.#operations.get(identity.operationId);
    const receipt: NodeSessionConfigurationReceipt | null = capture && capture.phase !== 'preparing' && capture.phase !== 'settled'
      ? { phase: capture.phase, result: null } : this.#receipts.get(identity.operationId)?.receipt ?? null;
    return { kind: 'provider-session-configuration-receipt', instanceId: this.options.instanceId, identity: { ...identity }, receipt };
  }

  #poll(): void {
    const now = this.options.supervisor.poll();
    if (this.#closed || this.options.connection.authoritySignal.aborted || !Number.isFinite(now)) {
      throw new NodeAuthorityError('NODE_SESSION_EXPIRED', 'Session configuration authority is unavailable');
    }
    for (const capture of this.#operations.values()) {
      if ((capture.phase === 'preparing' || capture.phase === 'prepared') && now >= capture.expiresAt) this.#abort(capture, 'cancelled');
    }
    for (const [key, value] of this.#receipts) if (now >= value.expiresAt) this.#receipts.delete(key);
  }
}

function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs); timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
