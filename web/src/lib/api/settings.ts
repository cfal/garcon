// App settings API for session naming, remote settings, and sidebar management.

import { apiGet, apiPut, apiPost, apiDelete } from './client.js';
import {
	type RemoteSettingsSnapshot,
	type UpdateRemoteSettingsInput,
	normalizeRemoteSettingsSnapshot,
} from '$shared/settings';
import type {
	GenerationModelTestResponse,
	GenerationTestTarget,
} from '$shared/generation-test-contracts';

const GENERATION_MODEL_TEST_TIMEOUT_MS = 120_000;

export interface UpdateSessionNameResponse {
	success: boolean;
}

/** Renames a chat session. */
export async function updateSessionName(
	chatId: string,
	title: string,
): Promise<UpdateSessionNameResponse> {
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

/** Tests the saved effective model for a generation target. */
export async function testGenerationModel(
	target: GenerationTestTarget,
): Promise<GenerationModelTestResponse> {
	return apiPost<GenerationModelTestResponse>(
		'/api/v1/app/generation/test',
		{ target },
		{ timeoutMs: GENERATION_MODEL_TEST_TIMEOUT_MS },
	);
}

export interface TelegramTestResponse {
	success: boolean;
	error?: string;
}

export interface TelegramBotIdentity {
	id: number;
	username: string;
	firstName: string;
}

export interface TelegramSettingsMutationResponse {
	success: boolean;
	settings: RemoteSettingsSnapshot;
	error?: string;
}

export interface TelegramTokenTestResponse {
	success: boolean;
	bot: TelegramBotIdentity;
	error?: string;
}

export interface TelegramRecipientLinkResponse {
	success: boolean;
	linkUrl: string;
	settings: RemoteSettingsSnapshot;
	error?: string;
}

function normalizeTelegramSettingsMutationResponse(
	payload: TelegramSettingsMutationResponse,
): TelegramSettingsMutationResponse {
	const snapshot = normalizeRemoteSettingsSnapshot(payload.settings);
	if (!snapshot) {
		throw new Error('Invalid Telegram settings response');
	}
	return { ...payload, settings: snapshot };
}

/** Sends a test Telegram notification. */
export async function sendTelegramTest(): Promise<TelegramTestResponse> {
	return apiPost<TelegramTestResponse>('/api/v1/app/telegram/test');
}

/** Stores a Telegram bot token on the server. */
export async function saveTelegramBotToken(
	botToken: string,
): Promise<TelegramSettingsMutationResponse> {
	const payload = await apiPut<TelegramSettingsMutationResponse>('/api/v1/app/telegram/token', {
		botToken,
	});
	return normalizeTelegramSettingsMutationResponse(payload);
}

/** Tests a typed or saved Telegram bot token. */
export async function testTelegramBotToken(botToken?: string): Promise<TelegramTokenTestResponse> {
	return apiPost<TelegramTokenTestResponse>('/api/v1/app/telegram/token/test', {
		botToken: botToken ?? '',
	});
}

/** Clears the stored Telegram bot token from the server. */
export async function clearTelegramBotToken(): Promise<TelegramSettingsMutationResponse> {
	const payload = await apiDelete<TelegramSettingsMutationResponse>('/api/v1/app/telegram/token');
	return normalizeTelegramSettingsMutationResponse(payload);
}

/** Creates a Telegram deep link for the intended recipient. */
export async function beginTelegramRecipientLink(): Promise<TelegramRecipientLinkResponse> {
	const payload = await apiPost<TelegramRecipientLinkResponse>(
		'/api/v1/app/telegram/recipient/link',
	);
	const snapshot = normalizeRemoteSettingsSnapshot(payload.settings);
	if (!snapshot) {
		throw new Error('Invalid Telegram recipient link response');
	}
	return { ...payload, settings: snapshot };
}

/** Polls Telegram updates for the pending recipient deep link. */
export async function resolveTelegramRecipientLink(): Promise<TelegramSettingsMutationResponse> {
	const payload = await apiPost<TelegramSettingsMutationResponse>(
		'/api/v1/app/telegram/recipient/resolve',
		undefined,
		{ timeoutMs: 25_000 },
	);
	return normalizeTelegramSettingsMutationResponse(payload);
}

/** Clears the linked Telegram recipient. */
export async function clearTelegramRecipient(): Promise<TelegramSettingsMutationResponse> {
	const payload = await apiDelete<TelegramSettingsMutationResponse>(
		'/api/v1/app/telegram/recipient',
	);
	return normalizeTelegramSettingsMutationResponse(payload);
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
	>,
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
	>,
): Promise<{ success: boolean; savedSearch: SavedChatSearch }> {
	return apiPut('/api/v1/app/saved-searches', { id, ...patch });
}

export async function deleteSavedSearch(id: string): Promise<{ success: boolean }> {
	return apiDelete(`/api/v1/app/saved-searches?id=${encodeURIComponent(id)}`);
}

export async function reorderSavedSearches(
	oldOrder: string[],
	newOrder: string[],
): Promise<{ success: boolean }> {
	return apiPut('/api/v1/app/saved-searches/reorder', { oldOrder, newOrder });
}

export interface ChatFolderFilter {
	textTokens: string[];
	tags: string[][];
	agents: string[];
	models: string[];
	status?: 'active' | 'unread';
	project: string[];
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
	filter: ChatFolder['filter'],
): Promise<{ success: boolean; folder: ChatFolder }> {
	return apiPost('/api/v1/app/folders', { name, filter });
}

export async function updateFolder(
	id: string,
	patch: Partial<Pick<ChatFolder, 'name' | 'filter'>>,
): Promise<{ success: boolean; folder: ChatFolder }> {
	return apiPut('/api/v1/app/folders', { id, ...patch });
}

export async function deleteFolder(id: string): Promise<{ success: boolean }> {
	return apiDelete(`/api/v1/app/folders?id=${encodeURIComponent(id)}`);
}
