// Application-level types shared across the Svelte frontend.

import type { PermissionMode, ThinkingMode } from '$shared/chat-modes';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ApiProtocol } from '$shared/api-providers';

export type SessionAgentId = string;

export { type ChatSession } from './session';

export interface NewChatConfig {
	agentId: SessionAgentId;
	projectPath: string;
	model: string;
	apiProviderId?: string | null;
	modelEndpointId?: string | null;
	modelProtocol?: ApiProtocol | null;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
	agentSettings: AgentSettingsEnvelope;
	firstMessage: string;
	initialImages?: File[];
	tags?: string[];
}
