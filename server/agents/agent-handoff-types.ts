import type { ApiProtocol } from '../../common/api-providers.js';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type { PermissionMode, ThinkingMode } from '../../common/chat-modes.js';

export interface ResolvedAgentHandoffTarget {
  readonly agentId: string;
  readonly model: string;
  readonly apiProviderId: string | null;
  readonly modelEndpointId: string | null;
  readonly modelProtocol: ApiProtocol | null;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly agentSettings: AgentSettingsEnvelope;
}
