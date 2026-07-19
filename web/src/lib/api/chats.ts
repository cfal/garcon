// Chat session API for listing, starting, messaging, and managing chats.

import { apiGet, apiPost, apiPatch, apiDelete, apiPut, type ApiFetchOptions } from './client.js';
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
import type {
	ChatListResponse,
	MarkChatsReadEntry,
	MarkChatsReadRequest,
	MarkChatsReadResponse,
	SetLastSelectedChatRequest,
	SetLastSelectedChatResponse,
} from '$shared/chat-list';
import { normalizePendingUserInput, type PendingUserInput } from '$shared/pending-user-input';
import type {
  AgentInterruptAndSendCommandRequest,
  AgentInterruptAndSendResponse,
	AgentRunCommandRequest,
	AgentStopCommandRequest,
	AgentStopResponse,
	CompactCommandRequest,
	CommandAcceptedResponse,
	ExecutionSettingsPatchRequest,
	ExecutionSettingsPatchResponse,
	ForkRunCommandRequest,
	ForkRunCommandResponse,
	ForkChatResponse,
	ModelPatchRequest,
	ModelPatchResponse,
	PermissionDecisionCommandRequest,
	ProjectPathPatchRequest,
	ProjectPathPatchResponse,
	ActiveInputCommandRequest,
	ActiveInputCommandResponse,
	QueueEntryCommandResponse,
	QueueEntryCreateCommandRequest,
	QueueEntryDeleteCommandRequest,
	QueueEntryDeleteResponse,
	QueueEntryReplaceCommandRequest,
	QueueMutationResponse,
	QueuePauseRequest,
	QueueResumeRequest,
	StartChatCommandResponse,
} from '$shared/chat-command-contracts';
import type {
	GenerateChatTitleRequest,
	GenerateChatTitleResponse,
} from '$shared/chat-title-contracts';
import type {
	AgentModelPatchRequest,
	AgentModelPatchResponse,
} from '$shared/chat-command-contracts';
import type { ChatSearchRequest, ChatSearchResponse } from '$shared/chat-search';
import type { QueueState } from '$shared/queue-state';
import type { AgentCommandImage } from '$shared/ws-requests';

const CHAT_TITLE_GENERATION_TIMEOUT_MS = 120_000;

export interface StartChatParams {
	clientRequestId: string;
	clientMessageId: string;
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
	images?: AgentCommandImage[];
	tags?: string[];
}

export interface ChatDetailsResponse {
	chatId: string;
	firstMessage: string;
	createdAt: string | null;
	lastActivityAt: string | null;
	agentSessionId: string | null;
	nativePath: string | null;
}

export type ListChatsResponse = ChatListResponse;

/** Lists all chat sessions. */
export async function listChats(): Promise<ListChatsResponse> {
	return apiGet<ListChatsResponse>('/api/v1/chats');
}

export async function setLastSelectedChat(
	chatId: string | null,
): Promise<SetLastSelectedChatResponse> {
	const body: SetLastSelectedChatRequest = { chatId };
	return apiPut<SetLastSelectedChatResponse>('/api/v1/chats/last-selected', body);
}

/** Starts a new chat session. */
export async function startChat(params: StartChatParams): Promise<StartChatCommandResponse> {
	const {
		permissionMode,
		thinkingMode,
		claudeThinkingMode,
		ampAgentMode,
		...rest
	} = params;
	return apiPost<StartChatCommandResponse>('/api/v1/chats/start', {
		...rest,
		permissionMode: normalizePermissionMode(permissionMode),
		thinkingMode: normalizeThinkingMode(thinkingMode),
		claudeThinkingMode: normalizeClaudeThinkingMode(claudeThinkingMode),
		ampAgentMode: normalizeAmpAgentMode(ampAgentMode),
	});
}

export async function runChat(params: AgentRunCommandRequest): Promise<CommandAcceptedResponse> {
	return apiPost<CommandAcceptedResponse>('/api/v1/chats/run', params);
}

export async function generateChatTitle(
	params: GenerateChatTitleRequest,
): Promise<GenerateChatTitleResponse> {
	return apiPost<GenerateChatTitleResponse>('/api/v1/chats/title/generate', params, {
		timeoutMs: CHAT_TITLE_GENERATION_TIMEOUT_MS,
	});
}

export async function forkRunChat(
	params: ForkRunCommandRequest,
): Promise<ForkRunCommandResponse> {
	return apiPost<ForkRunCommandResponse>('/api/v1/chats/fork-run', params);
}

export async function stopChat(params: AgentStopCommandRequest): Promise<AgentStopResponse> {
	return apiPost<AgentStopResponse>('/api/v1/chats/stop', params);
}

export async function interruptAndSendChat(
	params: AgentInterruptAndSendCommandRequest,
): Promise<AgentInterruptAndSendResponse> {
	return apiPost<AgentInterruptAndSendResponse>('/api/v1/chats/interrupt-and-send', params);
}

export async function compactChat(params: CompactCommandRequest): Promise<CommandAcceptedResponse> {
	return apiPost<CommandAcceptedResponse>('/api/v1/chats/compact', params);
}

export async function sendPermissionDecision(
	params: PermissionDecisionCommandRequest,
): Promise<CommandAcceptedResponse> {
	return apiPost<CommandAcceptedResponse>('/api/v1/chats/permissions/decision', params);
}

export async function createQueuedInput(
	params: QueueEntryCreateCommandRequest,
): Promise<QueueEntryCommandResponse> {
	return apiPost<QueueEntryCommandResponse>('/api/v1/chats/queue/entries', params);
}

export async function replaceQueuedInput(
	params: QueueEntryReplaceCommandRequest,
): Promise<QueueEntryCommandResponse> {
	return apiPut<QueueEntryCommandResponse>('/api/v1/chats/queue/entries', params);
}

export async function deleteQueuedInput(
	params: QueueEntryDeleteCommandRequest,
): Promise<QueueEntryDeleteResponse> {
	return apiDelete<QueueEntryDeleteResponse>('/api/v1/chats/queue/entries', params);
}

export async function sendActiveInput(
	params: ActiveInputCommandRequest,
): Promise<ActiveInputCommandResponse> {
	return apiPost<ActiveInputCommandResponse>('/api/v1/chats/active-input', params);
}

export async function getChatQueue(
	chatId: string,
): Promise<{ success: true; chatId: string; queue: QueueState }> {
	return apiGet<{ success: true; chatId: string; queue: QueueState }>(
		`/api/v1/chats/queue?chatId=${encodeURIComponent(chatId)}`,
	);
}

export async function clearChatQueue(chatId: string): Promise<QueueMutationResponse> {
	return apiPost<QueueMutationResponse>('/api/v1/chats/queue/clear', { chatId });
}

export async function pauseChatQueue(chatId: string): Promise<QueueMutationResponse> {
	const request: QueuePauseRequest = { chatId };
	return apiPost<QueueMutationResponse>('/api/v1/chats/queue/pause', request);
}

export async function resumeChatQueue(chatId: string, pauseId: string): Promise<QueueMutationResponse> {
	const request: QueueResumeRequest = { chatId, pauseId };
	return apiPost<QueueMutationResponse>('/api/v1/chats/queue/resume', request);
}

export async function updateExecutionSettings(
	params: ExecutionSettingsPatchRequest,
): Promise<ExecutionSettingsPatchResponse> {
	return apiPatch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', params);
}

export async function updateChatModel(params: ModelPatchRequest): Promise<ModelPatchResponse> {
	return apiPatch<ModelPatchResponse>('/api/v1/chats/model', params);
}

// Continues a chat under a different agent. The server seeds the new runtime
// from the canonical transcript and returns the normalized execution modes for
// the target agent, which the client mirrors optimistically. The request and
// response types are the shared contract imported above.
export async function updateChatAgentModel(
	params: AgentModelPatchRequest,
): Promise<AgentModelPatchResponse> {
	return apiPatch<AgentModelPatchResponse>('/api/v1/chats/agent-model', params);
}

export async function updateChatProjectPath(
	params: ProjectPathPatchRequest,
): Promise<ProjectPathPatchResponse> {
	return apiPatch<ProjectPathPatchResponse>('/api/v1/chats/project-path', params);
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
		limit: String(params.limit ?? 50),
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

export async function searchChatTranscripts(
	request: ChatSearchRequest,
	options?: ApiFetchOptions,
): Promise<ChatSearchResponse> {
	return apiPost<ChatSearchResponse>('/api/v1/chats/search', request, options);
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

/** Marks chats as read in a single batched request. */
export async function markChatsReadBatch(
	entries: MarkChatsReadEntry[],
): Promise<MarkChatsReadResponse> {
	const request: MarkChatsReadRequest = { entries };
	return apiPost<MarkChatsReadResponse>('/api/v1/chats/read', request);
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

export async function validateStart(
	path: string,
	options?: ApiFetchOptions,
): Promise<ValidateStartResponse> {
	return apiGet<ValidateStartResponse>(
		`/api/v1/chats/validate-start?path=${encodeURIComponent(path)}`,
		options,
	);
}

export interface ForkChatParams {
	sourceChatId: string;
	chatId: string;
	upToSeq?: number;
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
