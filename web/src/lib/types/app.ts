// Application-level types shared across the Svelte frontend.

import type {
	AmpAgentMode,
	ClaudeThinkingMode,
	PermissionMode,
	ThinkingMode,
} from '$shared/chat-modes';
import type { ApiProtocol } from '$shared/api-providers';

export type SessionAgentId = string;

export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'pull-requests';

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
	claudeThinkingMode: ClaudeThinkingMode;
	ampAgentMode?: AmpAgentMode;
	firstMessage: string;
	initialImages?: File[];
	tags?: string[];
}
