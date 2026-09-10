import { AgentIntegrationError, type AgentIntegration } from '@garcon/server-agent-interface';
import type {
  AgentAuthLoginCompleteResult,
  AgentAuthLoginLaunchResult,
  AgentAuthLoginStatus,
} from '../../common/agent-auth.js';
import type { AgentAuthStatus } from '../../common/agent-execution.js';
import type { ProviderAuthService } from '../execution-nodes/provider-auth.js';

export class LocalProviderAuthService implements ProviderAuthService {
  constructor(private readonly integration: Pick<AgentIntegration, 'auth' | 'descriptor'>) {}

  async status(signal: AbortSignal): Promise<AgentAuthStatus | null> {
    signal.throwIfAborted();
    const status = await this.integration.auth?.status(signal) ?? null;
    signal.throwIfAborted();
    return structuredClone(status);
  }

  async loginStatus(request: { readonly sessionId: string | null }, signal: AbortSignal): Promise<AgentAuthLoginStatus> {
    signal.throwIfAborted();
    const status: AgentAuthLoginStatus = this.integration.auth?.loginStatus?.(request.sessionId ?? undefined)
      ?? { state: 'idle', running: false };
    signal.throwIfAborted();
    return structuredClone(status);
  }

  async launchLogin(): Promise<AgentAuthLoginLaunchResult> {
    const auth = this.integration.auth;
    if (!auth?.launchLogin) {
      throw new AgentIntegrationError('OPERATION_UNSUPPORTED',
        `Auth login is not supported for agent: ${this.integration.descriptor.id}`, false);
    }
    return structuredClone(await auth.launchLogin());
  }

  async completeLogin(request: { readonly sessionId: string; readonly code: string }): Promise<AgentAuthLoginCompleteResult> {
    const auth = this.integration.auth;
    if (!auth?.completeLogin) {
      throw new AgentIntegrationError('OPERATION_UNSUPPORTED',
        `Auth login completion is not supported for agent: ${this.integration.descriptor.id}`, false);
    }
    return structuredClone(await auth.completeLogin(request.sessionId, request.code));
  }
}
