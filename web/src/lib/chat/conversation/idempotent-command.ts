import { ApiError, isIntermediaryResponse } from '$lib/api/client.js';
import type { CommandErrorCode } from '$shared/chat-command-contracts';

const OUTCOME_UNKNOWN_ERROR_CODES = new Set<string>(
	['STEER_OUTCOME_UNKNOWN'] satisfies CommandErrorCode[],
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

function isStructuredOutcomeUnknownFailure(error: unknown): boolean {
	return error instanceof ApiError && OUTCOME_UNKNOWN_ERROR_CODES.has(error.errorCode ?? '');
}

function isLostReply(error: unknown): boolean {
	return !(error instanceof ApiError) || isIntermediaryResponse(error);
}

// The server refuses these before it looks up the command, so after a lost reply they say
// nothing about what the first attempt did.
function isAdmissionRefusal(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		(error.status === 401 ||
			error.status === 403 ||
			error.status === 429 ||
			error.errorCode === 'SERVER_SHUTTING_DOWN')
	);
}

/**
 * Retries one lost reply with the caller's unchanged command identity, for commands whose
 * server answers a repeated identity from its record of the first attempt or rejects it as
 * stale. The command's answer to the retry is then authoritative; a second lost reply or an
 * admission refusal leaves the outcome unknown.
 */
export async function submitReplayedCommand<T>(submit: () => Promise<T>): Promise<T> {
	try {
		return await submit();
	} catch (firstError) {
		if (!isLostReply(firstError)) throw firstError;
		try {
			return await submit();
		} catch (secondError) {
			if (!isLostReply(secondError) && !isAdmissionRefusal(secondError)) throw secondError;
			throw new CommandOutcomeUnknownError({ cause: secondError });
		}
	}
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
				cause:
					isStructuredOutcomeUnknownFailure(firstError) || !isAmbiguousCommandFailure(secondError)
						? firstError
						: secondError,
			});
		}
	}
}
