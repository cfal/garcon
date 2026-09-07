import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { CommandOutcomeUnknownError } from '../idempotent-command.js';
import {
	settleSubmissionFailure,
	type SubmissionSettlementDeps,
} from '../submission-settlement.js';

function createDeps() {
	let currentRevision = 1;
	const restoreDraftIfRevision = vi.fn(
		(_chatId: string, expectedRevision: number, _text: string, _images: readonly File[]) =>
			expectedRevision === currentRevision,
	);
	const deps = {
		chatState: {
			appendLocalNoticeForChat: vi.fn(),
			clearOptimisticUserInput: vi.fn(),
		},
		composerState: {
			restoreDraftIfRevision,
		},
	} satisfies SubmissionSettlementDeps;
	return {
		...deps,
		setCurrentRevision(revision: number) {
			currentRevision = revision;
		},
	};
}

const failures = [
	{
		kind: 'unknown',
		error: () => new CommandOutcomeUnknownError(),
		outcome: 'unknown',
		clearsOptimistic: false,
		refreshes: true,
	},
	{
		kind: 'rejected',
		error: () => new ApiError(400, 'rejected', 'VALIDATION_FAILED'),
		outcome: 'rejected',
		clearsOptimistic: true,
		refreshes: false,
	},
	{
		kind: 'admission conflict',
		error: () => new ApiError(409, 'busy', 'SESSION_BUSY', undefined, true),
		outcome: 'rejected',
		clearsOptimistic: true,
		refreshes: true,
	},
] as const;

describe('settleSubmissionFailure', () => {
	for (const failure of failures) {
		for (const ownsComposer of [true, false]) {
			it(`${failure.kind} with composer ownership=${ownsComposer}`, async () => {
				const deps = createDeps();
				const refreshControl = vi.fn(async () => undefined);
				const onRejected = vi.fn();
				const result = await settleSubmissionFailure(
					deps,
					{
						chatId: 'chat-1',
						previousText: 'previous',
						previousImages: [],
						ownsComposer,
					},
					failure.error(),
					{
						clientMessageId: 'message-1',
						composerRevisionAfterClear: 1,
						unknownNotice: 'unknown notice',
						rejectedNotice: () => 'rejected notice',
						refreshOnAdmissionConflict: true,
						refreshControl,
						onRejected,
					},
				);

				expect(result).toBe(failure.outcome);
				expect(deps.chatState.clearOptimisticUserInput).toHaveBeenCalledTimes(
					failure.clearsOptimistic ? 1 : 0,
				);
				expect(refreshControl).toHaveBeenCalledTimes(failure.refreshes ? 1 : 0);
				const restores = ownsComposer && failure.outcome === 'rejected';
				expect(deps.composerState.restoreDraftIfRevision).toHaveBeenCalledTimes(restores ? 1 : 0);
				expect(onRejected).toHaveBeenCalledTimes(failure.outcome === 'rejected' ? 1 : 0);
				expect(deps.chatState.appendLocalNoticeForChat).toHaveBeenCalledWith(
					'chat-1',
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
				ownsComposer: true,
			},
			new Error('queue failed'),
			{
				unknownNotice: 'unknown',
				rejectedNotice: () => 'rejected',
				restoreRejected,
			},
		);

		expect(restoreRejected).toHaveBeenCalledOnce();
		expect(deps.composerState.restoreDraftIfRevision).not.toHaveBeenCalled();
	});

	it('preserves a newer draft when a cleared submission is rejected', async () => {
		const deps = createDeps();
		deps.setCurrentRevision(2);

		await settleSubmissionFailure(
			deps,
			{
				chatId: 'chat-1',
				previousText: 'submitted text',
				previousImages: [],
				ownsComposer: true,
			},
			new Error('request rejected'),
			{
				unknownNotice: 'unknown',
				rejectedNotice: () => 'rejected',
				composerRevisionAfterClear: 1,
			},
		);

		expect(deps.composerState.restoreDraftIfRevision).toHaveBeenCalledWith(
			'chat-1',
			1,
			'submitted text',
			[],
		);
		expect(deps.composerState.restoreDraftIfRevision).toHaveReturnedWith(false);
	});
});
