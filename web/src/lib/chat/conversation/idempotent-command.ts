import { ApiError } from '$lib/api/client.js';
import type { CommandErrorCode } from '$shared/chat-command-contracts';

const OUTCOME_UNKNOWN_ERROR_CODES = new Set<string>(
	['ACTIVE_INPUT_OUTCOME_UNKNOWN'] satisfies CommandErrorCode[],
);
const DEFINITIVE_ERROR_CODES = new Set<string>(
	['ACTIVE_INPUT_NOT_DELIVERED'] satisfies CommandErrorCode[],
);

export class CommandOutcomeUnknownError extends Error {
	constructor(options?: ErrorOptions) {
		super('The command outcome could not be confirmed', options);
		this.name = 'CommandOutcomeUnknownError';
	}
}

function isAmbiguousCommandFailure(error: unknown): boolean {
	if (!(error instanceof ApiError)) return true;
	if (error.errorCode && DEFINITIVE_ERROR_CODES.has(error.errorCode)) return false;
	return error.status >= 500
		|| (error.errorCode !== undefined && OUTCOME_UNKNOWN_ERROR_CODES.has(error.errorCode));
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
