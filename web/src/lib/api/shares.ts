// API client for chat sharing endpoints.

import { apiPost, apiDelete, parseApiResponse, publicApiFetch } from './client.js';
import type {
	ShareChatResponse,
	GetSharedChatResponse,
	RevokeShareResponse,
} from '$shared/share-types';

/** Creates or returns an existing share for a chat. */
export async function shareChat(chatId: string): Promise<ShareChatResponse> {
	return apiPost<ShareChatResponse>('/api/v1/chats/share', { chatId });
}

/** Revokes a shared chat link. */
export async function revokeShare(chatId: string): Promise<RevokeShareResponse> {
	return apiDelete<RevokeShareResponse>(`/api/v1/chats/share?chatId=${encodeURIComponent(chatId)}`);
}

/** Fetches a bounded page of a shared chat snapshot (public, no auth). */
export async function getSharedChat(
	token: string,
	before?: number,
	version?: string | null,
): Promise<GetSharedChatResponse> {
	const params = new URLSearchParams({ token, limit: '200' });
	if (before !== undefined) params.set('before', String(before));
	if (version) params.set('version', version);
	const response = await publicApiFetch(`/api/v1/shared?${params.toString()}`);
	return parseApiResponse<GetSharedChatResponse>(response);
}
