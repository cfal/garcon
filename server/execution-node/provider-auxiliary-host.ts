import type { AgentIntegration, AgentPreparedProviderConfiguration } from '@garcon/server-agent-interface';
import type { ExecutionInstanceRef } from '../../common/execution-location.js';
import type { NodeOperationIdentity } from '../../common/node-operation.js';
import type { ProviderConfigurationResolver } from '../execution-nodes/provider-configuration.js';
import { parseNodeProviderAuxiliaryReply, type NodeProviderAuxiliaryCommand } from '../execution-nodes/transport/provider-auxiliary-wire.js';
import { DomainError } from '../lib/domain-error.js';
import type { NodeExecutionResources } from './execution-resources.js';
import type { NodeNativeTasks } from './native-tasks.js';
import type { NodeProviderCapacity } from './provider-capacity.js';
import type { NodeWorkerServiceResult } from './worker/service-protocol.js';

const MAX_AUXILIARY_IDENTITIES = 1_024;

interface AuxiliaryHostOptions {
  readonly instance: ExecutionInstanceRef;
  readonly capacity: NodeProviderCapacity;
  readonly resources: Pick<NodeExecutionResources, 'prepare'>;
  readonly configuration: ProviderConfigurationResolver;
  readonly native: NodeNativeTasks;
  readonly provider: Pick<AgentIntegration, 'singleQueryLifetime' | 'textGenerationLifetime'>;
  readonly maxIdentities?: number;
  requestContainment(identity: NodeOperationIdentity): void;
}

/** Owns auxiliary identity and native reservations across physical connection replacement. */
export class NodeProviderAuxiliaryHost {
  readonly #identities = new Set<string>();
  readonly #maxIdentities: number;

  constructor(private readonly options: AuxiliaryHostOptions) {
    this.#maxIdentities = options.maxIdentities ?? MAX_AUXILIARY_IDENTITIES;
    if (!Number.isSafeInteger(this.#maxIdentities) || this.#maxIdentities < 1) throw new TypeError('Invalid auxiliary identity limit');
  }

  async execute(command: NodeProviderAuxiliaryCommand, signal: AbortSignal): Promise<NodeWorkerServiceResult> {
    signal.throwIfAborted();
    if (command.instanceId !== this.options.instance.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
    const { singleQueryLifetime, textGenerationLifetime } = this.options.provider;
    if (command.method === 'provider-single-query' ? singleQueryLifetime === null : textGenerationLifetime === null) {
      return { kind: 'rejected', code: 'NODE_UNAVAILABLE' };
    }
    const key = JSON.stringify([command.identity.controllerBootId, command.identity.nodeBootId, command.identity.logicalSessionId, command.identity.operationId]);
    if (this.#identities.has(key)) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
    if (this.#identities.size >= this.#maxIdentities) return { kind: 'rejected', code: 'NODE_UNAVAILABLE' };
    const captured = structuredClone(command);
    const release = this.options.capacity.reserve('work');
    if (!release) return { kind: 'rejected', code: 'NODE_CAPACITY' };
    this.#identities.add(key);
    try {
      let configuration: AgentPreparedProviderConfiguration;
      let projectPath = '';
      let nativeSignal = signal;
      let validate = () => signal.throwIfAborted();
      try {
        if (captured.method === 'provider-single-query') {
          const workspace = await this.options.resources.prepare({ ...this.options.instance, workspaceId: captured.workspaceId }, signal);
          nativeSignal = AbortSignal.any([signal, workspace.signal]);
          projectPath = workspace.projectPath;
          validate = () => { nativeSignal.throwIfAborted(); workspace.validate(); };
        }
        validate();
        configuration = await this.options.configuration.resolve(captured.request.configuration, nativeSignal);
        validate();
      } catch (error) {
        signal.throwIfAborted();
        return refusal(error);
      }
      const request = { ...configuration, prompt: captured.request.prompt, timeoutMs: captured.request.timeoutMs, signal: nativeSignal };
      let running: Promise<string>;
      try {
        running = this.options.native.run(() => captured.method === 'provider-single-query'
          ? singleQueryLifetime!.begin({ ...request, projectPath })
          : textGenerationLifetime!.begin(request), nativeSignal,
        () => this.options.requestContainment(captured.identity));
      } catch (error) { return refusal(error); }
      try {
        const value = await running;
        validate();
        if (typeof value !== 'string') return { kind: 'unknown' };
        const reply = parseNodeProviderAuxiliaryReply({ kind: 'provider-auxiliary-result', instanceId: captured.instanceId, identity: captured.identity, value });
        return reply ?? { kind: 'provider-auxiliary-too-large', instanceId: captured.instanceId, identity: captured.identity };
      } catch {
        signal.throwIfAborted();
        return { kind: 'unknown' };
      }
    } finally { release(); }
  }
}

function refusal(error: unknown): NodeWorkerServiceResult {
  if (error instanceof DomainError && (error.code === 'NODE_UNAVAILABLE' || error.code === 'NODE_CAPACITY')) {
    return { kind: 'rejected', code: error.code };
  }
  return { kind: 'rejected', code: 'VALIDATION_FAILED' };
}
