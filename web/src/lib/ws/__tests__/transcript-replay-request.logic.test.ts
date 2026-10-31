import { describe, expect, it, vi } from 'vitest';
import { ChatSubscribedMessage } from '$shared/ws-events';
import {
	requestTranscriptReplayPage,
	type TranscriptReplaySocket,
} from '../transcript-replay-request.js';

function subscribed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: 'chat-subscribed',
		clientRequestId: 'request-1',
		chatId: 'chat-1',
		transcriptViewId: 'view-1',
		messages: [],
		firstOrdinal: 11,
		lastOrdinal: 10,
		nextAfterOrdinal: 10,
		throughOrdinal: 10,
		hasMore: false,
		resendCandidates: [],
		transientFeed: {
			serverInstanceId: 'server-instance-test',
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			transientRevision: 0,
			rows: [],
		},
		...overrides,
	};
}

function socket(response: Record<string, unknown>) {
	return {
		sendRequest: vi.fn<TranscriptReplaySocket['sendRequest']>(async () => response),
	} satisfies TranscriptReplaySocket;
}

describe('transcript replay request', () => {
	it('sends an activation purpose only on a first page', async () => {
		const activation = socket(subscribed());
		await expect(
			requestTranscriptReplayPage(activation, {
				chatId: 'chat-1',
				transcriptViewId: 'view-1',
				afterOrdinal: 10,
				purpose: 'activation',
			}),
		).resolves.toBeInstanceOf(ChatSubscribedMessage);
		expect(activation.sendRequest).toHaveBeenCalledExactlyOnceWith({
			type: 'chat-subscribe',
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			afterOrdinal: 10,
			purpose: 'activation',
		});

		const continuation = socket(subscribed());
		await requestTranscriptReplayPage(continuation, {
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			afterOrdinal: 10,
			throughOrdinal: 10,
		});
		expect(continuation.sendRequest).toHaveBeenCalledExactlyOnceWith({
			type: 'chat-subscribe',
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			afterOrdinal: 10,
			throughOrdinal: 10,
		});
	});

	it.each([
		['another chat', { chatId: 'chat-2' }, 10, undefined],
		['another view', { transcriptViewId: 'view-2' }, 10, undefined],
		['a page that skips past the cursor', { firstOrdinal: 12 }, 10, undefined],
		['a changed continuation watermark', {}, 10, 20],
	])('rejects %s before any caller can apply it', async (_label, overrides, afterOrdinal, throughOrdinal) => {
		await expect(
			requestTranscriptReplayPage(socket(subscribed(overrides)), {
				chatId: 'chat-1',
				transcriptViewId: 'view-1',
				afterOrdinal,
				...(throughOrdinal === undefined ? {} : { throughOrdinal }),
			}),
		).rejects.toThrow();
	});
});
