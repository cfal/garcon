// Canonical chat session types used by the ChatSessionsStore.

import type { SessionAgentId } from '$lib/types/app';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ApiProtocol } from '$shared/api-providers';
import type { ChatOrderGroup } from '$shared/chat-list';
import type { ParentChatRef } from '$shared/chat-parentage';
import type { ChatProcessingPhase } from '$shared/chat-types';

export type ChatStatus = 'draft' | 'running';

export interface ChatStartupConfig {
	agentId: SessionAgentId;
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
	orderedPreambleIds?: readonly string[];
}

export interface ChatSessionRecord {
	id: string;
	parentChat: ParentChatRef | null;
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
	agentSettings: AgentSettingsEnvelope;
	createdAt: string | null;
	lastActivityAt: string | null;
	lastReadAt: string | null;
	isPinned: boolean;
	isArchived: boolean;
	isProcessing: boolean;
	processingPhase: ChatProcessingPhase | null;
	canReloadFromNativeHistory: boolean;
	isUnread: boolean;
	status: ChatStatus;
	agentOwnershipEpoch: string | null;
	lastMessage?: string;
	tags: string[];
	firstMessage?: string;
}

export type ChatSessionRouterView = Readonly<
	Pick<ChatSessionRecord, 'id' | 'projectPath' | 'agentId' | 'model' | 'title'>
>;
