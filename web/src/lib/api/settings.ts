// App settings API for session naming and global settings.

import { apiGet, apiPut } from './client.js';

export interface AppSettings {
	[key: string]: unknown;
}

export interface UpdateSessionNameResponse {
	success: boolean;
}

/** Renames a chat session. */
export async function updateSessionName(chatId: string, title: string): Promise<UpdateSessionNameResponse> {
	return apiPut<UpdateSessionNameResponse>('/api/v1/app/session-name', { chatId, title });
}

/** Fetches the current application settings. */
export async function getSettings(): Promise<AppSettings> {
	return apiGet<AppSettings>('/api/v1/app/settings');
}

export interface UpdateSettingsResponse {
	success: boolean;
}

/** Applies a partial update to application settings. */
export async function updateSettings(patch: Record<string, unknown>): Promise<UpdateSettingsResponse> {
	return apiPut<UpdateSettingsResponse>('/api/v1/app/settings', patch);
}
