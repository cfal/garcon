import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { CommandOutcomeUnknownError, submitIdempotentCommand } from '../idempotent-command.js';

describe('submitIdempotentCommand', () => {
	it('retries one ambiguous transport failure with the same submission callback', async () => {
		const submit = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('connection closed'))
			.mockResolvedValueOnce({ status: 'duplicate' });

		await expect(submitIdempotentCommand(submit)).resolves.toEqual({ status: 'duplicate' });
		expect(submit).toHaveBeenCalledTimes(2);
	});

	it('does not retry a definitive command rejection', async () => {
		const error = new ApiError(409, 'busy', 'SESSION_BUSY', undefined, true);
		const submit = vi.fn().mockRejectedValue(error);

		await expect(submitIdempotentCommand(submit)).rejects.toBe(error);
		expect(submit).toHaveBeenCalledOnce();
	});

	it('does not retry a typed definitive non-delivery returned as a server error', async () => {
		const error = new ApiError(
			500,
			'Active input was not delivered',
			'ACTIVE_INPUT_NOT_DELIVERED',
			undefined,
			true,
		);
		const submit = vi.fn().mockRejectedValue(error);

		await expect(submitIdempotentCommand(submit)).rejects.toBe(error);
		expect(submit).toHaveBeenCalledOnce();
	});

	it('reports an unknown outcome after two ambiguous responses', async () => {
		const submit = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(500, 'server failed', 'INTERNAL_ERROR'))
			.mockRejectedValueOnce(
				new ApiError(409, 'accepted outcome unknown', 'ACTIVE_INPUT_OUTCOME_UNKNOWN'),
			);

		await expect(submitIdempotentCommand(submit)).rejects.toBeInstanceOf(
			CommandOutcomeUnknownError,
		);
		expect(submit).toHaveBeenCalledTimes(2);
	});
});
