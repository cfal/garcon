import { randomUUID } from 'node:crypto';
import { isExecutionIdentity } from '../../common/execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../common/node-operation.js';
import type { NodeWorkerServiceClient } from '../execution-node/worker/service-channel.js';
import { DomainError } from '../lib/domain-error.js';
import type { ProviderTextGenerationRequest } from './provider-text-generation.js';
import { parseNodeProviderAuxiliaryCommand, parseNodeProviderAuxiliaryReply, type NodeProviderAuxiliaryCommand } from './transport/provider-auxiliary-wire.js';

/** Captures one physical client and instance; failed or unknown work is never submitted again. */
export class RemoteProviderAuxiliaryService {
  readonly #session: NodeSessionIdentity;

  constructor(
    private readonly service: Pick<NodeWorkerServiceClient, 'call'>,
    private readonly instanceId: string,
    session: NodeSessionIdentity,
  ) {
    const captured = parseNodeSessionIdentity(session);
    if (!captured || !isExecutionIdentity(instanceId)) throw new TypeError('Invalid auxiliary source');
    this.#session = Object.freeze(captured);
  }

  singleQuery(workspaceId: string, request: ProviderTextGenerationRequest, signal: AbortSignal): Promise<string> {
    return this.#run({ method: 'provider-single-query', workspaceId, instanceId: this.instanceId,
      identity: { ...this.#session, operationId: randomUUID() }, request }, signal);
  }

  generate(request: ProviderTextGenerationRequest, signal: AbortSignal): Promise<string> {
    return this.#run({ method: 'provider-text-generation', instanceId: this.instanceId,
      identity: { ...this.#session, operationId: randomUUID() }, request }, signal);
  }

  async #run(input: NodeProviderAuxiliaryCommand, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const command = parseNodeProviderAuxiliaryCommand(input);
    if (!command) throw new DomainError('VALIDATION_FAILED', 'Invalid or oversized auxiliary request', 400);
    const reply = await this.service.call(command, signal);
    signal.throwIfAborted();
    if (reply.kind === 'rejected') {
      if (reply.code === 'NODE_UNAVAILABLE' || reply.code === 'NODE_CAPACITY') {
        throw new DomainError(reply.code, 'Node auxiliary work is unavailable', 503, reply.code === 'NODE_CAPACITY');
      }
      throw new DomainError('VALIDATION_FAILED', 'Node refused auxiliary work', 400);
    }
    if (reply.kind === 'unknown') throw new DomainError('NODE_OPERATION_UNKNOWN', 'Node auxiliary work has an unknown outcome', 502);
    const result = parseNodeProviderAuxiliaryReply(reply);
    if (!result || result.instanceId !== this.instanceId || !sameNodeSession(result.identity, command.identity)
      || result.identity.operationId !== command.identity.operationId) {
      throw new DomainError('NODE_OPERATION_UNKNOWN', 'Node auxiliary reply does not match its request', 502);
    }
    if (result.kind === 'provider-auxiliary-too-large') throw new DomainError('VALIDATION_FAILED', 'Node auxiliary result exceeds the transport limit', 502);
    return result.value;
  }
}
