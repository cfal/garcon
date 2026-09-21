import { describe, expect, it } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import { ActiveTranscriptState } from '../active-transcript-state.svelte.js';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte.js';
import { InactiveTranscriptWindowStore } from '../inactive-transcript-window-store.js';

function transcript(chatId: string, content = 'message'): ActiveTranscriptState {
	const cache = new ChatTranscriptCache({ limit: 2, persistenceDelayMs: 60_000 });
	const window = new ActiveTranscriptState(cache);
	const messages: TranscriptMessage[] = [
		{ ordinal: 1, message: new AssistantMessage('2026-08-30T00:00:00.000Z', content) },
		{ ordinal: 2, message: new AssistantMessage('2026-08-30T00:00:00.000Z', content) },
	];
	window.replaceGeneration(chatId, 'view-1', messages, {
		lastOrdinal: 2,
		pageOldestOrdinal: 1,
		nextBeforeOrdinal: null,
		hasMore: false,
	});
	return window;
}

function park(
	store: InactiveTranscriptWindowStore,
	surfaceId: string,
	chatId: string,
	window = transcript(chatId),
): void {
	store.park({ surfaceId, chatId, transcript: window, target: { kind: 'end' } });
}

describe('InactiveTranscriptWindowStore', () => {
	it('evicts whole least-recently-parked windows', () => {
		const store = new InactiveTranscriptWindowStore({ windows: 2, messages: 10, bytes: 100_000 });
		park(store, 'left', 'chat-1');
		park(store, 'left', 'chat-2');
		park(store, 'left', 'chat-3');
		expect(store.take('left', 'chat-1')).toBeNull();
		expect(store.take('left', 'chat-2')).not.toBeNull();
		expect(store.take('left', 'chat-3')).not.toBeNull();
	});

	it('keeps different surfaces of one chat independent', () => {
		const store = new InactiveTranscriptWindowStore();
		const left = transcript('chat-1');
		const right = transcript('chat-1');
		park(store, 'left', 'chat-1', left);
		park(store, 'right', 'chat-1', right);
		expect(store.take('left', 'chat-1')?.transcript).toBe(left);
		expect(store.take('right', 'chat-1')?.transcript).toBe(right);
	});

	it('rejects oversized and stale windows rather than truncating their context', () => {
		const store = new InactiveTranscriptWindowStore({ windows: 2, messages: 10, bytes: 1_000 });
		park(store, 'left', 'chat-1', transcript('chat-1', 'x'.repeat(1_000)));
		expect(store.size).toBe(0);
		const current = transcript('chat-2');
		park(store, 'left', 'chat-2', current);
		current.transcriptCache.markStale('chat-2');
		expect(store.take('left', 'chat-2')).toBeNull();
	});

	it('evicts an inactive window that grows past the aggregate message limit', () => {
		const store = new InactiveTranscriptWindowStore({ windows: 2, messages: 2, bytes: 100_000 });
		const window = transcript('chat-1');
		park(store, 'left', 'chat-1', window);
		const incoming: TranscriptMessage = {
			ordinal: 3,
			message: new AssistantMessage('2026-08-30T00:00:00.000Z', 'third'),
		};
		const outcome = window.transcriptCache.applyMessages('chat-1', 'view-1', {
			firstOrdinal: 3,
			lastOrdinal: 3,
			messages: [incoming],
		});
		if (outcome.status !== 'applied') throw new Error('Expected a committed append');
		store.applySharedCommit({
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			messages: [incoming],
			firstOrdinal: 3,
			lastOrdinal: 3,
			resendCandidates: [],
			noticeRevision: 0,
			outcome,
			overlayMutation: { feedStructureChanged: false },
		}, { feedStructureChanged: false });
		expect(store.size).toBe(0);
	});

	it('recalculates retained bytes when a commit restores a different cache window', () => {
		const store = new InactiveTranscriptWindowStore({ windows: 2, messages: 10, bytes: 2_000 });
		const window = transcript('chat-1');
		park(store, 'left', 'chat-1', window);
		const largeMessages: TranscriptMessage[] = [1, 2, 3].map((ordinal) => ({
			ordinal,
			message: new AssistantMessage('2026-08-30T00:00:00.000Z', 'x'.repeat(1_000)),
		}));
		window.transcriptCache.replace('chat-1', 'view-1', largeMessages, 3, null);
		const incoming: TranscriptMessage = {
			ordinal: 4,
			message: new AssistantMessage('2026-08-30T00:00:00.000Z', 'x'.repeat(1_000)),
		};
		const outcome = window.transcriptCache.applyMessages('chat-1', 'view-1', {
			firstOrdinal: 4,
			lastOrdinal: 4,
			messages: [incoming],
		});
		if (outcome.status !== 'applied') throw new Error('Expected a committed append');

		store.applySharedCommit({
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			messages: [incoming],
			firstOrdinal: 4,
			lastOrdinal: 4,
			resendCandidates: [],
			noticeRevision: 0,
			outcome,
			overlayMutation: { feedStructureChanged: false },
		}, { feedStructureChanged: false });

		expect(window.loadedThroughOrdinal).toBe(4);
		expect(window.hasLaterMessages).toBe(false);
		expect(store.size).toBe(0);
	});
});
