import type { GhStatusResponse } from '$shared/gh';
import { apiGet } from './client.js';

export type { GhStatusResponse };

export async function getGhStatus(): Promise<GhStatusResponse> {
	return apiGet<GhStatusResponse>('/api/v1/gh/status');
}
