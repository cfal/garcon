import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import {
	CommandOutcomeUnknownError,
	submitIdempotentCommand,
	submitReplayedCommand,
} from '../idempotent-command.js';

describe('submitReplayedCommand', () => {
	it('retries one lost reply with the same submission callback', async () => {
		const submit = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('connection reset'))
			.mockResolvedValueOnce({ status: 'duplicate' });

		await expect(submitReplayedCommand(submit)).resolves.toEqual({ status: 'duplicate' });
		expect(submit).toHaveBeenCalledTimes(2);
	});

	it('does not retry any server answer, including a coded server error', async () => {
		for (const error of [
			new ApiError(500, 'could not be confirmed', 'PERMISSION_DECISION_OUTCOME_UNKNOWN'),
			new ApiError(503, 'not sent', 'PERMISSION_DECISION_NOT_DELIVERED', undefined, true),
			new ApiError(409, 'stale', 'PERMISSION_NOT_ACTIONABLE'),
		]) {
			const submit = vi.fn().mockRejectedValue(error);

			await expect(submitReplayedCommand(submit)).rejects.toBe(error);
			expect(submit).toHaveBeenCalledOnce();
		}
	});

	it('reports the retried server answer after a lost reply', async () => {
		const answer = new ApiError(503, 'not sent', 'PERMISSION_DECISION_NOT_DELIVERED', undefined, true);
		const submit = vi
			.fn()
			.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
			.mockRejectedValueOnce(answer);

		await expect(submitReplayedCommand(submit)).rejects.toBe(answer);
		expect(submit).toHaveBeenCalledTimes(2);
	});

	it('keeps the outcome unknown when the retry is refused before the command runs', async () => {
		for (const refusal of [
			new ApiError(503, 'The server is shutting down', 'SERVER_SHUTTING_DOWN', undefined, true),
			new ApiError(401, 'Invalid token', 'VALIDATION_FAILED'),
			new ApiError(429, 'Too many requests', 'RATE_LIMITED', undefined, true),
		]) {
			const submit = vi
				.fn()
				.mockRejectedValueOnce(new TypeError('connection reset'))
				.mockRejectedValueOnce(refusal);

			const rejection = await submitReplayedCommand(submit).catch((error) => error);

			expect(rejection).toBeInstanceOf(CommandOutcomeUnknownError);
			expect((rejection as CommandOutcomeUnknownError).cause).toBe(refusal);
		}
	});

	it('reports an unknown outcome after two lost replies', async () => {
		const secondError = new ApiError(502, 'Bad Gateway');
		const submit = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('connection reset'))
			.mockRejectedValueOnce(secondError);

		const rejection = await submitReplayedCommand(submit).catch((error) => error);

		expect(rejection).toBeInstanceOf(CommandOutcomeUnknownError);
		expect((rejection as CommandOutcomeUnknownError).cause).toBe(secondError);
		expect(submit).toHaveBeenCalledTimes(2);
	});
});

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

	it('does not downgrade an explicit unknown outcome after a replacement server rejects retry', async () => {
		const firstError = new ApiError(500, 'accepted outcome unknown', 'STEER_OUTCOME_UNKNOWN');
		const submit = vi
			.fn()
			.mockRejectedValueOnce(firstError)
			.mockRejectedValueOnce(new ApiError(404, 'Session not found', 'SESSION_NOT_FOUND'));

		const rejection = await submitIdempotentCommand(submit).catch((error) => error);

		expect(rejection).toBeInstanceOf(CommandOutcomeUnknownError);
		if (!(rejection instanceof CommandOutcomeUnknownError)) {
			throw new Error('Expected an unknown command outcome');
		}
		expect(rejection.cause).toBe(firstError);
		expect(submit).toHaveBeenCalledTimes(2);
	});

	it('retains a structured unknown outcome when its retry also loses the response', async () => {
		const firstError = new ApiError(
			500,
			'accepted outcome unknown',
			'STEER_OUTCOME_UNKNOWN',
			undefined,
			false,
			{
				success: false,
				error: 'accepted outcome unknown',
				errorCode: 'STEER_OUTCOME_UNKNOWN',
				retryable: false,
				deliveryOutcome: 'unknown',
				control: { serverInstanceId: 'server-a' },
			},
		);
		const submit = vi
			.fn()
			.mockRejectedValueOnce(firstError)
			.mockRejectedValueOnce(new TypeError('retry response lost'));

		const rejection = await submitIdempotentCommand(submit).catch((error) => error);

		expect(rejection).toBeInstanceOf(CommandOutcomeUnknownError);
		if (!(rejection instanceof CommandOutcomeUnknownError)) {
			throw new Error('Expected an unknown command outcome');
		}
		expect(rejection.cause).toBe(firstError);
		expect(submit).toHaveBeenCalledTimes(2);
	});

	it('does not downgrade a lost first response after a replacement server rejects retry', async () => {
		const firstError = new TypeError('connection reset after send');
		const submit = vi
			.fn()
			.mockRejectedValueOnce(firstError)
			.mockRejectedValueOnce(
				new ApiError(404, 'Queued entry not found', 'QUEUE_ENTRY_NOT_FOUND', undefined, false, {
					success: false,
					error: 'Queued entry not found',
					errorCode: 'QUEUE_ENTRY_NOT_FOUND',
					retryable: false,
					deliveryOutcome: 'not-sent',
					control: { serverInstanceId: 'replacement-server' },
				}),
			);

		const rejection = await submitIdempotentCommand(submit).catch((error) => error);

		expect(rejection).toBeInstanceOf(CommandOutcomeUnknownError);
		if (!(rejection instanceof CommandOutcomeUnknownError)) {
			throw new Error('Expected an unknown command outcome');
		}
		expect(rejection.cause).toBe(firstError);
		expect(submit).toHaveBeenCalledTimes(2);
	});
});
