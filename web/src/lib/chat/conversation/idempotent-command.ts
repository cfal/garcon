import { ApiError } from '$lib/api/client.js';
import type { CommandErrorCode } from '$shared/chat-command-contracts';

const OUTCOME_UNKNOWN_ERROR_CODES = new Set<string>(
	['STEER_OUTCOME_UNKNOWN', 'GOAL_CONTROL_OUTCOME_UNKNOWN'] satisfies CommandErrorCode[],
);
const DEFINITIVE_ERROR_CODES = new Set<string>(
	[
		'SERVER_SHUTTING_DOWN',
		'STEER_NOT_DELIVERED',
		'STEER_PROVIDER_REJECTED',
		'STEER_TURN_UNAVAILABLE',
		'STEER_TURN_CHANGED',
		'STEER_TURN_NOT_STEERABLE',
		'STEER_CAPACITY_EXHAUSTED',
		'QUEUE_STEER_FINALIZATION_FAILED',
		'QUEUE_STEER_RECOVERY_FAILED',
		'GOAL_CONTROL_NOT_DELIVERED',
	] satisfies CommandErrorCode[],
);
export class CommandOutcomeUnknownError extends Error {
	constructor(options?: ErrorOptions) {
		super('The command outcome could not be confirmed', options);
		this.name = 'CommandOutcomeUnknownError';
	}
}

function isAmbiguousCommandFailure(error: unknown): boolean {
	if (!(error instanceof ApiError)) return true;
	if (error.errorCode !== undefined) {
		if (OUTCOME_UNKNOWN_ERROR_CODES.has(error.errorCode)) return true;
		if (DEFINITIVE_ERROR_CODES.has(error.errorCode)) return false;
	}
	return error.status >= 500;
}

/** Retries one ambiguous transport outcome with the caller's unchanged command identity. */
export async function submitIdempotentCommand<T>(submit: () => Promise<T>): Promise<T> {
	try {
		return await submit();
	} catch (firstError) {
		if (!isAmbiguousCommandFailure(firstError)) throw firstError;
		try {
			return await submit();
		} catch (secondError) {
			throw new CommandOutcomeUnknownError({
				cause: isAmbiguousCommandFailure(secondError) ? secondError : firstError,
			});
		}
	}
}
