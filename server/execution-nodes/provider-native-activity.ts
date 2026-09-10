import type { AgentNativeActivityResult, AgentNativeSessionRef } from '@garcon/server-agent-interface';

export interface ProviderNativeActivityService {
  lastActivity(ref: AgentNativeSessionRef, signal: AbortSignal): Promise<AgentNativeActivityResult>;
}
