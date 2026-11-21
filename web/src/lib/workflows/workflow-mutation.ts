import { ApiError, isIntermediaryResponse } from '$lib/api/client';

export function isUnconfirmedWorkflowMutation(error: unknown): boolean {
	return !(error instanceof ApiError) || isIntermediaryResponse(error) || error.status >= 500;
}
