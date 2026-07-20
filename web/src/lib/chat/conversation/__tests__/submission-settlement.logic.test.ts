import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { CommandOutcomeUnknownError } from '../idempotent-command.js';
import {
	settleSubmissionFailure,
	type SubmissionSettlementDeps,
} from '../submission-settlement.js';

function createDeps() {
	const deps = {
		chatState: {
			appendLocalNotice: vi.fn(),
			clearPendingUserInput: vi.fn(),
			updatePendingUserInputDeliveryStatus: vi.fn(),
		},
		composerState: {
			inputText: 'current',
			images: [] as File[],
			saveDraft: vi.fn(),
		},
	} satisfies SubmissionSettlementDeps;
	return deps;
}

const failures = [
	{
		kind: 'unknown',
		error: () => new CommandOutcomeUnknownError(),
		outcome: 'unknown',
		deliveryStatus: 'unconfirmed',
		clearsPending: false,
		refreshes: true,
	},
	{
		kind: 'rejected',
		error: () => new ApiError(400, 'rejected', 'VALIDATION_FAILED'),
		outcome: 'rejected',
		deliveryStatus: 'failed',
		clearsPending: false,
		refreshes: false,
	},
	{
		kind: 'admission conflict',
		error: () => new ApiError(409, 'busy', 'SESSION_BUSY', undefined, true),
		outcome: 'rejected',
		deliveryStatus: null,
		clearsPending: true,
		refreshes: true,
	},
] as const;

describe('settleSubmissionFailure', () => {
	for (const failure of failures) {
		for (const restoreComposerOnFailure of [true, false]) {
			it(`${failure.kind} with restore=${restoreComposerOnFailure}`, async () => {
				const deps = createDeps();
				const refreshControl = vi.fn(async () => undefined);
				const onRejected = vi.fn();
				const result = await settleSubmissionFailure(
					deps,
					{
						chatId: 'chat-1',
						previousText: 'previous',
						previousImages: [],
						restoreComposerOnFailure,
					},
					failure.error(),
					{
						clientRequestId: 'request-1',
						unknownNotice: 'unknown notice',
						rejectedNotice: () => 'rejected notice',
						clearPendingOnAdmissionConflict: true,
						refreshControl,
						onRejected,
					},
				);

				expect(result).toBe(failure.outcome);
				expect(deps.chatState.clearPendingUserInput).toHaveBeenCalledTimes(
					failure.clearsPending ? 1 : 0,
				);
				if (failure.deliveryStatus) {
					expect(deps.chatState.updatePendingUserInputDeliveryStatus).toHaveBeenCalledWith(
						'request-1',
						failure.deliveryStatus,
					);
				} else {
					expect(deps.chatState.updatePendingUserInputDeliveryStatus).not.toHaveBeenCalled();
				}
				expect(refreshControl).toHaveBeenCalledTimes(failure.refreshes ? 1 : 0);
				const restores = restoreComposerOnFailure && failure.outcome === 'rejected';
				expect(deps.composerState.inputText).toBe(restores ? 'previous' : 'current');
				expect(deps.composerState.saveDraft).toHaveBeenCalledTimes(restores ? 1 : 0);
				expect(onRejected).toHaveBeenCalledTimes(failure.outcome === 'rejected' ? 1 : 0);
				expect(deps.chatState.appendLocalNotice).toHaveBeenCalledWith(
					'error',
					failure.outcome === 'unknown' ? 'unknown notice' : 'rejected notice',
				);
			});
		}
	}

	it('delegates queue restoration without touching the composer directly', async () => {
		const deps = createDeps();
		const restoreRejected = vi.fn();

		await settleSubmissionFailure(
			deps,
			{
				chatId: 'chat-1',
				previousText: 'queued text',
				previousImages: [],
				restoreComposerOnFailure: true,
			},
			new Error('queue failed'),
			{
				unknownNotice: 'unknown',
				rejectedNotice: () => 'rejected',
				restoreRejected,
			},
		);

		expect(restoreRejected).toHaveBeenCalledOnce();
		expect(deps.composerState.inputText).toBe('current');
		expect(deps.composerState.saveDraft).not.toHaveBeenCalled();
	});
});
