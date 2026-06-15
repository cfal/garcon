// Chat session API for listing, starting, messaging, and managing chats.

import { apiGet, apiPost, apiPatch, apiDelete } from './client.js';
import type { SessionAgentId } from '$lib/types/app.js';
import {
	normalizeAmpAgentMode,
	normalizeClaudeThinkingMode,
	normalizePermissionMode,
	normalizeThinkingMode,
	type AmpAgentMode,
	type ClaudeThinkingMode,
	type PermissionMode,
	type ThinkingMode,
} from '$shared/chat-modes';
import type { ApiProtocol } from '$shared/api-providers';
import { parseChatViewMessages, type ChatViewMessage } from '$shared/chat-view';
import type { ChatListResponse } from '$shared/chat-list';
import { normalizePendingUserInput, type PendingUserInput } from '$shared/pending-user-input';
import type {
	AgentRunCommandRequest,
	AgentStopCommandRequest,
	AgentStopResponse,
	CommandAcceptedResponse,
	ExecutionSettingsPatchRequest,
	ExecutionSettingsPatchResponse,
	ForkRunCommandRequest,
	ModelPatchRequest,
	ModelPatchResponse,
	PermissionDecisionCommandRequest,
	QueueEnqueueCommandRequest,
	QueueEnqueueResponse,
	QueueMutationResponse,
	RunningChatsResponse,
} from '$shared/chat-command-contracts';
import type { QueueState } from '$shared/queue-state';

export interface StartChatParams {
	clientRequestId?: string;
	clientMessageId?: string;
	chatId: string;
	agentId: SessionAgentId;
	projectPath: string;
	model: string;
	apiProviderId?: string | null;
	modelEndpointId?: string | null;
	modelProtocol?: ApiProtocol | null;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
	claudeThinkingMode: ClaudeThinkingMode;
	ampAgentMode: AmpAgentMode;
	command: string;
	options?: Record<string, unknown>;
	tags?: string[];
}

export interface ChatDetailsResponse {
	chatId: string;
	firstMessage: string;
	createdAt: string | null;
	lastActivityAt: string | null;
	nativePath: string | null;
}

export type ListChatsResponse = ChatListResponse;

/** Lists all chat sessions. */
export async function listChats(): Promise<ListChatsResponse> {
	return apiGet<ListChatsResponse>('/api/v1/chats');
}

export interface StartChatResponse {
	success: true;
	commandType: string;
	clientRequestId: string;
	chatId?: string;
	turnId?: string;
	status: 'accepted' | 'duplicate' | 'already-applied';
	acceptedAt: string;
}

/** Starts a new chat session. */
export async function startChat(params: StartChatParams): Promise<StartChatResponse> {
	const {
		permissionMode,
		thinkingMode,
		claudeThinkingMode,
		ampAgentMode,
		options = {},
		tags = [],
		...rest
	} = params;
	return apiPost<StartChatResponse>('/api/v1/chats/start', {
		...rest,
		permissionMode: normalizePermissionMode(permissionMode),
		thinkingMode: normalizeThinkingMode(thinkingMode),
		claudeThinkingMode: normalizeClaudeThinkingMode(claudeThinkingMode),
		ampAgentMode: normalizeAmpAgentMode(ampAgentMode),
		options,
		tags,
	});
}

export async function runChat(params: AgentRunCommandRequest): Promise<CommandAcceptedResponse> {
	return apiPost<CommandAcceptedResponse>('/api/v1/chats/run', params);
}

export async function forkRunChat(
	params: ForkRunCommandRequest,
): Promise<CommandAcceptedResponse & { sourceChatId?: string }> {
	return apiPost<CommandAcceptedResponse & { sourceChatId?: string }>(
		'/api/v1/chats/fork-run',
		params,
	);
}

export async function stopChat(params: AgentStopCommandRequest): Promise<AgentStopResponse> {
	return apiPost<AgentStopResponse>('/api/v1/chats/stop', params);
}

export async function sendPermissionDecision(
	params: PermissionDecisionCommandRequest,
): Promise<CommandAcceptedResponse> {
	return apiPost<CommandAcceptedResponse>('/api/v1/chats/permissions/decision', params);
}

export async function enqueueChatMessage(
	params: QueueEnqueueCommandRequest,
): Promise<QueueEnqueueResponse> {
	return apiPost<QueueEnqueueResponse>('/api/v1/chats/queue/enqueue', params);
}

export async function getChatQueue(
	chatId: string,
): Promise<{ success: true; chatId: string; queue: QueueState }> {
	return apiGet<{ success: true; chatId: string; queue: QueueState }>(
		`/api/v1/chats/queue?chatId=${encodeURIComponent(chatId)}`,
	);
}

export async function dequeueChatMessage(
	chatId: string,
	entryId: string,
): Promise<QueueMutationResponse> {
	return apiPost<QueueMutationResponse>('/api/v1/chats/queue/dequeue', { chatId, entryId });
}

export async function clearChatQueue(chatId: string): Promise<QueueMutationResponse> {
	return apiPost<QueueMutationResponse>('/api/v1/chats/queue/clear', { chatId });
}

export async function pauseChatQueue(chatId: string): Promise<QueueMutationResponse> {
	return apiPost<QueueMutationResponse>('/api/v1/chats/queue/pause', { chatId });
}

export async function resumeChatQueue(chatId: string): Promise<QueueMutationResponse> {
	return apiPost<QueueMutationResponse>('/api/v1/chats/queue/resume', { chatId });
}

export async function updateExecutionSettings(
	params: ExecutionSettingsPatchRequest,
): Promise<ExecutionSettingsPatchResponse> {
	return apiPatch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', params);
}

export async function updateChatModel(params: ModelPatchRequest): Promise<ModelPatchResponse> {
	return apiPatch<ModelPatchResponse>('/api/v1/chats/model', params);
}

export async function getRunningChats(): Promise<RunningChatsResponse> {
	return apiGet<RunningChatsResponse>('/api/v1/chats/running');
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`Invalid chat messages page: ${fieldName}`);
	}
	return value;
}

function requireNonNegativeInteger(value: unknown, fieldName: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new Error(`Invalid chat messages page: ${fieldName}`);
	}
	return value;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new Error(`Invalid chat messages page: ${fieldName}`);
	}
	return value;
}

function parsePendingUserInputs(value: unknown): PendingUserInput[] {
	if (!Array.isArray(value)) {
		throw new Error('Invalid chat messages page: pendingUserInputs');
	}
	const pendingInputs: PendingUserInput[] = [];
	for (const item of value) {
		const pendingInput = normalizePendingUserInput(item);
		if (pendingInput === null) {
			throw new Error('Invalid chat messages page: pendingUserInputs');
		}
		pendingInputs.push(pendingInput);
	}
	return pendingInputs;
}

export async function getChatMessages(params: {
	chatId: string;
	limit?: number;
	beforeSeq?: number;
}): Promise<{
	chatId: string;
	messages: ChatViewMessage[];
	generationId: string;
	lastSeq: number;
	pageOldestSeq: number;
	pendingUserInputs: PendingUserInput[];
	hasMore: boolean;
	limit: number;
}> {
	const query = new URLSearchParams({
		chatId: params.chatId,
		limit: String(params.limit ?? 20),
	});
	if (params.beforeSeq !== undefined) query.set('beforeSeq', String(params.beforeSeq));
	const response = await apiGet<{
		chatId?: unknown;
		messages?: unknown;
		generationId?: unknown;
		lastSeq?: unknown;
		pageOldestSeq?: unknown;
		pendingUserInputs?: unknown;
		hasMore?: unknown;
		limit?: unknown;
	}>(`/api/v1/chats/messages?${query.toString()}`);
	const messages = parseChatViewMessages(response.messages);
	if (messages === null) throw new Error('Invalid chat messages page: messages');
	if (typeof response.hasMore !== 'boolean') {
		throw new Error('Invalid chat messages page: hasMore');
	}
	return {
		chatId: requireNonEmptyString(response.chatId, 'chatId'),
		messages,
		generationId: requireNonEmptyString(response.generationId, 'generationId'),
		lastSeq: requireNonNegativeInteger(response.lastSeq, 'lastSeq'),
		pageOldestSeq: requireNonNegativeInteger(response.pageOldestSeq, 'pageOldestSeq'),
		pendingUserInputs: parsePendingUserInputs(response.pendingUserInputs),
		hasMore: response.hasMore,
		limit: requirePositiveInteger(response.limit, 'limit'),
	};
}

export interface DeleteChatResponse {
	success: boolean;
}

/** Deletes a chat session. */
export async function deleteChat(chatId: string): Promise<DeleteChatResponse> {
	return apiDelete<DeleteChatResponse>('/api/v1/chats', { chatId });
}

/** Fetches detailed chat metadata for sidebar details dialog. */
export async function getChatDetails(chatId: string): Promise<ChatDetailsResponse> {
	return apiGet<ChatDetailsResponse>(`/api/v1/chats/details?chatId=${encodeURIComponent(chatId)}`);
}

/** Toggles the pinned state of a chat session. */
export async function togglePinned(
	chatId: string,
): Promise<{ success: boolean; isPinned: boolean }> {
	return apiPost('/api/v1/chats/pin', { chatId });
}

export interface ToggleArchiveResponse {
	success: boolean;
	isArchived: boolean;
}

/** Toggles the archived state of a chat session. */
export async function toggleArchive(chatId: string): Promise<ToggleArchiveResponse> {
	return apiPost<ToggleArchiveResponse>('/api/v1/chats/archive', { chatId });
}

export interface MarkReadBatchResponse {
	success: boolean;
	results: Array<{ chatId: string; lastReadAt: string }>;
}

/** Marks chats as read in a single batched request. */
export async function markChatsReadBatch(
	entries: Array<{ chatId: string; lastReadAt: string }>,
): Promise<MarkReadBatchResponse> {
	return apiPost<MarkReadBatchResponse>('/api/v1/chats/read', { entries });
}

export type ValidateStartErrorCode =
	| 'path_required'
	| 'outside_base_dir'
	| 'not_directory'
	| 'path_not_found'
	| 'permission_denied'
	| 'unknown';

export interface ValidateStartResponse {
	success?: false;
	valid: boolean;
	isGitRepo?: boolean;
	error?: string;
	errorCode?: ValidateStartErrorCode;
}

export async function validateStart(path: string): Promise<ValidateStartResponse> {
	return apiGet<ValidateStartResponse>(
		`/api/v1/chats/validate-start?path=${encodeURIComponent(path)}`,
	);
}

export interface ForkChatParams {
	sourceChatId: string;
	chatId: string;
}

export interface ForkChatResponse {
	success: boolean;
	sourceChatId: string;
	chatId: string;
	agentId: string;
}

/** Forks (clones) an existing chat session into a new chat. */
export async function forkChat(params: ForkChatParams): Promise<ForkChatResponse> {
	return apiPost<ForkChatResponse>('/api/v1/chats/fork', params);
}

export type ChatOrderList = 'pinned' | 'normal' | 'archived';

export interface ReorderChatsRequest {
	list: ChatOrderList;
	oldOrder: string[];
	newOrder: string[];
}

export type ReorderQuickTarget =
	| { chatIdAbove: string; chatIdBelow?: never }
	| { chatIdBelow: string; chatIdAbove?: never };

export type ReorderQuickRequest = { chatId: string } & ReorderQuickTarget;

/** Persists a window reorder within a group. */
export async function reorderChats(body: ReorderChatsRequest): Promise<{ success: boolean }> {
	return apiPost('/api/v1/chats/reorder', body);
}

/** Moves a single chat relative to a neighbor within the same group. */
export async function reorderChatsQuick(body: ReorderQuickRequest): Promise<{ success: boolean }> {
	return apiPost('/api/v1/chats/reorder-quick', body);
}

export interface SetChatTagsResponse {
	success: boolean;
	chatId: string;
	tags: string[];
}

/** Updates the tags for a chat session. */
export async function setChatTags(chatId: string, tags: string[]): Promise<SetChatTagsResponse> {
	return apiPatch<SetChatTagsResponse>('/api/v1/chats/tags', { chatId, tags });
}
