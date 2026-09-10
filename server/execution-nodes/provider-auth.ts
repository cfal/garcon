import type {
  AgentAuthLoginCompleteResult,
  AgentAuthLoginLaunchResult,
  AgentAuthLoginStatus,
} from '../../common/agent-auth.js';
import type { AgentAuthStatus } from '../../common/agent-execution.js';

export interface ProviderAuthService {
  status(signal: AbortSignal): Promise<AgentAuthStatus | null>;
  loginStatus(request: { readonly sessionId: string | null }, signal: AbortSignal): Promise<AgentAuthLoginStatus>;
  /** Admitted login mutations belong to the instance lifecycle, not the requesting HTTP connection. */
  launchLogin(): Promise<AgentAuthLoginLaunchResult>;
  completeLogin(request: { readonly sessionId: string; readonly code: string }): Promise<AgentAuthLoginCompleteResult>;
}
