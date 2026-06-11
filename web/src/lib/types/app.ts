// Application-level types shared across the Svelte frontend.

import type {
	AmpAgentMode,
	ClaudeThinkingMode,
	PermissionMode,
	ThinkingMode,
} from '$shared/chat-modes';
import type { ApiProtocol } from '$shared/api-providers';

export type SessionAgentId = string;

export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'preview';

export { type ChatSession } from './session';

export interface ChatEntry {
	id: string;
	projectPath: string;
	title?: string;
	name?: string;
	model?: string | null;
	createdAt?: string;
	lastActivityAt?: string;
	agentId?: SessionAgentId;
}

export interface LoadingProgress {
	phase?: string;
	current: number;
	total: number;
	currentProject?: string;
}

export interface LoadingProgressMessage extends LoadingProgress {
	type: 'loading_progress';
}

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

export type AppSocketMessage = LoadingProgressMessage | { type?: string; [key: string]: unknown };
