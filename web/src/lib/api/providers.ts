// Provider API for auth status.

import { apiGet } from './client.js';

export type ProviderName = 'claude' | 'codex' | 'opencode' | 'amp';

export interface ProviderAuthStatus {
	authenticated: boolean;
	status?: string;
	message?: string;
	[key: string]: unknown;
}

/** Fetches the auth/connection status for a provider. */
export async function getAuthStatus(provider: ProviderName): Promise<ProviderAuthStatus> {
	return apiGet<ProviderAuthStatus>(`/api/v1/${provider}/auth/status`);
}
