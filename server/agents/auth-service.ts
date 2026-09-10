import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { AgentAuthStatus, AgentReadiness } from '../../common/agent-execution.js';
import type { ExecutionInstanceRef } from '../../common/execution-location.js';
import { DomainError } from '../lib/domain-error.js';
import type { AgentInstanceDirectory } from './instance-directory.js';

export interface AgentAuthServiceOptions {
  readonly instances: Pick<AgentInstanceDirectory, 'defaultFor' | 'require' | 'authForInstance'>;
  readonly localNodeId: string;
  readonly defaultAgentIds: readonly string[];
  hasEndpointModels(agentId: string): boolean;
}

export class AgentAuthService {
  constructor(private readonly deps: AgentAuthServiceOptions) {}

  supportsLogin(agentId: string): boolean {
    const ref = this.#defaultFor(agentId);
    return ref !== null && Boolean(this.deps.instances.require(ref).auth?.launchLogin);
  }

  supportsLoginCompletion(agentId: string): boolean {
    const ref = this.#defaultFor(agentId);
    return ref !== null && Boolean(this.deps.instances.require(ref).auth?.completeLogin);
  }

  async launchLogin(agentId: string) {
    return this.deps.instances.authForInstance(this.#requireDefault(agentId)).launchLogin();
  }

  async completeLogin(agentId: string, sessionId: string, code: string) {
    return this.deps.instances.authForInstance(this.#requireDefault(agentId)).completeLogin({ sessionId, code });
  }

  async loginStatus(agentId: string, sessionId: string | null, signal: AbortSignal) {
    signal.throwIfAborted();
    const status = await this.deps.instances.authForInstance(this.#requireDefault(agentId))
      .loginStatus({ sessionId }, signal);
    signal.throwIfAborted();
    return status;
  }

  async status(agentId: string, signal: AbortSignal): Promise<AgentAuthStatus | null> {
    signal.throwIfAborted();
    const ref = this.#defaultFor(agentId);
    const status = ref ? await this.deps.instances.authForInstance(ref).status(signal) : null;
    signal.throwIfAborted();
    return status;
  }

  async statusMap(signal: AbortSignal): Promise<Record<string, AgentAuthStatus>> {
    signal.throwIfAborted();
    const entries = await Promise.all(this.#defaults().map(async ({ ref, integration }) => {
      const status = await this.deps.instances.authForInstance(ref).status(signal);
      return [integration.descriptor.id, status ?? unauthenticated(integration.descriptor.label)] as const;
    }));
    signal.throwIfAborted();
    return Object.fromEntries(entries);
  }

  async readinessMap(authByAgent: Record<string, unknown> | undefined, signal: AbortSignal): Promise<Record<string, AgentReadiness>> {
    signal.throwIfAborted();
    const defaults = this.#defaults();
    const entries = await Promise.all(defaults.map(async ({ ref, integration }) => {
      const agentId = integration.descriptor.id;
      const status = authByAgent === undefined
        ? await this.deps.instances.authForInstance(ref).status(signal)
        : authByAgent[agentId];
      signal.throwIfAborted();
      const nativeReady = typeof status === 'object' && status !== null
        && 'authenticated' in status && status.authenticated === true;
      const endpointReady = integration.endpoints !== null && this.deps.hasEndpointModels(agentId);
      return [agentId, {
        ready: nativeReady || endpointReady,
        nativeReady,
        endpointReady,
        reason: endpointReady
          ? 'At least one compatible API provider endpoint is configured.'
          : nativeReady
            ? 'Native agent authentication is available.'
            : 'No native authentication or compatible API provider endpoint is configured.',
      }] as const;
    }));
    signal.throwIfAborted();
    return Object.fromEntries(entries);
  }

  #defaults(): { ref: ExecutionInstanceRef; integration: AgentIntegration }[] {
    return this.deps.defaultAgentIds.flatMap((agentId) => {
      const ref = this.#defaultFor(agentId);
      return ref ? [{ ref, integration: this.deps.instances.require(ref) }] : [];
    });
  }

  #defaultFor(agentId: string): ExecutionInstanceRef | null {
    return this.deps.instances.defaultFor(this.deps.localNodeId, agentId);
  }

  #requireDefault(agentId: string): ExecutionInstanceRef {
    const ref = this.#defaultFor(agentId);
    if (!ref) throw new DomainError('NODE_UNAVAILABLE', 'The default local provider instance is unavailable.', 409);
    return ref;
  }
}

function unauthenticated(label: string): AgentAuthStatus {
  return { authenticated: false, canReauth: false, label, source: 'none' };
}
