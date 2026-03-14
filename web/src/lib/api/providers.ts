// Provider API for auth status.

import { apiGet } from './client.js';

export type ProviderName = 'claude' | 'codex' | 'opencode' | 'amp';

export interface ProviderAuthStatus {
	authenticated: boolean;
	canReauth: boolean;
	label: string;
}

/** Fetches the auth/connection status for a provider. */
export async function getAuthStatus(provider: ProviderName): Promise<ProviderAuthStatus> {
	const result = await apiGet<Record<string, ProviderAuthStatus>>(`/api/v1/providers/auth?provider=${provider}`);
	return result[provider];
}
