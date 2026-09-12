import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../common/execution-location.js';
import type { NodeWorkerServiceClient } from '../execution-node/worker/service-channel.js';
import type { NodeWorkerServiceResult } from '../execution-node/worker/service-protocol.js';
import { DomainError } from '../lib/domain-error.js';
import type { ProviderAuthService } from './provider-auth.js';
import { parseNodeProviderAuthCommand, parseNodeProviderAuthReply, type NodeProviderAuthCommand } from './transport/provider-auth-wire.js';

/** Binds auth reads and uncancellable login mutations to one captured physical instance channel. */
export class RemoteProviderAuthService implements ProviderAuthService {
  constructor(private readonly service: Pick<NodeWorkerServiceClient, 'call'>, private readonly instanceId: string) {
    if (!isExecutionIdentity(instanceId)) throw new TypeError('Invalid auth instance');
  }

  async status(signal: AbortSignal) {
    const result = await this.#call({ method: 'provider-auth', instanceId: this.instanceId, operation: 'status' }, signal);
    if (result.kind !== 'provider-auth-status') throw unavailable();
    return result.status;
  }

  async loginStatus(request: { readonly sessionId: string | null }, signal: AbortSignal) {
    const command = { method: 'provider-auth', instanceId: this.instanceId, operation: 'login-status', sessionId: request.sessionId } as const;
    const result = await this.#call(command, signal);
    if (result.kind !== 'provider-login-status' || command.sessionId !== null && result.status.state !== 'idle' && result.status.sessionId !== command.sessionId) throw unavailable();
    return result.status;
  }

  async launchLogin() {
    const result = await this.#call({ method: 'provider-auth', instanceId: this.instanceId, operation: 'launch-login' }, new AbortController().signal);
    if (result.kind !== 'provider-login-launched') throw unknown();
    return result.result;
  }

  async completeLogin(request: { readonly sessionId: string; readonly code: string }) {
    const command = { method: 'provider-auth', instanceId: this.instanceId, operation: 'complete-login', sessionId: request.sessionId, code: request.code } as const;
    const result = await this.#call(command, new AbortController().signal);
    if (result.kind !== 'provider-login-completed' || result.result.sessionId !== command.sessionId) throw unknown();
    return result.result;
  }

  async #call(command: NodeProviderAuthCommand, signal: AbortSignal) {
    signal.throwIfAborted();
    const captured = parseNodeProviderAuthCommand(command);
    if (!captured) throw new DomainError('VALIDATION_FAILED', 'Invalid provider authentication request.', 400);
    let result: NodeWorkerServiceResult;
    try { result = await this.service.call(captured, signal); }
    catch {
      signal.throwIfAborted();
      throw command.operation === 'launch-login' || command.operation === 'complete-login' ? unknown() : unavailable();
    }
    signal.throwIfAborted();
    if (result.kind === 'rejected') {
      if (result.code === 'NODE_UNAVAILABLE' || result.code === 'NODE_CAPACITY') {
        throw new DomainError(result.code, 'Provider authentication is unavailable.', 503, true);
      }
      throw new DomainError('VALIDATION_FAILED', 'The node refused the authentication request.', 400);
    }
    const reply = parseNodeProviderAuthReply(result);
    if (!reply || reply.instanceId !== this.instanceId) {
      throw command.operation === 'launch-login' || command.operation === 'complete-login' ? unknown() : unavailable();
    }
    if (reply.kind === 'provider-auth-rejected') throw new AgentIntegrationError(reply.code,
      reply.code === 'OPERATION_UNSUPPORTED' ? 'This instance does not support the requested login operation.' : 'No matching pending authentication login.', false);
    return reply;
  }
}

function unavailable() { return new DomainError('NODE_UNAVAILABLE', 'Provider authentication is unavailable.', 503, true); }
function unknown() { return new DomainError('NODE_OPERATION_UNKNOWN', 'The authentication request outcome is unknown. Check the instance login status before trying again.', 500); }
