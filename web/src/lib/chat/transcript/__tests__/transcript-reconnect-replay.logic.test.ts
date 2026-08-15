import { AssistantMessage } from '$shared/chat-types';
import { describe, expect, it } from 'vitest';
import {
	TranscriptReconnectReplayState,
	type TranscriptBufferedBatch,
	type TranscriptReplayApplyResult,
} from '../transcript-reconnect-replay.js';

const TIMESTAMP = '2026-08-15T00:00:00.000Z';

function batch(
	ordinal: number,
	content: string,
	overrides: Partial<TranscriptBufferedBatch> = {},
): TranscriptBufferedBatch {
	return {
		transcriptViewId: 'view-1',
		firstOrdinal: ordinal,
		lastOrdinal: ordinal,
		messages: [{ ordinal, message: new AssistantMessage(TIMESTAMP, content) }],
		noticeRevision: ordinal,
		resendCandidates: [{ ordinal, content: `resend-${content}`, attachmentNames: [] }],
		...overrides,
	};
}

describe('transcript reconnect replay state', () => {
	it('applies replay pages immediately and drains live batches in observed order', () => {
		const applied: Array<{ chatId: string; batch: TranscriptBufferedBatch }> = [];
		const replay = new TranscriptReconnectReplayState((chatId, appliedBatch) => {
			applied.push({ chatId, batch: appliedBatch });
			return 'applied';
		});
		const replayPage = batch(2, 'replay-page', { firstOrdinal: 1 });
		const firstLiveBatch = batch(3, 'first-live');
		const secondLiveBatch = batch(4, 'second-live');
		const token = replay.begin('chat-1', 'view-1');

		expect(replay.applyPage(token, 'chat-1', replayPage)).toBe('applied');
		expect(replay.buffer('chat-2', batch(1, 'other-chat'))).toBe(false);
		expect(replay.buffer('chat-1', firstLiveBatch)).toBe(true);
		expect(replay.buffer('chat-1', secondLiveBatch)).toBe(true);
		expect(applied).toEqual([{ chatId: 'chat-1', batch: replayPage }]);

		expect(replay.finish(token, 'chat-1')).toBe('applied');
		expect(applied).toEqual([
			{ chatId: 'chat-1', batch: replayPage },
			{ chatId: 'chat-1', batch: firstLiveBatch },
			{ chatId: 'chat-1', batch: secondLiveBatch },
		]);
		expect(replay.finish(token, 'chat-1')).toBe('stale');
	});

	it('does not re-buffer a replay page while applying it', () => {
		const applied: TranscriptBufferedBatch[] = [];
		let replay!: TranscriptReconnectReplayState;
		replay = new TranscriptReconnectReplayState((_chatId, appliedBatch) => {
			expect(replay.buffer('chat-1', appliedBatch)).toBe(false);
			applied.push(appliedBatch);
			return 'applied';
		});
		const replayPage = batch(1, 'replay-page');
		const token = replay.begin('chat-1', 'view-1');

		expect(replay.applyPage(token, 'chat-1', replayPage)).toBe('applied');
		expect(replay.finish(token, 'chat-1')).toBe('applied');
		expect(applied).toEqual([replayPage]);
	});

	it('lets a newer replay supersede buffered work without accepting stale controls', () => {
		const applied: TranscriptBufferedBatch[] = [];
		const replay = new TranscriptReconnectReplayState((_chatId, appliedBatch) => {
			applied.push(appliedBatch);
			return 'applied';
		});
		const firstToken = replay.begin('chat-1', 'view-1');
		const discardedBatch = batch(2, 'discarded');
		expect(replay.buffer('chat-1', discardedBatch)).toBe(true);

		const secondToken = replay.begin('chat-1', 'view-2');
		const retainedBatch = batch(1, 'retained', { transcriptViewId: 'view-2' });
		expect(replay.applyPage(firstToken, 'chat-1', batch(1, 'stale-page'))).toBe('stale');
		expect(replay.applyPage(secondToken, 'chat-2', retainedBatch)).toBe('stale');
		expect(replay.applyPage(secondToken, 'chat-1', batch(1, 'wrong-view'))).toBe('stale');
		replay.abort(firstToken);
		expect(replay.buffer('chat-1', retainedBatch)).toBe(true);

		expect(replay.finish(secondToken, 'chat-1')).toBe('applied');
		expect(applied).toEqual([retainedBatch]);

		const abortedToken = replay.begin('chat-1', 'view-2');
		expect(replay.buffer('chat-1', batch(2, 'aborted', { transcriptViewId: 'view-2' }))).toBe(true);
		replay.abort(abortedToken);
		expect(replay.finish(abortedToken, 'chat-1')).toBe('stale');
		expect(replay.buffer('chat-1', batch(2, 'ordinary', { transcriptViewId: 'view-2' }))).toBe(
			false,
		);
	});

	it.each(['gap-detected', 'view-changed'] as const)(
		'stops draining after a buffered batch reports %s and releases replay ownership',
		(failure) => {
			const applied: TranscriptBufferedBatch[] = [];
			const failingBatch = batch(3, 'failure');
			const replay = new TranscriptReconnectReplayState((_chatId, appliedBatch) => {
				applied.push(appliedBatch);
				const result: TranscriptReplayApplyResult =
					appliedBatch === failingBatch ? failure : 'applied';
				return result;
			});
			const token = replay.begin('chat-1', 'view-1');
			const firstBatch = batch(2, 'first');
			const skippedBatch = batch(4, 'skipped');
			expect(replay.buffer('chat-1', firstBatch)).toBe(true);
			expect(replay.buffer('chat-1', failingBatch)).toBe(true);
			expect(replay.buffer('chat-1', skippedBatch)).toBe(true);

			expect(replay.finish(token, 'chat-1')).toBe(failure);
			expect(applied).toEqual([firstBatch, failingBatch]);
			expect(replay.buffer('chat-1', batch(5, 'after-failure'))).toBe(false);
			expect(replay.finish(token, 'chat-1')).toBe('stale');
		},
	);

	it('drops buffered work when the owning transcript state resets', () => {
		const applied: TranscriptBufferedBatch[] = [];
		const replay = new TranscriptReconnectReplayState((_chatId, appliedBatch) => {
			applied.push(appliedBatch);
			return 'applied';
		});
		const token = replay.begin('chat-1', 'view-1');
		expect(replay.buffer('chat-1', batch(2, 'discarded'))).toBe(true);

		replay.reset();

		expect(replay.finish(token, 'chat-1')).toBe('stale');
		expect(applied).toEqual([]);
		expect(replay.buffer('chat-1', batch(3, 'ordinary'))).toBe(false);
	});
});
