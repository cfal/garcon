import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { displayOpen, displayRow, mockDisplayApi } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import { ConversationFeedProjectionState } from '../ConversationFeedProjectionState.svelte.js';

const transcripts: ActiveTranscriptState[] = [];
afterEach(() => {
	for (const transcript of transcripts.splice(0)) transcript.dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function setup() {
	vi.useFakeTimers();
	const rows = Array.from({ length: 100 }, (_, index) => displayRow(index + 1));
	const api = mockDisplayApi(rows, displayOpen('chat-1', 'view-1', 100));
	const transcript = new ActiveTranscriptState();
	transcripts.push(transcript);
	await transcript.loadMessages('chat-1');
	const projection = new ConversationFeedProjectionState();
	const reconcile = () => projection.reconcile({
		surfaceIdentity: 'surface-1',
		display: transcript.display,
		renderModel: transcript.renderModel,
		overlays: transcript.overlayRows,
		optimisticAfterOrdinals: transcript.optimisticAfterOrdinals,
		mutationClock: transcript.feedMutationClock,
		isLiveWindow: !transcript.hasLaterMessages,
		showRefreshError: false,
		earlierBoundary: transcript.hasEarlierMessages ? 'visible' : 'hidden',
		showLaterBoundary: transcript.hasLaterMessages,
		reserveComposerCapSpace: false,
		transcriptViewId: transcript.transcriptViewId,
		pendingPermissions: [],
	});
	return { rows, api, transcript, reconcile };
}

describe('live display following', () => {
	it('follows each admitted newest window without presenting source lag as history', async () => {
		const { rows, api, transcript, reconcile } = await setup();
		reconcile();
		transcript.observeHead('view-1', 101);
		expect(transcript.loadedThroughOrdinal).toBe(100);
		expect(transcript.hasLaterMessages).toBe(false);
		expect(reconcile().geometry.endBehavior).toBe('restore-if-pinned');

		api.replace([...rows, displayRow(101)]);
		const read = api.window.getMockImplementation()!;
		const captured = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		api.window.mockImplementationOnce(async (...args) => {
			const response = await read(...args);
			captured.resolve();
			await released.promise;
			return response;
		});
		const refresh = transcript.controller.refresh();
		try {
			await captured.promise;
			transcript.observeHead('view-1', 102);
			reconcile();
			released.resolve();
			await refresh;
			expect(transcript.loadedThroughOrdinal).toBe(101);
			expect(transcript.lastOrdinal).toBe(102);
			expect(transcript.hasLaterMessages).toBe(false);
			expect(reconcile().geometry.endBehavior).toBe('restore-if-pinned');

			api.replace([...rows, displayRow(101), displayRow(102)]);
			await vi.advanceTimersByTimeAsync(250);
			expect(transcript.loadedThroughOrdinal).toBe(102);
			expect(transcript.hasLaterMessages).toBe(false);
			expect(reconcile().geometry.endBehavior).toBe('restore-if-pinned');
		} finally {
			released.resolve();
			await refresh;
		}
	});

	it('keeps real historical continuation pageable without following appends', async () => {
		const { rows, api, transcript, reconcile } = await setup();
		reconcile();
		await transcript.navigateToRow({ chatId: 'chat-1', transcriptViewId: 'view-1', ordinal: 20 },
			new AbortController().signal, () => true);
		reconcile();
		expect(transcript.hasLaterMessages).toBe(true);
		transcript.observeHead('view-1', 101);
		expect(reconcile().geometry.endBehavior).toBe('preserve-reading-position');
		api.replace([...rows, displayRow(101)]);
		await transcript.controller.refresh();
		expect(transcript.hasLaterMessages).toBe(true);
		expect(transcript.isUserScrolledUp).toBe(true);
		expect(reconcile().geometry.endBehavior).toBe('preserve-reading-position');
		expect(await transcript.loadLaterPage('chat-1')).toBe('loaded');
		expect(api.window.mock.calls.at(-1)?.[0].anchor.kind).toBe('after');
	});
});
