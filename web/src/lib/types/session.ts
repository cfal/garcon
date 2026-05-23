// Session and settings types used by app.ts and components.

import type { AmpAgentMode, ClaudeThinkingMode, PermissionMode, ThinkingMode } from '$shared/chat-modes';
import type { ApiProtocol } from '$shared/api-providers';

export type PinnedInsertPosition = 'top' | 'bottom';

export interface ChatSession {
	id: string;
	agentId: string;
	model: string | null;
	apiProviderId?: string | null;
	modelEndpointId?: string | null;
	modelProtocol?: ApiProtocol | null;
	permissionMode?: PermissionMode;
	thinkingMode?: ThinkingMode;
	claudeThinkingMode?: ClaudeThinkingMode;
	ampAgentMode?: AmpAgentMode;
	title: string;
	projectPath: string;
	tags: string[];
	native: {
		path: string | null;
	};
	activity: {
		createdAt: string | null;
		lastActivityAt: string | null;
		lastReadAt: string | null;
	};
	preview: {
		lastMessage: string;
		firstMessage?: string;
	};
	isPinned: boolean;
	isArchived: boolean;
	isActive: boolean;
	isUnread: boolean;
}
