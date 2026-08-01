// Chat session API for listing, starting, messaging, and managing chats.

import { ApiError, apiGet, apiPost, apiPatch, apiDelete, apiPut, type ApiFetchOptions } from './client.js';
import type { SessionAgentId } from '$lib/types/app.js';
import {
	normalizePermissionMode,
	normalizeThinkingMode,
	type PermissionMode,
	type ThinkingMode,
} from '$shared/chat-modes';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ApiProtocol } from '$shared/api-providers';
import { parseChatViewMessages, type ChatViewMessage } from '$shared/chat-view';
import type {
	ChatListEntry,
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
	GoalControlCommandRequest,
	GoalControlCommandResponse,
	SteerCommandRequest,
	SteerCommandResponse,
	QueueEntryCommandResponse,
	QueueEntryCreateCommandRequest,
	QueueEntryDeleteCommandRequest,
	QueueEntryDeleteResponse,
	QueueEntryMoveCommandRequest,
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
import type { ChatDetailsResponse } from '$shared/chat-details';
import {
	parseChatExecutionControlState,
	type ChatExecutionControlState,
} from '$shared/chat-execution-control';
import { CHAT_STOP_OUTCOMES, type ChatStopOutcome } from '$shared/chat-types';
import type { AgentCommandImage } from '$shared/ws-requests';
import {
	parseReorderChatResponse,
	type ReorderChatRequest,
	type ReorderChatResponse,
} from '$shared/chat-order-contracts';

const CHAT_TITLE_GENERATION_TIMEOUT_MS = 120_000;

function withParsedControl<T extends { control: ChatExecutionControlState }>(response: T): T {
	const control = parseChatExecutionControlState(response.control);
	if (!control) throw new Error('Invalid chat execution control response');
	return { ...response, control };
}

function withParsedStopOutcome<
	T extends { control: ChatExecutionControlState; outcome: ChatStopOutcome },
>(response: T): T {
	const outcome = CHAT_STOP_OUTCOMES.find((entry) => entry === response.outcome);
	if (!outcome) throw new Error('Invalid chat Stop outcome response');
	return { ...withParsedControl(response), outcome };
}

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
	agentSettings: AgentSettingsEnvelope;
	command: string;
	images?: AgentCommandImage[];
	tags?: string[];
}

export type { ChatDetailsResponse } from '$shared/chat-details';

export type ListChatsResponse = ChatListResponse;

function hasConsistentProcessingPhase(
	entry: Pick<ChatListEntry, 'isProcessing' | 'processingPhase'>,
): boolean {
	return (
		(entry.processingPhase === null ||
			entry.processingPhase === 'running' ||
			entry.processingPhase === 'stopping') &&
		entry.isProcessing === (entry.processingPhase !== null)
	);
}

/** Lists all chat sessions. */
export async function listChats(): Promise<ListChatsResponse> {
	const response = await apiGet<ListChatsResponse>('/api/v1/chats');
	if (
		!response ||
		!Array.isArray(response.sessions) ||
		response.sessions.some(
			(entry) =>
				!entry ||
				typeof entry !== 'object' ||
				typeof entry.isProcessing !== 'boolean' ||
				!hasConsistentProcessingPhase(entry),
		)
	) {
		throw new Error('Invalid chat list processing response');
	}
	return response;
}

export async function setLastSelectedChat(
	chatId: string | null,
): Promise<SetLastSelectedChatResponse> {
	const body: SetLastSelectedChatRequest = { chatId };
	return apiPut<SetLastSelectedChatResponse>('/api/v1/chats/last-selected', body);
}

/** Starts a new chat session. */
export async function startChat(
	params: StartChatParams,
): Promise<StartChatCommandResponse & { chat: ChatListEntry }> {
	const { permissionMode, thinkingMode, ...rest } = params;
	const response = await apiPost<StartChatCommandResponse>('/api/v1/chats/start', {
		...rest,
		permissionMode: normalizePermissionMode(permissionMode),
		thinkingMode: normalizeThinkingMode(thinkingMode),
	});
	if (!response.chat) {
		throw new ApiError(
			410,
			'The chat was deleted before the recovered start response was received',
			'SESSION_NOT_FOUND',
		);
	}
	return { ...response, chat: response.chat };
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

export async function forkRunChat(params: ForkRunCommandRequest): Promise<ForkRunCommandResponse> {
	return apiPost<ForkRunCommandResponse>('/api/v1/chats/fork-run', params);
}

export async function stopChat(params: AgentStopCommandRequest): Promise<AgentStopResponse> {
	return withParsedStopOutcome(await apiPost<AgentStopResponse>('/api/v1/chats/stop', params));
}

export async function interruptAndSendChat(
	params: AgentInterruptAndSendCommandRequest,
): Promise<AgentInterruptAndSendResponse> {
	return withParsedStopOutcome(
		await apiPost<AgentInterruptAndSendResponse>('/api/v1/chats/interrupt-and-send', params),
	);
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
	return withParsedControl(
		await apiPost<QueueEntryCommandResponse>('/api/v1/chats/queue/entries', params),
	);
}

export async function replaceQueuedInput(
	params: QueueEntryReplaceCommandRequest,
): Promise<QueueEntryCommandResponse> {
	return withParsedControl(
		await apiPut<QueueEntryCommandResponse>('/api/v1/chats/queue/entries', params),
	);
}

export async function deleteQueuedInput(
	params: QueueEntryDeleteCommandRequest,
): Promise<QueueEntryDeleteResponse> {
	return withParsedControl(
		await apiDelete<QueueEntryDeleteResponse>('/api/v1/chats/queue/entries', params),
	);
}

export async function moveQueuedInput(
	params: QueueEntryMoveCommandRequest,
): Promise<QueueEntryCommandResponse> {
	return withParsedControl(
		await apiPut<QueueEntryCommandResponse>('/api/v1/chats/queue/entries/move', params),
	);
}

export async function submitGoalControl(
	params: GoalControlCommandRequest,
): Promise<GoalControlCommandResponse> {
	return withParsedControl(
		await apiPost<GoalControlCommandResponse>('/api/v1/chats/goal-control', params),
	);
}

export async function steerChat(params: SteerCommandRequest): Promise<SteerCommandResponse> {
	return apiPost<SteerCommandResponse>('/api/v1/chats/steer', params);
}

export async function getChatExecutionControl(
	chatId: string,
): Promise<{ success: true; chatId: string; control: ChatExecutionControlState }> {
	return withParsedControl(
		await apiGet<{
			success: true;
			chatId: string;
			control: ChatExecutionControlState;
		}>(`/api/v1/chats/queue?chatId=${encodeURIComponent(chatId)}`),
	);
}

export async function clearChatQueue(chatId: string): Promise<QueueMutationResponse> {
	return withParsedControl(
		await apiPost<QueueMutationResponse>('/api/v1/chats/queue/clear', { chatId }),
	);
}

export async function pauseChatQueue(chatId: string): Promise<QueueMutationResponse> {
	const request: QueuePauseRequest = { chatId };
	return withParsedControl(
		await apiPost<QueueMutationResponse>('/api/v1/chats/queue/pause', request),
	);
}

export async function resumeChatQueue(
	chatId: string,
	pauseId: string,
): Promise<QueueMutationResponse> {
	const request: QueueResumeRequest = { chatId, pauseId };
	return withParsedControl(
		await apiPost<QueueMutationResponse>('/api/v1/chats/queue/resume', request),
	);
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
	generationId?: string;
}

/** Forks (clones) an existing chat session into a new chat. */
export async function forkChat(params: ForkChatParams): Promise<ForkChatResponse> {
	return apiPost<ForkChatResponse>('/api/v1/chats/fork', params);
}

/** Persists a chat placement within its server-resolved section. */
export async function reorderChat(request: ReorderChatRequest): Promise<ReorderChatResponse> {
	const response = await apiPost<unknown>('/api/v1/chats/reorder', request);
	const parsed = parseReorderChatResponse(response);
	if (!parsed) throw new Error('Invalid chat reorder response');
	return parsed;
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
