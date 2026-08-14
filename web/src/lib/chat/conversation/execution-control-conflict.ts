import { ApiError } from '$lib/api/client.js';

// A busy chat rejects an admission the caller can retry once its control state is refreshed,
// which reads differently from a permanent failure.
export function isExecutionControlAdmissionConflict(error: unknown): boolean {
	return (
		error instanceof ApiError
		&& error.retryable
		&& error.errorCode === 'SESSION_BUSY'
	);
}
