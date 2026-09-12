import { AgentIntegrationError, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../common/execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeOperationIdentity, type NodeSessionIdentity } from '../../common/node-operation.js';
import type { NodeWorkerServiceClient } from '../execution-node/worker/service-channel.js';
import type { NodeWorkerServiceResult } from '../execution-node/worker/service-protocol.js';
import { DomainError } from '../lib/domain-error.js';
import type { ProviderConfigurationService, ProviderConfigurationUpdateRequest, ProviderSessionConfigurationOperation,
  ProviderSessionConfigurationPreparation, ProviderSessionConfigurationRequest, ProviderSessionConfigurationResult } from './provider-configuration.js';
import { captureNodeConfigurationUpdateRequest, parseNodeProviderConfigurationCommand, parseNodeProviderConfigurationReply } from './transport/provider-configuration-update-wire.js';
import { parseNodeSessionConfigurationCommand, parseNodeSessionConfigurationReply, parseNodeSessionConfigurationRequest, type NodeSessionConfigurationReceipt } from './transport/provider-session-configuration-wire.js';

export interface RemoteProviderConfigurationOptions {
  readonly instanceId: string;
  readonly session: NodeSessionIdentity;
  captureSource(request: ProviderSessionConfigurationRequest): ProducerStreamIdentity | null;
  channel(): { readonly session: NodeSessionIdentity; readonly service: Pick<NodeWorkerServiceClient, 'call'> } | null;
}

interface RemoteConfigurationCapture {
  readonly identity: NodeOperationIdentity;
  readonly signal: AbortSignal;
  consumed: boolean;
  cancelled: boolean;
}

/** Keeps configuration capabilities bound to one instance and logical session across physical replacements. */
export class RemoteProviderConfigurationService implements ProviderConfigurationService {
  readonly #session: NodeSessionIdentity;
  readonly #pending = new WeakMap<ProviderSessionConfigurationOperation, RemoteConfigurationCapture>();

  constructor(private readonly options: RemoteProviderConfigurationOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!isExecutionIdentity(options.instanceId) || !session) throw new TypeError('Invalid configuration instance');
    this.#session = Object.freeze(session);
    this.options = Object.freeze({ ...options, session: this.#session });
  }

  async prepareUpdate(input: ProviderConfigurationUpdateRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    const request = captureNodeConfigurationUpdateRequest(input);
    const command = request && parseNodeProviderConfigurationCommand({ method: 'provider-configuration', operation: 'prepare-update', instanceId: this.options.instanceId, request });
    if (!command) throw new DomainError('VALIDATION_FAILED', 'Invalid provider settings update.', 400);
    let result: NodeWorkerServiceResult;
    try { result = await this.#service()?.call(command, signal) ?? { kind: 'rejected', code: 'NODE_UNAVAILABLE' }; }
    catch { signal.throwIfAborted(); throw unavailable(); }
    signal.throwIfAborted();
    if (result.kind === 'rejected') {
      if (result.code === 'NODE_UNAVAILABLE' || result.code === 'NODE_CAPACITY') {
        throw new DomainError(result.code, 'Provider settings validation is unavailable.', 503, true);
      }
      throw new DomainError('NODE_INCOMPATIBLE', 'The node refused the settings validation contract.', 502);
    }
    const reply = parseNodeProviderConfigurationReply(result);
    if (!reply || reply.instanceId !== this.options.instanceId) throw unavailable();
    if (reply.kind === 'provider-configuration-too-large') {
      throw new DomainError('VALIDATION_FAILED', 'The normalized provider settings exceed the node transport limit.', 422);
    }
    if (reply.kind === 'provider-configuration-rejected') {
      if (reply.code === 'VALIDATION_FAILED') throw new DomainError(reply.code, 'The instance rejected the settings update.', 422);
      throw new AgentIntegrationError(reply.code, reply.code === 'INVALID_ENDPOINT'
        ? 'The instance rejected the selected endpoint.' : 'The instance rejected the provider settings.', false);
    }
    return reply.configuration;
  }

  async prepareApply(input: ProviderSessionConfigurationRequest, signal: AbortSignal): Promise<ProviderSessionConfigurationPreparation> {
    signal.throwIfAborted();
    const request = parseNodeSessionConfigurationRequest(input);
    const command = request && parseNodeSessionConfigurationCommand({ method: 'provider-session-configuration', operation: 'prepare',
      instanceId: this.options.instanceId, stream: this.options.captureSource(request), request });
    if (!command) throw new DomainError('VALIDATION_FAILED', 'Invalid session configuration target.', 400);
    if (command.operation !== 'prepare' || command.stream && !sameNodeSession(command.stream, this.#session)) throw unavailable();
    const service = this.#service();
    if (!service) throw unavailable();
    const result = await service.call(command, signal);
    const reply = parseNodeSessionConfigurationReply(result);
    if (!reply || reply.kind !== 'provider-session-configuration-prepared' || reply.instanceId !== this.options.instanceId) {
      signal.throwIfAborted(); throw unavailable();
    }
    const prepared = reply.preparation;
    if (prepared.kind === 'refused') {
      signal.throwIfAborted();
      throw new AgentIntegrationError(prepared.code, 'The instance refused the session settings update.', prepared.retryable);
    }
    if (prepared.kind !== 'prepared') { signal.throwIfAborted(); return prepared; }
    if (!sameNodeSession(prepared.identity, this.#session)) throw unavailable();
    const operation = Object.freeze({}) as ProviderSessionConfigurationOperation;
    this.#pending.set(operation, { identity: Object.freeze(prepared.identity), signal, consumed: false, cancelled: false });
    if (signal.aborted) { await this.cancel(operation); signal.throwIfAborted(); }
    return { kind: 'prepared', operation };
  }

  async commit(operation: ProviderSessionConfigurationOperation, signal: AbortSignal): Promise<ProviderSessionConfigurationResult> {
    const captured = this.#pending.get(operation);
    if (!captured || captured.consumed || captured.cancelled) return { kind: 'rejected', reason: 'target-changed' };
    captured.consumed = true;
    if (signal.aborted || captured.signal.aborted) {
      await this.cancel(operation);
      return { kind: 'rejected', reason: 'cancelled' };
    }
    const service = this.#service();
    if (!service) return { kind: 'rejected', reason: 'target-changed' };
    try {
      const result = await service.call({ method: 'provider-session-configuration', operation: 'commit',
        instanceId: this.options.instanceId, identity: captured.identity }, signal);
      if (result.kind === 'rejected') return { kind: 'rejected', reason: 'target-changed' };
      const receipt = this.#receipt(result, captured);
      return receipt?.phase === 'settled' ? receipt.result : { kind: 'unknown' };
    } catch { return { kind: 'unknown' }; }
  }

  async cancel(operation: ProviderSessionConfigurationOperation): Promise<void> {
    const captured = this.#pending.get(operation);
    if (!captured || captured.cancelled) return;
    captured.cancelled = true;
    const service = this.#service();
    if (!service) return;
    try {
      await service.call({ method: 'provider-session-configuration', operation: 'cancel',
        instanceId: this.options.instanceId, identity: captured.identity }, new AbortController().signal);
    } catch { /* An unavailable target expires on its owning node without replay. */ }
  }

  async status(operation: ProviderSessionConfigurationOperation, signal: AbortSignal): Promise<NodeSessionConfigurationReceipt | null> {
    signal.throwIfAborted();
    const captured = this.#pending.get(operation);
    if (!captured) return null;
    const service = this.#service();
    if (!service) throw unavailable();
    const result = await service.call({ method: 'provider-session-configuration', operation: 'status',
      instanceId: this.options.instanceId, identity: captured.identity }, signal);
    signal.throwIfAborted();
    return this.#receipt(result, captured);
  }

  #receipt(result: NodeWorkerServiceResult, captured: RemoteConfigurationCapture): NodeSessionConfigurationReceipt | null {
    const reply = parseNodeSessionConfigurationReply(result);
    return reply?.kind === 'provider-session-configuration-receipt' && reply.instanceId === this.options.instanceId
      && sameNodeSession(reply.identity, captured.identity) && reply.identity.operationId === captured.identity.operationId ? reply.receipt : null;
  }

  #service(): Pick<NodeWorkerServiceClient, 'call'> | null {
    const channel = this.options.channel();
    return channel && sameNodeSession(channel.session, this.#session) ? channel.service : null;
  }
}

function unavailable(): DomainError { return new DomainError('NODE_UNAVAILABLE', 'Provider settings validation is unavailable.', 503, true); }
