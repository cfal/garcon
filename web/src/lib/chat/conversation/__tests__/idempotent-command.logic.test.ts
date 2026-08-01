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
			'Steering input was not delivered',
			'STEER_NOT_DELIVERED',
			undefined,
			true,
		);
		const submit = vi.fn().mockRejectedValue(error);

		await expect(submitIdempotentCommand(submit)).rejects.toBe(error);
		expect(submit).toHaveBeenCalledOnce();
	});

	it('does not retry a structured shutdown response', async () => {
		const error = new ApiError(
			503,
			'The server is shutting down',
			'SERVER_SHUTTING_DOWN',
		);
		const submit = vi.fn().mockRejectedValue(error);

		await expect(submitIdempotentCommand(submit)).rejects.toBe(error);
		expect(submit).toHaveBeenCalledOnce();
	});

	it('still probes an unstructured server failure once', async () => {
		const submit = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(500, 'upstream failed'))
			.mockResolvedValueOnce({ status: 'duplicate' });

		await expect(submitIdempotentCommand(submit)).resolves.toEqual({ status: 'duplicate' });
		expect(submit).toHaveBeenCalledTimes(2);
	});

	it('still probes a coded generic server failure once', async () => {
		const submit = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(500, 'response lost', 'INTERNAL_ERROR'))
			.mockResolvedValueOnce({ status: 'duplicate' });

		await expect(submitIdempotentCommand(submit)).resolves.toEqual({ status: 'duplicate' });
		expect(submit).toHaveBeenCalledTimes(2);
	});

	it('reports an unknown outcome after two ambiguous responses', async () => {
		const submit = vi
			.fn()
			.mockRejectedValueOnce(
				new ApiError(500, 'accepted outcome unknown', 'STEER_OUTCOME_UNKNOWN'),
			)
			.mockRejectedValueOnce(
				new ApiError(500, 'accepted outcome unknown', 'STEER_OUTCOME_UNKNOWN'),
			);

		await expect(submitIdempotentCommand(submit)).rejects.toBeInstanceOf(
			CommandOutcomeUnknownError,
		);
		expect(submit).toHaveBeenCalledTimes(2);
	});
});
