// Provider API for auth status and UI-initiated provider login.

import { apiGet, apiPost } from './client.js';

export type ProviderName = 'claude' | 'codex' | 'opencode' | 'amp' | 'factory';
export type BrowserLoginProviderName = 'claude' | 'codex';

export interface ProviderAuthStatus {
	authenticated: boolean;
	canReauth: boolean;
	label: string;
}

export interface DeviceAuthInfo {
	url: string;
	code: string;
}

export interface ProviderAuthLoginResult {
	launched: boolean;
	alreadyRunning: boolean;
	deviceAuth?: DeviceAuthInfo;
}

/** Fetches the auth/connection status for a provider. */
export async function getAuthStatus(provider: ProviderName): Promise<ProviderAuthStatus> {
	const result = await apiGet<Record<string, ProviderAuthStatus>>(`/api/v1/providers/auth?provider=${provider}`);
	return result[provider];
}

/** Launches the local provider login flow from the authenticated UI. */
export async function launchAuthLogin(provider: BrowserLoginProviderName): Promise<ProviderAuthLoginResult> {
	return apiPost<ProviderAuthLoginResult>(`/api/v1/${provider}/auth/login`);
}
