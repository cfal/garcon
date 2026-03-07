// Chat session API for listing, starting, messaging, and managing chats.

import { apiGet, apiPost, apiDelete } from './client.js';
import type { ChatSession } from '$lib/types/session.js';
import type { SessionProvider } from '$lib/types/app.js';
import type { PermissionMode, ThinkingMode } from '$shared/chat-modes';

export interface StartChatParams {
	chatId: string;
	provider: SessionProvider;
	projectPath: string;
	model: string;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
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

export interface ListChatsResponse {
	sessions: ChatSession[];
	total: number;
}

/** Lists all chat sessions. */
export async function listChats(): Promise<ListChatsResponse> {
	return apiGet<ListChatsResponse>('/api/v1/chats');
}

export interface StartChatResponse {
	success: boolean;
	chatId?: string;
}

/** Starts a new chat session. */
export async function startChat(params: StartChatParams): Promise<StartChatResponse> {
	const { options = {}, tags = [], ...rest } = params;
	return apiPost<StartChatResponse>('/api/v1/chats/start', { ...rest, options, tags });
}

export interface DeleteChatResponse {
	success: boolean;
}

/** Deletes a chat session. */
export async function deleteChat(chatId: string): Promise<DeleteChatResponse> {
	return apiDelete<DeleteChatResponse>(`/api/v1/chats?chatId=${encodeURIComponent(chatId)}`);
}

/** Fetches detailed chat metadata for sidebar details dialog. */
export async function getChatDetails(chatId: string): Promise<ChatDetailsResponse> {
	return apiGet<ChatDetailsResponse>(`/api/v1/chats/details?chatId=${encodeURIComponent(chatId)}`);
}

/** Toggles the pinned state of a chat session. */
export async function togglePinned(chatId: string): Promise<{ success: boolean; isPinned: boolean }> {
	return apiPost(`/api/v1/chats/pin?chatId=${encodeURIComponent(chatId)}`);
}

export interface ToggleArchiveResponse {
	success: boolean;
	isArchived: boolean;
}

/** Toggles the archived state of a chat session. */
export async function toggleArchive(chatId: string): Promise<ToggleArchiveResponse> {
	return apiPost<ToggleArchiveResponse>(`/api/v1/chats/archive?chatId=${encodeURIComponent(chatId)}`);
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
	valid: boolean;
	isGitRepo?: boolean;
	error?: string;
	errorCode?: ValidateStartErrorCode;
}

export async function validateStart(path: string): Promise<ValidateStartResponse> {
	return apiGet<ValidateStartResponse>(`/api/v1/chats/validate-start?path=${encodeURIComponent(path)}`);
}

export interface ForkChatParams {
	sourceChatId: string;
	chatId: string;
}

export interface ForkChatResponse {
	success: boolean;
	sourceChatId: string;
	chatId: string;
	provider: string;
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

export interface ReorderQuickRequest {
	chatId: string;
	chatIdAbove?: string;
	chatIdBelow?: string;
}

/** Persists a window reorder within a group. */
export async function reorderChats(body: ReorderChatsRequest): Promise<{ success: boolean }> {
	return apiPost('/api/v1/chats/reorder', body);
}

/** Moves a single chat relative to a neighbor within the same group. */
export async function reorderChatsQuick(body: ReorderQuickRequest): Promise<{ success: boolean }> {
	return apiPost('/api/v1/chats/reorder-quick', body);
}
