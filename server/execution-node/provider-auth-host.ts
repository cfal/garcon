import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { ProviderAuthService } from '../execution-nodes/provider-auth.js';
import { captureNodeProviderAuthReply, type NodeProviderAuthCommand, type NodeProviderAuthReply } from '../execution-nodes/transport/provider-auth-wire.js';
import type { NodeProviderCapacity } from './provider-capacity.js';
import type { NodeWorkerServiceResult } from './worker/service-protocol.js';

/** Keeps native login mutations alive after physical cancellation while retaining their occupied slots. */
export class NodeProviderAuthHost {
  constructor(private readonly capacity: NodeProviderCapacity, private readonly instanceId: string, private readonly auth: ProviderAuthService) {}

  async execute(command: NodeProviderAuthCommand, signal: AbortSignal): Promise<NodeWorkerServiceResult> {
    signal.throwIfAborted();
    if (command.instanceId !== this.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
    const release = this.capacity.reserve(command.operation === 'status' || command.operation === 'login-status' ? 'status' : 'work');
    if (!release) return { kind: 'rejected', code: 'NODE_CAPACITY' };
    try {
      const result = await this.#execute(command, signal);
      signal.throwIfAborted();
      return captureNodeProviderAuthReply(result) ?? { kind: 'unknown' };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AgentIntegrationError && (error.code === 'OPERATION_UNSUPPORTED' || error.code === 'AUTH_LOGIN_SESSION_MISMATCH')) {
        return { kind: 'provider-auth-rejected', instanceId: this.instanceId, code: error.code };
      }
      return { kind: 'unknown' };
    } finally { release(); }
  }

  async #execute(command: NodeProviderAuthCommand, signal: AbortSignal): Promise<NodeProviderAuthReply> {
    const instanceId = this.instanceId;
    switch (command.operation) {
      case 'status': return { kind: 'provider-auth-status', instanceId, status: await this.auth.status(signal) };
      case 'login-status': return { kind: 'provider-login-status', instanceId, status: await this.auth.loginStatus({ sessionId: command.sessionId }, signal) };
      case 'launch-login': return { kind: 'provider-login-launched', instanceId, result: await this.auth.launchLogin() };
      case 'complete-login': return { kind: 'provider-login-completed', instanceId, result: await this.auth.completeLogin({ sessionId: command.sessionId, code: command.code }) };
    }
  }
}
