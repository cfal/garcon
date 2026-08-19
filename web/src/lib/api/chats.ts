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
import {
	parseChatSnapshotResponse,
	type ChatSnapshotResponse,
} from '$shared/chat-snapshot';
import type { ApiProtocol } from '$shared/api-providers';
import {
	CHAT_MESSAGES_MAX_LIMIT,
	isRelationallyValidBoundedTranscriptPage,
	isRelationallyValidTranscriptPage,
	parseChatHistoryState,
	parseResendCandidates,
	parseTranscriptMessages,
	type ChatHistoryResponse,
	type TranscriptMessage,
} from '$shared/chat-view';
import type {
	ChatListEntry,
	ChatListResponse,
	MarkChatsReadEntry,
	MarkChatsReadRequest,
	MarkChatsReadResponse,
	SetLastSelectedChatRequest,
	SetLastSelectedChatResponse,
} from '$shared/chat-list';
import type {
	AgentInterruptAndSendCommandRequest,
	AgentInterruptAndSendResponse,
	AgentRunCommandRequest,
	AgentTurnCommandResponse,
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
	QueueEntrySteerCommandRequest,
	QueueEntrySteerCommandResponse,
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
	ChatSearchNavigateRequest,
	ChatSearchNavigateResponse,
	ChatSearchRequest,
	ChatSearchResponse,
	TranscriptSearchStatusResponse,
} from '$shared/chat-search';
import type { ChatDetailsResponse } from '$shared/chat-details';
import {
	parseChatExecutionControlState,
	parseExecutionControlServerInstanceId,
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
const AGENT_HANDOFF_TIMEOUT_MS = 10 * 60_000;

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

export async function runChat(params: AgentRunCommandRequest): Promise<AgentTurnCommandResponse> {
	const response = await apiPost<AgentTurnCommandResponse>(
		'/api/v1/chats/run',
		params,
		params.handoff ? { timeoutMs: AGENT_HANDOFF_TIMEOUT_MS } : undefined,
	);
	if (params.handoff && !response.chat) {
		throw new Error('Invalid handoff response: durable chat projection is missing');
	}
	return response;
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

import type { SelfHandoffRunCommandRequest } from '$shared/self-handoff-contracts';

export async function selfHandoffRunChat(
	params: SelfHandoffRunCommandRequest,
): Promise<ForkRunCommandResponse> {
	return apiPost<ForkRunCommandResponse>('/api/v1/chats/handoff-run', params);
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

export async function getChatSnapshot(
	chatId: string,
	messageLimit = 1,
): Promise<ChatSnapshotResponse> {
	const value = await apiGet<unknown>(
		`/api/v1/chats/snapshot?chatId=${encodeURIComponent(chatId)}&limit=${messageLimit}`,
	);
	return parseChatSnapshotResponse(value);
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

export async function steerQueuedEntry(
	params: QueueEntrySteerCommandRequest,
): Promise<QueueEntrySteerCommandResponse> {
	const response = await apiPost<QueueEntrySteerCommandResponse>(
		'/api/v1/chats/queue/entries/steer',
		params,
	);
	const serverInstanceId = parseExecutionControlServerInstanceId(response.serverInstanceId);
	if (!serverInstanceId) throw new Error('Invalid queued steer server instance response');
	if (!response.control) return { ...response, serverInstanceId };
	const control = parseChatExecutionControlState(response.control);
	if (!control) throw new Error('Invalid queued steer execution control response');
	if (control.serverInstanceId !== serverInstanceId) {
		throw new Error('Mismatched queued steer server instance response');
	}
	return { ...response, serverInstanceId, control };
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
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Invalid chat messages page: ${fieldName}`);
	}
	return value;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`Invalid chat messages page: ${fieldName}`);
	}
	return value;
}

function requireNullablePositiveInteger(value: unknown, fieldName: string): number | null {
	return value === null ? null : requirePositiveInteger(value, fieldName);
}

export type ChatMessagesRequest = {
	chatId: string;
	limit?: number;
} & (
	| { beforeOrdinal?: undefined; transcriptViewId?: string }
	| { beforeOrdinal: number; transcriptViewId: string }
);

interface ValidatedChatMessagesPage {
	chatId: string;
	transcriptViewId: string;
	messages: TranscriptMessage[];
	lastOrdinal: number;
	pageOldestOrdinal: number;
	pageNewestOrdinal: number;
	nextBeforeOrdinal: number | null;
	hasMore: boolean;
	limit: number;
}

function invalidChatMessagesPage(reason: string): never {
	throw new Error(`Invalid chat messages page: ${reason}`);
}

function validateChatMessagesPage(
	request: ChatMessagesRequest,
	page: ValidatedChatMessagesPage,
): void {
	if (page.chatId !== request.chatId) invalidChatMessagesPage('chatId does not match request');
	const expectedLimit = Math.min(request.limit ?? 50, CHAT_MESSAGES_MAX_LIMIT);
	if (page.limit !== expectedLimit) invalidChatMessagesPage('limit does not match request');
	if (
		request.transcriptViewId !== undefined
		&& page.transcriptViewId !== request.transcriptViewId
	) {
		invalidChatMessagesPage('transcriptViewId does not match request');
	}
	const effectiveBefore = Math.min(
		request.beforeOrdinal ?? page.lastOrdinal + 1,
		page.lastOrdinal + 1,
	);
	if (page.pageNewestOrdinal !== effectiveBefore - 1) {
		invalidChatMessagesPage('pageNewestOrdinal does not match the effective request boundary');
	}
	if (page.messages.length > page.limit) invalidChatMessagesPage('messages exceed limit');
	if (!isRelationallyValidTranscriptPage(page)) {
		invalidChatMessagesPage('ordinal relations are inconsistent');
	}
	if (!isRelationallyValidBoundedTranscriptPage(page, page.limit)) {
		invalidChatMessagesPage('raw continuation does not match the bounded interval');
	}
}

export async function getChatMessages(params: ChatMessagesRequest): Promise<ChatHistoryResponse> {
	const query = new URLSearchParams({
		chatId: params.chatId,
		limit: String(params.limit ?? 50),
	});
	if (params.beforeOrdinal !== undefined) {
		query.set('beforeOrdinal', String(params.beforeOrdinal));
	}
	if (params.transcriptViewId !== undefined) {
		query.set('transcriptViewId', params.transcriptViewId);
	}
	const response = await apiGet<{
		historyState?: unknown;
		chatId?: unknown;
		messages?: unknown;
		transcriptViewId?: unknown;
		lastOrdinal?: unknown;
		pageOldestOrdinal?: unknown;
		pageNewestOrdinal?: unknown;
		nextBeforeOrdinal?: unknown;
		resendCandidates?: unknown;
		hasMore?: unknown;
		limit?: unknown;
	}>(`/api/v1/chats/messages?${query.toString()}`);
	const historyState = parseChatHistoryState(response.historyState);
	if (historyState === null) throw new Error('Invalid chat messages page: historyState');
	const chatId = requireNonEmptyString(response.chatId, 'chatId');
	if (chatId !== params.chatId) invalidChatMessagesPage('chatId does not match request');
	if (historyState.kind !== 'complete') {
		if (!Array.isArray(response.messages) || response.messages.length !== 0) {
			throw new Error('Invalid unavailable chat history: messages');
		}
		for (const field of [
			'transcriptViewId',
			'lastOrdinal',
			'pageOldestOrdinal',
			'pageNewestOrdinal',
			'nextBeforeOrdinal',
			'hasMore',
			'limit',
		] as const) {
			if (response[field] !== undefined) {
				throw new Error(`Invalid unavailable chat history: ${field}`);
			}
		}
		return { historyState, chatId, messages: [] };
	}
	const messages = parseTranscriptMessages(response.messages);
	if (messages === null) throw new Error('Invalid chat messages page: messages');
	const resendCandidates = parseResendCandidates(response.resendCandidates);
	if (resendCandidates === null) {
		throw new Error('Invalid chat messages page: resendCandidates');
	}
	if (typeof response.hasMore !== 'boolean') {
		throw new Error('Invalid chat messages page: hasMore');
	}
	const page = {
		historyState,
		chatId,
		messages,
		resendCandidates,
		transcriptViewId: requireNonEmptyString(response.transcriptViewId, 'transcriptViewId'),
		lastOrdinal: requireNonNegativeInteger(response.lastOrdinal, 'lastOrdinal'),
		pageOldestOrdinal: requireNonNegativeInteger(response.pageOldestOrdinal, 'pageOldestOrdinal'),
		pageNewestOrdinal: requireNonNegativeInteger(response.pageNewestOrdinal, 'pageNewestOrdinal'),
		nextBeforeOrdinal: requireNullablePositiveInteger(
			response.nextBeforeOrdinal,
			'nextBeforeOrdinal',
		),
		hasMore: response.hasMore,
		limit: requirePositiveInteger(response.limit, 'limit'),
	};
	validateChatMessagesPage(params, page);
	return page;
}

// Resolves one search result to a browser ordinal under its composite content
// epoch. A stale result rejects with SEARCH_RESULT_STALE instead of scrolling
// to a possibly reused ordinal.
export async function navigateToSearchResult(
	request: ChatSearchNavigateRequest,
	options?: ApiFetchOptions,
): Promise<ChatSearchNavigateResponse> {
	const response = await apiPost<{ chatId?: unknown; ordinal?: unknown }>(
		'/api/v1/chats/search/navigate',
		request,
		options,
	);
	return {
		chatId: requireNonEmptyString(response.chatId, 'chatId'),
		ordinal: requirePositiveInteger(response.ordinal, 'ordinal'),
	};
}

export async function searchChatTranscripts(
	request: ChatSearchRequest,
	options?: ApiFetchOptions,
): Promise<ChatSearchResponse> {
	return apiPost<ChatSearchResponse>('/api/v1/chats/search', request, options);
}

export async function getTranscriptSearchStatus(
	options?: ApiFetchOptions,
): Promise<TranscriptSearchStatusResponse> {
	return apiGet<TranscriptSearchStatusResponse>('/api/v1/chats/search/status', options);
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
	upToOrdinal?: number;
	transcriptViewId?: string;
	// Set only after the user confirms a handoff fork, so an unconfirmed request still
	// surfaces the refusal the confirmation is asked about.
	allowHandoffFork?: boolean;
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
