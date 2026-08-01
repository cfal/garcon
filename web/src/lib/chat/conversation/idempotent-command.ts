import { ApiError } from '$lib/api/client.js';
import type { CommandErrorCode } from '$shared/chat-command-contracts';

const OUTCOME_UNKNOWN_ERROR_CODES = new Set<string>(
	['STEER_OUTCOME_UNKNOWN', 'GOAL_CONTROL_OUTCOME_UNKNOWN'] satisfies CommandErrorCode[],
);
export class CommandOutcomeUnknownError extends Error {
	constructor(options?: ErrorOptions) {
		super('The command outcome could not be confirmed', options);
		this.name = 'CommandOutcomeUnknownError';
	}
}

function isAmbiguousCommandFailure(error: unknown): boolean {
	if (!(error instanceof ApiError)) return true;
	if (error.errorCode !== undefined) return OUTCOME_UNKNOWN_ERROR_CODES.has(error.errorCode);
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
			if (!isAmbiguousCommandFailure(secondError)) throw secondError;
			throw new CommandOutcomeUnknownError({ cause: secondError });
		}
	}
}
