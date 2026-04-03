// API client for chat sharing endpoints.

import { apiGet, apiPost, apiDelete } from './client.js';
import type {
  ShareChatResponse,
  ShareStatusResponse,
  GetSharedChatResponse,
  RevokeShareResponse,
} from '$shared/share-types';

/** Creates or returns an existing share for a chat. */
export async function shareChat(chatId: string): Promise<ShareChatResponse> {
  return apiPost<ShareChatResponse>('/api/v1/chats/share', { chatId });
}

/** Checks the share status of a chat. */
export async function getShareStatus(chatId: string): Promise<ShareStatusResponse> {
  return apiGet<ShareStatusResponse>(
    `/api/v1/chats/share/status?chatId=${encodeURIComponent(chatId)}`,
  );
}

/** Revokes a shared chat link. */
export async function revokeShare(chatId: string): Promise<RevokeShareResponse> {
  return apiDelete<RevokeShareResponse>(
    `/api/v1/chats/share?chatId=${encodeURIComponent(chatId)}`,
  );
}

/** Fetches a shared chat snapshot (public, no auth). */
export async function getSharedChat(token: string): Promise<GetSharedChatResponse> {
  const response = await fetch(`/api/v1/shared?token=${encodeURIComponent(token)}`);
  if (!response.ok) {
    throw new Error(response.status === 404 ? 'Share not found' : 'Failed to load shared chat');
  }
  return response.json();
}
