// Canonical chat session types used by the ChatSessionsStore.

import type { SessionAgentId } from '$lib/types/app';
import type {
	AmpAgentMode,
	ClaudeThinkingMode,
	PermissionMode,
	ThinkingMode,
} from '$lib/types/chat';
import type { ApiProtocol } from '$shared/api-providers';
import type { ChatOrderGroup } from '$shared/chat-list';

export type ChatStatus = 'draft' | 'running';

export interface ChatStartupConfig {
	agentId: SessionAgentId;
	model: string;
	apiProviderId?: string | null;
	modelEndpointId?: string | null;
	modelProtocol?: ApiProtocol | null;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
	claudeThinkingMode: ClaudeThinkingMode;
	ampAgentMode: AmpAgentMode;
	firstMessage: string;
	initialImages?: File[];
	tags?: string[];
}

export interface ChatSessionRecord {
	id: string;
	projectPath: string;
	effectiveProjectKey: string | null;
	projectIdentityState: 'pending' | 'available';
	orderGroup: ChatOrderGroup | null;
	title: string;
	agentId: SessionAgentId;
	model: string | null;
	apiProviderId?: string | null;
	modelEndpointId?: string | null;
	modelProtocol?: ApiProtocol | null;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
	claudeThinkingMode: ClaudeThinkingMode;
	ampAgentMode: AmpAgentMode;
	createdAt: string | null;
	lastActivityAt: string | null;
	lastReadAt: string | null;
	isPinned: boolean;
	isArchived: boolean;
	isProcessing: boolean;
	isUnread: boolean;
	status: ChatStatus;
	lastMessage?: string;
	tags: string[];
	firstMessage?: string;
}

export type ChatSessionRouterView = Readonly<
	Pick<ChatSessionRecord, 'id' | 'projectPath' | 'agentId' | 'model' | 'title'>
>;
