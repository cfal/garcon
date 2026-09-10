import type { AgentIntegration, AgentNativeActivityResult, AgentNativeSessionRef } from '@garcon/server-agent-interface';
import type { ProviderNativeActivityService } from '../execution-nodes/provider-native-activity.js';

export class LocalProviderNativeActivityService implements ProviderNativeActivityService {
  constructor(private readonly integration: Pick<AgentIntegration, 'descriptor' | 'nativeActivity'>) {}

  async lastActivity(ref: AgentNativeSessionRef, signal: AbortSignal): Promise<AgentNativeActivityResult> {
    signal.throwIfAborted();
    const nativeSession = structuredClone(ref);
    if (nativeSession.ownerId !== this.integration.descriptor.id) throw new Error('Native session owner mismatch');
    const result = await this.integration.nativeActivity?.lastActivity(nativeSession, signal) ?? { kind: 'unavailable' as const };
    signal.throwIfAborted();
    return structuredClone(result);
  }
}
