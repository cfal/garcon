// App settings API for session naming, remote settings, and sidebar management.

import { apiGet, apiPut, apiPost, apiDelete } from './client.js';
import {
	type RemoteSettingsSnapshot,
	type UpdateRemoteSettingsInput,
	normalizeRemoteSettingsSnapshot,
} from '$shared/settings';

export interface UpdateSessionNameResponse {
	success: boolean;
}

/** Renames a chat session. */
export async function updateSessionName(chatId: string, title: string): Promise<UpdateSessionNameResponse> {
	return apiPut<UpdateSessionNameResponse>('/api/v1/app/session-name', { chatId, title });
}

/** Fetches the current remote settings snapshot. */
export async function getRemoteSettings(): Promise<RemoteSettingsSnapshot> {
	const payload = await apiGet<unknown>('/api/v1/app/settings');
	const snapshot = normalizeRemoteSettingsSnapshot(payload);
	if (!snapshot) {
		throw new Error('Invalid remote settings response');
	}
	return snapshot;
}

export interface UpdateRemoteSettingsResponse {
	success: boolean;
	settings: RemoteSettingsSnapshot;
}

/** Applies a partial update to remote settings and returns the canonical snapshot. */
export async function updateRemoteSettings(
	patch: UpdateRemoteSettingsInput,
): Promise<UpdateRemoteSettingsResponse> {
	const payload = await apiPut<UpdateRemoteSettingsResponse>('/api/v1/app/settings', patch);
	const snapshot = normalizeRemoteSettingsSnapshot(payload.settings);
	if (!snapshot) {
		throw new Error('Invalid remote settings update response');
	}
	return { ...payload, settings: snapshot };
}

export interface TelegramTestResponse {
	success: boolean;
	error?: string;
}

/** Sends a test Telegram notification. */
export async function sendTelegramTest(chatId: string): Promise<TelegramTestResponse> {
	return apiPost<TelegramTestResponse>('/api/v1/app/telegram/test', { chatId });
}

export interface SavedChatSearch {
	id: string;
	title: string | null;
	query: string;
	showAsSidebarPill: boolean;
	showInSidebarMenu: boolean;
	showInSearchDialog: boolean;
	createdAt: string;
	updatedAt: string;
}

export async function getSavedSearches(): Promise<{ savedSearches: SavedChatSearch[] }> {
	return apiGet('/api/v1/app/saved-searches');
}

export async function createSavedSearch(
	input: Pick<
		SavedChatSearch,
		'title' | 'query' | 'showAsSidebarPill' | 'showInSidebarMenu' | 'showInSearchDialog'
	>
): Promise<{ success: boolean; savedSearch: SavedChatSearch }> {
	return apiPost('/api/v1/app/saved-searches', input);
}

export async function updateSavedSearch(
	id: string,
	patch: Partial<
		Pick<
			SavedChatSearch,
			'title' | 'query' | 'showAsSidebarPill' | 'showInSidebarMenu' | 'showInSearchDialog'
		>
	>
): Promise<{ success: boolean; savedSearch: SavedChatSearch }> {
	return apiPut('/api/v1/app/saved-searches', { id, ...patch });
}

export async function deleteSavedSearch(id: string): Promise<{ success: boolean }> {
	return apiDelete(`/api/v1/app/saved-searches?id=${encodeURIComponent(id)}`);
}

export async function reorderSavedSearches(
	oldOrder: string[],
	newOrder: string[]
): Promise<{ success: boolean }> {
	return apiPut('/api/v1/app/saved-searches/reorder', { oldOrder, newOrder });
}

export interface ChatFolderFilter {
	textTokens: string[];
	tags: string[];
	providers: string[];
	models: string[];
	status?: 'active' | 'unread';
}

export interface ChatFolder {
	id: string;
	name: string;
	filter: ChatFolderFilter;
	createdAt: string;
}

export interface FoldersResponse {
	folders: ChatFolder[];
}

export async function getFolders(): Promise<FoldersResponse> {
	return apiGet<FoldersResponse>('/api/v1/app/folders');
}

export async function createFolder(
	name: string,
	filter: ChatFolder['filter']
): Promise<{ success: boolean; folder: ChatFolder }> {
	return apiPost('/api/v1/app/folders', { name, filter });
}

export async function updateFolder(
	id: string,
	patch: Partial<Pick<ChatFolder, 'name' | 'filter'>>
): Promise<{ success: boolean; folder: ChatFolder }> {
	return apiPut('/api/v1/app/folders', { id, ...patch });
}

export async function deleteFolder(id: string): Promise<{ success: boolean }> {
	return apiDelete(`/api/v1/app/folders?id=${encodeURIComponent(id)}`);
}
